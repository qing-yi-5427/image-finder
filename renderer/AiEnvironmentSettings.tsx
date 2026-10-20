import { useEffect, useRef, useState } from "react";
import { api } from "./client";
import type { MethodMap } from "../src/api";
import { Button, Modal } from "./ui";
type Notify = (text: string, undo?: () => void, kind?: "success" | "error") => void;
type Status = MethodMap["ai.status"]["result"];
type Environment = MethodMap["ai.environment"]["result"];
const size = (bytes: number | null) => bytes === null ? "暂时无法统计" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
export function AiEnvironmentSettings({ notify }: { notify: Notify }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [locationHint, setLocationHint] = useState("");
  const wasInstalling = useRef(false);
  const [confirm, setConfirm] = useState(false);
  const [general, setGeneral] = useState("0.55"), [character, setCharacter] = useState("0.85");
  const load = async () => {
    const [next, env] = await Promise.all([api.invoke("ai.status", {}), api.invoke("ai.environment", {})]);
    setStatus(next); setEnvironment(env); setFailure(""); return next;
  };
  useEffect(() => {
    let alive = true;
    void Promise.all([api.invoke("ai.status", {}), api.invoke("ai.environment", {})]).then(([next, env]) => { if (alive) { setStatus(next); setEnvironment(env); setGeneral(String(next.config.generalThreshold)); setCharacter(String(next.config.characterThreshold)); } }).catch(e => { if (alive) setFailure(String(e)); });
    let loading = false;
    const timer = setInterval(() => { if (loading) return; loading = true; void api.invoke("ai.status", {}).then(next => { if (alive) setStatus(next); }).catch(e => { if (alive) setFailure(String(e)); }).finally(() => { loading = false; }); }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (wasInstalling.current && !status?.install.running) void api.invoke("ai.environment", {}).then(setEnvironment).catch(e => setFailure(String(e)));
    wasInstalling.current = !!status?.install.running;
  }, [status?.install.running]);
  const act = async (action: () => Promise<unknown>) => { if (busy) return; setBusy(true); try { await action(); await load(); } catch (e) { const text = e instanceof Error ? e.message : String(e); setFailure(text); notify(text, undefined, "error"); } finally { setBusy(false); } };
  const active = !!status && (status.install.running || status.queues.some(queue => !!queue.counts.running || (!queue.paused && !!queue.counts.waiting)));
  const locked = busy || active || !!status?.maintenance;
  return <section className="if-settings-section if-ai-environment" aria-label="本地 AI 环境与配置">
    <div className="if-ai-heading"><h2>本地 AI 环境与配置</h2><Button disabled={busy} onClick={() => void act(load)}>刷新 AI 环境</Button></div>
    {failure && <p className="if-ai-error" role="alert">{failure}</p>}
    {!status || !environment ? <p role="status">正在读取 AI 环境…</p> : <>
      <p className="if-ai-hint" role="status">{status.install.running ? `正在安装：${status.install.stage}` : active ? "AI 任务正在运行" : status.maintenance ? "正在维护 AI 环境" : status.models.every(model => model.ready) ? "模型与环境已就绪" : "模型或环境尚未就绪"}</p>
      {environment.error && <p className="if-ai-error" role="alert">{environment.error}</p>}
      {status.install.error && <p className="if-ai-error" role="alert">{status.install.error}</p>}
      <div className="if-ai-model-summary">{status.models.map(model => <span key={model.kind}>{model.kind === "wd" ? "WD 标签" : "中文语义"} · {model.ready ? "已就绪" : "未就绪"}</span>)}</div>
<div className="if-ai-provider"><Button disabled={locked} onClick={() => void act(() => api.invoke("ai.install", {}))}>{status.install.running ? "正在安装…" : "安装或修复 AI 环境"}</Button></div>
      <form className="if-ai-config" onSubmit={e => { e.preventDefault(); void act(() => api.invoke("ai.configure", { generalThreshold: Number(general), characterThreshold: Number(character) })); }}>
        <label>一般标签分析阈值<input className="if-input" aria-label="一般标签分析阈值" type="number" min="0" max="1" step="0.01" value={general} onChange={e => setGeneral(e.target.value)} required /></label><label>角色分析阈值<input className="if-input" aria-label="角色分析阈值" type="number" min="0" max="1" step="0.01" value={character} onChange={e => setCharacter(e.target.value)} required /></label><Button type="submit" disabled={locked}>保存分析阈值</Button>
      </form>
      <div className="if-ai-provider"><span>推理设备：{status.config.provider === "cpu" ? "CPU" : "DirectML GPU"}</span><Button disabled={locked || status.config.provider === "cpu"} onClick={() => void act(() => api.invoke("ai.configure", { provider: "cpu" }))}>使用 CPU</Button><Button disabled={locked || status.config.provider === "directml"} onClick={() => void act(() => api.invoke("ai.configure", { provider: "directml" }))}>使用 DirectML GPU</Button></div>
      <p className="if-ai-hint">分析阈值与推理设备用于未来分析。分数不代表正确率；已启用目录的自动生效规则仍为一般标签 0.55、角色 0.85，已有结果不会因保存设置而隐式改写。环境路径由应用管理。</p>
      <details className="if-settings-disclosure"><summary>模型版本与环境详情</summary>
      <dl className="if-ai-environment-facts"><dt>环境目录</dt><dd>{environment.home}</dd><dt>推理程序</dt><dd>{status.python}</dd><dt>磁盘占用</dt><dd>{size(environment.bytes)}</dd><dt>管理方式</dt><dd>{environment.managed ? "应用管理的独立环境" : "随应用或外部配置管理"}</dd></dl>
      <div className="if-ai-environment-models">{status.models.map(model => <div key={model.kind}><strong>{model.kind === "wd" ? "WD 标签" : "中文语义"} · {model.ready ? "已就绪" : "未就绪"}</strong><p>{model.id} · {model.version}</p>{model.filesMissing.length > 0 && <p>缺少：{model.filesMissing.join("、")}</p>}</div>)}</div>
      <div className="if-ai-provider"><Button disabled={locked} onClick={() => void act(async () => {
        setMoving(true);
        try {
          const selected = await api.invoke("ai.environmentSelect", {});
          if (!selected) return;
          setLocationHint(`新位置已生效，旧环境仍保留在：${selected.previousDirectory}`);
          if (selected.warning) notify(`AI 环境位置已更新，请查看提示：${selected.warning}`, undefined, "error");
          else notify("AI 环境位置已更新，旧环境已保留");
        } finally { setMoving(false); }
      })}>{moving ? "正在复制与校验…" : "选择 AI 环境位置"}</Button></div>
      <p className="if-ai-hint">在所选位置创建独立隐藏的 .image-finder-ai 文件夹，复制并校验当前环境后立即切换；旧环境保留，图库与原图位置不变。安装或分析运行时不能切换。</p>
      {locationHint && <p className="if-ai-hint" role="status">{locationHint}</p>}
      </details>
      <details className="if-settings-disclosure"><summary>清理 AI 环境与模型</summary>
      <p className="if-ai-hint">{environment.cleanupSupported ? "清理仅移除独立运行环境与模型，之后可重新安装。安装、分析或语义搜索运行时不可清理。" : "此环境随应用或外部配置管理，不支持在此清理；请通过对应安装或目录管理方式处理。"}</p>
<div className="if-ai-provider"><Button variant="danger" disabled={locked || !environment.cleanupSupported} onClick={() => setConfirm(true)}>清理环境与模型</Button></div>
      </details>
    </>}
    {confirm && <Modal title="清理 AI 环境与模型？" onClose={() => { if (!busy) setConfirm(false); }} footer={<><Button disabled={busy} onClick={() => setConfirm(false)}>保留环境</Button><Button variant="danger" disabled={locked || !environment?.cleanupSupported} onClick={() => void act(async () => { const result = await api.invoke("ai.environmentClear", {}); setConfirm(false); notify(`已清理 ${size(result.clearedBytes)} AI 环境与模型`); })}>确认清理环境与模型</Button></>}>
      <p>将删除此独立目录中的 AI 运行环境与模型：{environment?.home}</p><p>预计释放 {size(environment?.bytes ?? null)}。之后分析和语义搜索需要重新安装环境。</p><p>图库索引、已生成标签、语义索引、人工整理数据及原图片全部保留。当前已有任务与进度不会被清空。</p>
    </Modal>}
  </section>;
}
