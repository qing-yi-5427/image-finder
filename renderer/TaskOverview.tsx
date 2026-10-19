import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./client";
import type { MethodMap } from "../src/api";
import type { LibraryRoot } from "../src/contracts";
import { Button, Modal } from "./ui";
import { DirectoryTree, directorySection } from "./DirectoryTree";

type Overview = MethodMap["tasks.overview"]["result"];
type Scope = { rootId: string; relativePath: string; recursive: boolean };
const statuses: Record<string, string> = { waiting: "等待", running: "处理中", completed: "已完成", succeeded: "成功", failed: "失败", no_match: "无匹配", unavailable: "来源不可用", cancelled: "已取消", ready: "已就绪", pending: "待处理", needs_login: "需要登录", paused: "已暂停", skipped: "已跳过", done: "已完成", error: "失败", review: "待确认", confirmed: "已确认", rejected: "已拒绝", blocked: "受限", missing: "缺失", stale: "已过期", retry: "待重试" };
const reasonLabel = (reason: string) => {
  const known: Record<string, string> = { user: "已手动暂停", not_started: "尚未开始", batch_rest: "批次休息中，到时自动继续", shutdown: "上次退出时已暂停，请手动继续", restart: "重新打开后已暂停，请手动继续", completed: "当前队列已完成", cancelled: "当前任务已取消", ambiguous_or_invalid_match: "匹配结果存在歧义或无效，已暂停检查", no_source: "尚无可用来源", retry_wait: "等待重试" };
  if (known[reason]) return known[reason];
  if (/403|429|rate|limit|quota|access_restricted/.test(reason)) return "服务限制请求或访问，已暂停；请等待后再继续";
  if (/needs_login|challenge/.test(reason)) return "登录或安全验证需要确认，已暂停";
  if (/key|config/.test(reason)) return "请先在设置中检查来源配置";
  return reason;
};
const pct = (n: number, total: number) => total ? `${Math.min(100, n / total * 100).toFixed(1)}%` : "0%";
export function TaskOverview({ controls, notify }: { controls: Record<string, ReactNode>; notify: (message: string, undo?: () => void, kind?: "success" | "error") => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [scope, setScope] = useState<Scope | null | undefined>(undefined);
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [failure, setFailure] = useState("");
  const version = useRef(0);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [sauceConsent, setSauceConsent] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Overview["cards"][number] | null>(null);
  const cancelTasks = async () => {
    if (!cancelTarget || busyKind) return;
    const target = cancelTarget;
    const token = version.current;
    setBusyKind(target.kind);
    try {
      const result = await api.invoke("tasks.cancel", { kind: target.kind });
      setCancelTarget(null);
      notify(`已取消 ${target.label} 的 ${result.cancelled} 项任务；已完成数据保留`);
      const next = await api.invoke("tasks.overview", scope === undefined ? {} : { scope });
      if (version.current === token) setOverview(next);
    } catch (e) { notify(e instanceof Error ? e.message : String(e), undefined, "error"); }
    finally { setBusyKind(null); }
  };
  const action = async (card: Overview["cards"][number]) => {
    if (busyKind) return;
    setBusyKind(card.kind);
    const token = version.current;
    try {
      if (card.kind === "pixiv") {
        const jobs = await api.invoke("jobs.list", { offset: 0, limit: 1 });
        const resume = jobs.source.paused && jobs.source.reason !== "batch_rest";
        await api.invoke(resume ? "jobs.resume" : "jobs.pause", resume ? { nextBatch: jobs.source.batch_used >= jobs.source.batchLimit } : {});
      } else if (card.kind === "wd" || card.kind === "semantic") await api.invoke(card.paused ? "ai.resume" : "ai.pause", { kind: card.kind });
      else if (card.kind === "local") await api.invoke(card.paused ? "local.resume" : "local.pause", { kind: "images" });
      else if (card.kind === "danbooru") await api.invoke(card.paused ? "danbooru.resume" : "danbooru.pause", {});
      else await api.invoke(card.paused ? "sauce.resume" : "sauce.pause", {});
      const next = await api.invoke("tasks.overview", scope === undefined ? {} : { scope }); if (version.current === token) setOverview(next);
    } catch (e) { notify(e instanceof Error ? e.message : String(e), undefined, "error"); } finally { setBusyKind(null); }
  };
  useEffect(() => { void api.invoke("library.list", {}).then(setRoots).catch(e => setFailure(String(e))); }, []);
  useEffect(() => {
    let alive = true;
    const token = ++version.current;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try { const next = await api.invoke("tasks.overview", scope === undefined ? {} : { scope }); if (alive && token === version.current) { setOverview(next); setFailure(""); } }
      catch (e) { if (alive && token === version.current) setFailure(e instanceof Error ? e.message : String(e)); }
      finally { loading = false; }
    };
    setOverview(null); void load(); const timer = setInterval(() => void load(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [scope]);
  const viewed = scope === undefined ? overview?.scope : scope;
  const differs = !!overview && (overview.scope.rootId !== (overview.executionScope?.rootId ?? null) || overview.scope.relativePath !== (overview.executionScope?.relativePath ?? "") || (overview.scope.rootId !== null && overview.scope.recursive !== overview.executionScope?.recursive));
  return <>
    <section className="if-task-view-scope if-task-group" aria-label="任务统计查看范围">
      <h2>查看范围</h2>
      <div className="if-task-scope-actions"><Button onClick={() => setScope(undefined)}>当前运行目录</Button><Button onClick={() => setScope(null)}>全库</Button></div>
      <p role="status">{overview ? `${overview.scope.label} · ${overview.scope.total.toLocaleString()} 张图片` : "正在读取范围…"}</p>
      <p className="if-queue-note">此处只切换统计查看范围。Pixiv 执行范围：{overview?.executionScope ? `${overview.executionScope.relativePath || "图库根目录"}${overview.executionScope.recursive ? "（含子目录）" : "（不含子目录）"}` : "全库"}。</p>
      <p className="if-queue-note">继续会处理原队列，查看范围不会限制执行；其他任务会继续各自原有队列。</p>
      {differs && <p className="if-source-reason" role="status">查看范围与执行范围不同，切换查看不会扩大或缩小执行范围。</p>}
      <details><summary>选择目录查看统计</summary><DirectoryTree roots={roots} section={viewed?.rootId ? viewed.relativePath ? directorySection(viewed.rootId, viewed.relativePath) : `root:${viewed.rootId}` : ""} onSelect={section => { if (!section.startsWith("directory:") && !section.startsWith("root:")) return; const [rootId, relativePath] = section.startsWith("root:") ? [section.slice(5), ""] : JSON.parse(section.slice(10)) as [string, string]; setScope({ rootId, relativePath, recursive: viewed?.recursive ?? true }); }} /><label><input type="checkbox" checked={viewed?.recursive ?? true} disabled={!viewed?.rootId} onChange={e => { if (viewed?.rootId) setScope({ rootId: viewed.rootId, relativePath: viewed.relativePath, recursive: e.target.checked }); }} />包含子目录</label></details>
    </section>
    {failure && <p role="alert" className="if-task-load-error">统计读取失败：{failure}</p>}
    {!overview && !failure && <p role="status">正在读取各任务覆盖率与进度…</p>}
    <section className="if-task-overview-grid">{overview?.cards.map(card => <article className={`if-task-group if-task-overview-card if-task-card-${card.kind}`} key={card.kind} aria-label={card.label}>
      <div className="if-task-heading"><div className="if-task-title"><h2>{card.label}</h2></div><span className="if-utility-status"><i />{card.reason === "batch_rest" ? "批次休息中" : card.paused ? "已暂停" : "可运行"}</span></div>
      <div className="if-task-body">
        <div className="if-task-metric"><strong>{card.kind === "wd" ? "已有自动标签" : card.kind === "semantic" ? "已有语义索引" : "查看范围覆盖率"}</strong><span>{(card.kind === "wd" ? card.coverage.automaticTagged ?? 0 : card.coverage.covered).toLocaleString()} / {card.coverage.total.toLocaleString()} 张 · {pct(card.kind === "wd" ? card.coverage.automaticTagged ?? 0 : card.coverage.covered, card.coverage.total)}</span></div>
        <div className="if-utility-progress" role="progressbar" aria-label={`${card.label}覆盖率`} aria-valuemin={0} aria-valuemax={card.coverage.total || 1} aria-valuenow={card.kind === "wd" ? card.coverage.automaticTagged ?? 0 : card.coverage.covered}><span style={{width: pct(card.kind === "wd" ? card.coverage.automaticTagged ?? 0 : card.coverage.covered, card.coverage.total)}} /></div>
        {card.kind === "wd" && <p className="if-queue-note">已分析 {card.coverage.covered.toLocaleString()} / {card.coverage.total.toLocaleString()} 张</p>}
        <div className="if-task-metric"><strong>查看范围队列进度</strong><span>{card.progress.processed.toLocaleString()} / {card.progress.total.toLocaleString()} {card.progress.unit} · {pct(card.progress.processed, card.progress.total)}</span></div>
        <div className="if-utility-progress" role="progressbar" aria-label={`${card.label}队列进度`} aria-valuemin={0} aria-valuemax={card.progress.total || 1} aria-valuenow={card.progress.processed}><span style={{width: pct(card.progress.processed, card.progress.total)}} /></div>
        <p className="if-queue-note">{card.progress.counts.map(row => `${statuses[row.status] || row.status} ${row.count.toLocaleString()}`).join(" · ") || "尚无任务"}</p>
        {card.reason && <p className="if-source-reason">{reasonLabel(card.reason)}</p>}
        {card.kind === "sauce" && card.paused && <label className="if-queue-note if-task-sauce-consent"><input type="checkbox" checked={sauceConsent} onChange={e => setSauceConsent(e.target.checked)} />我同意继续后向 SauceNAO 上传原队列图片的压缩预览图。</label>}
        <div className="if-task-primary-action"><Button disabled={!!busyKind || (card.kind === "sauce" && card.paused && !sauceConsent)} onClick={() => void action(card)}>{busyKind === card.kind ? "处理中…" : card.kind === "pixiv" && card.reason === "batch_rest" ? "暂停自动继续" : card.paused ? card.kind === "local" ? "继续图片处理" : "继续原队列" : card.kind === "local" ? "暂停图片处理" : "暂停原队列"}</Button><Button disabled={!!busyKind || card.cancellable === 0} aria-label={`取消 ${card.label} 当前任务`} onClick={() => setCancelTarget(card)}>取消当前任务（{card.cancellable}）</Button><span className="if-queue-note">操作处理原队列，查看范围不限制执行。</span></div>
        <details className="if-task-owned-details"><summary>{{pixiv:"Pixiv",wd:"WD",semantic:"中文语义",danbooru:"Danbooru",sauce:"SauceNAO",local:"本地处理"}[card.kind]}任务详情 · 全队列</summary><p className="if-queue-note">以下为全队列操作与完整状态，继续会处理原队列，查看范围不会限制执行。</p>{controls[card.kind]}</details>
      </div>
    </article>)}</section>
    {cancelTarget && <Modal title={`取消 ${cancelTarget.label} 当前任务？`} onClose={() => { if (!busyKind) setCancelTarget(null); }} footer={<><Button disabled={!!busyKind} onClick={() => setCancelTarget(null)}>保留任务</Button><Button variant="danger" disabled={!!busyKind} onClick={() => void cancelTasks()}>{busyKind ? "正在取消…" : "确认取消全队列任务"}</Button></>}>
      <p>将取消此功能原全队列中的 {cancelTarget.cancellable} 项待执行或正在运行的任务，并暂停该队列。作用范围包含当前统计查看范围以外的任务。</p>
      {cancelTarget.kind === "local" && <p>本地处理同时取消当前扫描、排队扫描与待处理图片；普通继续不会重新处理这批任务，需显式重新扫描或重试。</p>}
      <p>正在处理的请求或分析会安全结束，取消完成前可能需要等待；这些未完成结果不会再导入。</p>
      <p>已完成的标签、来源信息、语义索引，以及人工标签、排除、译名等整理数据均保留；原图片不受影响。</p>
      <p>取消后，未完成任务需要重新加入队列；失败记录保留，仍可显式重试。此操作不会清除其他功能的任务。</p>
    </Modal>}

  </>;
}
