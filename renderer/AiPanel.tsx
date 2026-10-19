import { useEffect, useId, useRef, useState } from "react";
import { api } from "./client";
import { Button, Modal } from "./ui";
import type { Filter } from "../src/contracts";
import type { MethodMap } from "../src/api";
import "./AiPanel.css";
import { AiEnvironmentSettings } from "./AiEnvironmentSettings";
import { QueueProgress } from "./QueueProgress";

type Notify = (message: string, undo?: () => void, kind?: "success" | "error") => void;
type AiStatus = MethodMap["ai.status"]["result"];
type Candidates = MethodMap["ai.candidates"]["result"];
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const kindName = (kind: string) => kind === "wd" ? "WD 自动标签" : "中文描述语义索引";

export function AiTasksPanel({ notify, onlyKind }: { notify: Notify; onlyKind?: "wd" | "semantic" }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [general, setGeneral] = useState("0.55");
  const [character, setCharacter] = useState("0.85");
  const load = async () => {
    const result = await api.invoke("ai.status", {});
    setStatus(result);
    setError("");
    return result;
  };
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = await api.invoke("ai.status", {});
        if (alive) { setStatus(next); setError(""); }
      } catch (e) { if (alive) setError(message(e)); }
    };
    void api.invoke("ai.status", {}).then(next => {
      if (!alive) return;
      setStatus(next);
      setGeneral(String(next.config.generalThreshold));
      setCharacter(String(next.config.characterThreshold));
    }).catch(e => { if (alive) setError(message(e)); });
    const timer = setInterval(() => void poll(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); await load(); }
    catch (e) { notify(message(e), undefined, "error"); }
    finally { setBusy(false); }
  };
  return <section className="if-ai-tasks" aria-label="本地 AI 任务">
    <div className="if-ai-heading"><h2>{onlyKind === "wd" ? "WD 自动标签设置" : onlyKind === "semantic" ? "中文语义设置" : "本地 AI"}</h2><Button disabled={busy} onClick={() => void act(load)}>刷新状态</Button></div>
    <p className="if-ai-hint">队列默认暂停，已运行的队列会继续处理新任务。自动标签与语义索引分别处理，原图仅供读取。</p>
    {error && <p className="if-ai-error" role="alert">{error}</p>}
    {!status && !error && <p className="if-ai-hint" role="status">正在读取 WD 与中文语义任务…</p>}
    {status && <>
      {status.queues.filter(queue => !onlyKind || queue.kind === onlyKind).map(queue => {
        const model = status.models.find(m => m.kind === queue.kind);
        return <article className="if-task-group" key={queue.kind}>
          <div className="if-task-heading"><div className="if-task-title"><h2>{kindName(queue.kind)}</h2><p>{model?.ready ? "模型就绪" : "模型尚未就绪"} · {queue.paused ? "已暂停" : queue.activeFileId ? "正在处理" : "等待任务"}</p></div>
            <Button disabled={busy || (!queue.paused ? false : !model?.ready)} onClick={() => void act(() => api.invoke(queue.paused ? "ai.resume" : "ai.pause", { kind: queue.kind }))}>{queue.paused ? "继续" : "暂停"}</Button>
            <Button disabled={busy || !queue.counts.failed} onClick={() => void act(() => api.invoke("ai.retry", { kind: queue.kind }))}>重试失败</Button>
          </div>
          <div className="if-task-body"><QueueProgress counts={queue.counts} label={queue.kind === "wd" ? "WD 自动标签" : "中文语义索引"} state={queue.paused ? "已暂停" : queue.activeFileId || queue.counts.running ? "正在处理" : queue.counts.waiting ? "等待处理" : "空闲"} /><p className="if-ai-hint">有效结果覆盖 {queue.indexed.toLocaleString()} / {queue.total.toLocaleString()} 张图库图片 · 已过期 {queue.stale.toLocaleString()}（覆盖率与队列进度分别统计）</p>
            {queue.lastError && <p className="if-ai-error" role="alert">{queue.lastError}</p>}
            <details className="if-ai-model-detail"><summary>模型详情{!model?.ready ? " · 尚未就绪" : ""}</summary><p className="if-ai-hint">{model?.id} · {model?.version} · {model?.license}</p>{!!model?.filesMissing.length && <p className="if-ai-hint">缺少：{model.filesMissing.join("、")}</p>}</details>
          </div>
        </article>;
      })}
      {onlyKind !== "semantic" && <details className="if-ai-settings"><summary>模型安装与分析设置</summary><AiEnvironmentSettings notify={notify} /></details>}
    </>}
  </section>;
}

export function AiRunButton({ ids, filter, scopeLabel, notify }: { ids: string[]; filter: Filter; scopeLabel: string; notify: Notify }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"wd" | "semantic">("wd");
  const [range, setRange] = useState<"selected" | "missing" | "missing_source">("missing");
  const [busy, setBusy] = useState(false);
  return <>
    <Button aria-label="本地 AI 分析" onClick={() => { setRange(ids.length ? "selected" : "missing"); setOpen(true); }}>AI 分析</Button>
    {open && <Modal title="添加本地 AI 任务" onClose={() => !busy && setOpen(false)} footer={<Button variant="primary" disabled={busy || (range === "selected" && !ids.length)} onClick={() => {
      setBusy(true);
      void api.invoke("ai.enqueue", { kind, ...(range === "selected" ? { fileIds: [...ids], scope: "all" as const } : { filter, scope: range }) }).then(result => {
        const paused = result.status.queues.find(queue => queue.kind === kind)?.paused;
        notify(`已添加 ${result.enqueued} 张${kind === "wd" ? "自动标签" : "语义索引"}任务；${paused ? "在后台任务中继续处理。" : "正在运行的队列会继续处理。"}`);
        setOpen(false);
      }).catch(e => notify(message(e), undefined, "error")).finally(() => setBusy(false));
    }}>{busy ? "添加中…" : "添加到队列"}</Button>}>
      <div className="if-ai-run-options">
        <fieldset><legend>任务</legend>{(["wd", "semantic"] as const).map(value => <label key={value}><input type="radio" name="ai-kind" checked={kind === value} onChange={() => { setKind(value); if (value === "semantic" && range === "missing_source") setRange("missing"); }} />{kindName(value)}</label>)}</fieldset>
        <fieldset><legend>处理范围</legend>
          <label><input type="radio" name="ai-range" checked={range === "selected"} disabled={!ids.length} onChange={() => setRange("selected")} />当前选中 {ids.length} 张（重新分析）</label>
          <label><input type="radio" name="ai-range" checked={range === "missing"} onChange={() => setRange("missing")} />当前范围中缺少有效 AI 结果的图片</label>
          {kind === "wd" && <label><input type="radio" name="ai-range" checked={range === "missing_source"} onChange={() => setRange("missing_source")} />当前范围中缺少来源标签的图片</label>}
        </fieldset>
        <p className="if-ai-hint">当前范围：{scopeLabel}。保留当前目录和结构化筛选条件。已运行的队列会继续处理新任务；已接受或排除的标签在重跑后仍保留。</p>
      </div>
    </Modal>}
  </>;
}

export function AiReview({ fileId, notify, onChanged, reviewIds }: { fileId: string; notify: Notify; onChanged?: () => void; reviewIds?: string[] }) {
  const detailId=useId();
  const [result, setResult] = useState<Candidates | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ tag: string; name: string } | null>(null);
  const [batch, setBatch] = useState(false);
  const [expandedTag, setExpandedTag] = useState<string | null>(null);
  const alive = useRef(true);
  const currentId = useRef(fileId);
  const generation = useRef(0);
  const operation = useRef<{ fileId: string; generation: number } | null>(null);
  if (currentId.current !== fileId) { currentId.current = fileId; generation.current++; }
  const isCurrent = (id: string, token: number) => alive.current && currentId.current === id && generation.current === token;
  const friendlyError = (e: unknown) => {
    const text = message(e);
    if (text.includes("AI_WD_BUSY")) return "另一张图片正在进行 WD 识别，请等待完成后再识别当前图片。";
    if (text.includes("AI_INPUT_CHANGED")) return "原图片已变化或不可用，请重新扫描目录后重试。";
    return text;
  };
  const targetIds = batch && reviewIds?.length ? reviewIds : [fileId];
  const load = async (id: string, token: number) => { const next = await api.invoke("ai.candidates", { fileId: id }); if (isCurrent(id, token)) setResult(next); return next; };
  useEffect(() => {
    const token = generation.current;
    let mounted = true;
    setResult(null); setError(""); setEdit(null); setBusy(false); setBatch(false); setExpandedTag(null);
    void api.invoke("ai.candidates", { fileId }).then(next => { if (mounted && isCurrent(fileId, token)) setResult(next); }).catch(e => { if (mounted && isCurrent(fileId, token)) setError(friendlyError(e)); });
    return () => { mounted = false; };
  }, [fileId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (result?.job?.status !== "running") return;
    const id = fileId, token = generation.current;
    const timer = setInterval(() => void load(id, token).catch(e => { if (isCurrent(id, token)) setError(friendlyError(e)); }), 1000);
    return () => clearInterval(timer);
  }, [fileId, result?.job?.status]);
  const act = async (action: () => Promise<unknown>) => {
    const id = fileId, token = generation.current;
    if (operation.current?.fileId === id && operation.current.generation === token) return;
    const own = { fileId: id, generation: token };
    operation.current = own;
    setBusy(true);
    setError("");
    try { await action(); if (isCurrent(id, token)) { await load(id, token); if (isCurrent(id, token)) onChanged?.(); } }
    catch (e) { if (isCurrent(id, token)) { setError(friendlyError(e)); notify(friendlyError(e), undefined, "error"); } }
    finally { if (operation.current === own) operation.current = null; if (isCurrent(id, token)) setBusy(false); }
  };
  const runCurrent = () => act(async () => {
    const token = generation.current;
    const next = await api.invoke("ai.runCurrent", { fileId });
    if (!isCurrent(fileId, token)) return;
    setResult(next.candidates);
    if (next.status === "failed") throw new Error(next.error ?? "当前图片识别失败，请重试。");
    notify("当前图片识别完成，候选已更新。未更改后台队列的暂停设置。");
  });
  const running = busy || result?.job?.status === "running";
  const lastError = error || (result?.job?.status === "failed" ? friendlyError(result.job.lastError ?? "当前图片识别失败，请重试。") : "");
  return <section className="if-info-section if-ai-review" aria-label="AI 识别候选" onKeyDown={event=>{if((event.key==="Enter"||event.key===" ")&&(event.target as HTMLElement).closest("button,summary"))event.stopPropagation();}}>
    <h3>AI 识别</h3>
    <Button disabled={running || !result} aria-label={result?.run ? "重新识别当前图片" : "识别当前图片"} onClick={() => void runCurrent()}>{running ? "正在识别当前图片…" : result?.run ? "重新识别当前图片" : "识别当前图片"}</Button>
    <p className="if-info-hint">仅处理当前图片，不启动后台待办。人工接受和排除的结果会保留，排除优先于自动生效。</p>
    {(reviewIds?.length ?? 0) > 1 && <label className="if-ai-hint"><input type="checkbox" checked={batch} onChange={e => setBatch(e.target.checked)} /> 批量审核当前选中的 {reviewIds!.length} 张图片</label>}
    {lastError && <p className="if-ai-error" role="alert">{lastError}</p>}
    {/模型|AI_MODEL_MISSING/.test(lastError) && <p className="if-info-hint">请打开后台任务，安装本地模型与运行环境后重试。安装完成不会自动分析图库。</p>}
    {!result?.run ? <p className="if-info-hint">{result ? "尚未识别，可直接识别当前图片。" : "正在读取识别状态…"}</p> : <>
      <details className="if-ai-summary"><summary>WD 推测 · 通用 ≥0.55 / 角色 ≥0.85</summary>
        <p className="if-info-hint">分数不是正确率。达到规则的标签自动生效，人工排除优先。点击标签可查看原始信息与操作。</p>
        <p className="if-info-hint">模型：{result.run.modelId}<br />分析时间：{new Date(result.run.createdAt).toLocaleString()}</p>
      </details>
      <div className="if-ai-candidates">{result.candidates.map(candidate => <button type="button" className={`if-ai-tag ${candidate.review} ${candidate.effective ? "effective" : "inactive"}`} key={candidate.tag}
        aria-label={`AI 标签 ${candidate.displayName}，分数 ${candidate.score.toFixed(2)}，${candidate.review === "excluded" ? "已排除" : candidate.effective ? "已生效" : "未生效"}`}
        aria-expanded={expandedTag === candidate.tag} aria-controls={detailId} onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")event.stopPropagation();}} onClick={() => setExpandedTag(expandedTag === candidate.tag ? null : candidate.tag)}>
        <span>{candidate.displayName}</span><small>{candidate.score.toFixed(2)}</small>{candidate.review === "excluded" ? <em>已排除</em> : !candidate.effective ? <em>未生效</em> : null}
      </button>)}</div>
      {(() => { const candidate = result.candidates.find(c => c.tag === expandedTag); return candidate && <div id={detailId} className="if-ai-tag-detail" role="region" aria-label={`标签详情 ${candidate.tag}`}>
        <div className="if-ai-tag-detail-heading"><strong>{candidate.displayName}</strong><button type="button" aria-label="收起标签详情" onClick={() => setExpandedTag(null)}>×</button></div>
        <p>{candidate.tag} · 原始分数 {candidate.score.toFixed(3)}<br />{candidate.category === "character" ? "角色" : candidate.category === "rating" ? "内容等级" : "通用"} · {candidate.review === "excluded" ? "已排除" : candidate.automatic && candidate.effective ? "WD 推测 · 已生效" : candidate.review === "accepted" ? "已接受" : "未生效"}</p>
        <div className="if-ai-candidate-actions">
          {(!candidate.automatic && (batch || candidate.review !== "accepted")) && <Button disabled={busy} aria-label={`接受 AI 标签 ${candidate.tag}`} onClick={() => void act(() => api.invoke("ai.review", { fileIds: targetIds, tag: candidate.tag, action: "accept" }))}>接受</Button>}
          <Button disabled={busy} aria-label={`${candidate.review === "excluded" ? "恢复" : "排除"} AI 标签 ${candidate.tag}`} onClick={() => void act(() => api.invoke("ai.review", { fileIds: targetIds, tag: candidate.tag, action: candidate.review === "excluded" ? "restore" : "exclude" }))}>{candidate.review === "excluded" ? "恢复" : "排除"}</Button>
          <Button disabled={busy} aria-label={`校正 AI 译名 ${candidate.tag}`} onClick={() => setEdit({ tag: candidate.tag, name: candidate.displayName })}>译名</Button>
        </div>
      </div>; })()}
      {!result.candidates.length && <p className="if-info-hint">没有超过当前阈值的候选。</p>}
    </>}
    {edit && <Modal title="校正 AI 标签译名" onClose={() => setEdit(null)} footer={<Button disabled={busy || !edit.name.trim()} onClick={() => { const id = fileId, token = generation.current; void act(async () => { await api.invoke("ai.translate", { tag: edit.tag, displayName: edit.name.trim() }); if (isCurrent(id, token)) setEdit(null); }); }}>保存译名</Button>}>
      <p className="if-ai-hint">英文标识：{edit.tag}。译名显示和检索全局生效；不会合并角色身份。</p>
      <input className="if-input" aria-label="AI 标签中文译名" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} maxLength={200} />
    </Modal>}
  </section>;
}
