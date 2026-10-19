import { useState } from "react";
import type { MethodMap } from "../src/api";
import type { JobStatus } from "../src/contracts";
import { jobStatusNames } from "../src/task-progress";
import { Button } from "./ui";

export function PixivJobsList({ jobs, loading, status, artworkId, offset, busy, onStatus, onSearch, onOffset, onRetry }: {
  jobs: MethodMap["jobs.list"]["result"] | null; loading: boolean; status: JobStatus | ""; artworkId: string; offset: number; busy: boolean;
  onStatus: (status: JobStatus | "") => void; onSearch: (value: string) => void; onOffset: (offset: number) => void; onRetry: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const total = jobs?.total ?? 0;
  const globalTotal = jobs?.allTotal ?? 0;
  const page = Math.floor(offset / 30) + 1;
  const pages = Math.max(1, Math.ceil(total / 30));
  const toggle = (id: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <section className="if-pixiv-jobs" aria-label="作品任务列表" aria-busy={loading}>
    <div className="if-jobs-heading"><h2>作品任务</h2><span>全队列 {globalTotal.toLocaleString()} 项</span></div>
    <div className="if-jobs-toolbar">
      <label>状态<select className="if-select" aria-label="筛选作品任务状态" value={status} onChange={event => onStatus(event.target.value as JobStatus | "")}><option value="">全部状态</option>{Object.entries(jobStatusNames).map(([value, label]) => <option key={value} value={value}>{label}（{jobs?.counts.find(row => row.status === value)?.count.toLocaleString() ?? "0"}）</option>)}</select></label>
      <label>作品 ID<input className="if-input" aria-label="检索作品 ID" placeholder="输入 ID 前缀" inputMode="numeric" value={artworkId} onChange={event => onSearch(event.target.value.replace(/\D/g, "").slice(0, 12))} /></label>
      {(status || artworkId) && <Button onClick={() => { onStatus(""); onSearch(""); }}>清除筛选</Button>}
    </div>
    <div className="if-jobs-count" role="status">{loading ? "正在读取任务…" : `筛选结果 ${total.toLocaleString()} 项${total ? ` · 显示 ${(offset + 1).toLocaleString()}–${Math.min(offset + (jobs?.items.length ?? 0), total).toLocaleString()}` : ""}`}</div>
    <div className="if-jobs-rows">
      {!jobs && !loading && <p className="if-jobs-empty">尚未读取到任务数据。</p>}
      {!loading && jobs && !jobs.items.length && <p className="if-jobs-empty">{globalTotal ? "没有符合当前筛选的作品任务。" : "尚无作品任务，可手动添加编号或按目录批量补全。"}</p>}
      {!loading && jobs?.items.map(job => <article className={`if-job-row is-${job.status}`} key={job.id}>
        {job.thumbnailUrl ? <img className="if-job-thumb" src={job.thumbnailUrl} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = "hidden"; }} /> : <div className="if-job-thumb if-job-placeholder" aria-hidden="true">图</div>}
        <div className="if-job-copy"><div className="if-job-title"><strong>{job.title || `作品 ${job.artworkId}`}</strong><span className="if-job-status">{jobStatusNames[job.status]}</span></div><p><span className="if-job-id">ID {job.artworkId}</span>{job.creatorName ? ` · ${job.creatorName}` : " · 暂无作者信息"} · 尝试 {job.attempts} 次</p>
          {job.lastError && <><button className="if-job-error-toggle" aria-expanded={expanded.has(job.id)} onClick={() => toggle(job.id)}>{expanded.has(job.id) ? "收起错误详情" : "错误详情"}</button>{expanded.has(job.id) && <p className="if-job-error">{job.lastError}</p>}</>}
          {job.status === "retry_wait" && <p className="if-job-wait">等待重试时间与来源冷却结束后自动处理。</p>}
        </div>
        {(["failed", "needs_login", "unavailable"] as JobStatus[]).includes(job.status) && <Button disabled={busy} aria-label={`重试作品 ${job.artworkId}`} onClick={() => onRetry(job.id)}>重试</Button>}
      </article>)}
    </div>
    <div className="if-jobs-pagination"><span>第 {Math.min(page, pages).toLocaleString()} / {pages.toLocaleString()} 页 · 每页 30 项</span><Button disabled={busy || loading || offset === 0} onClick={() => onOffset(Math.max(0, offset - 30))}>上一页</Button><Button disabled={busy || loading || offset + 30 >= total} onClick={() => onOffset(offset + 30)}>下一页</Button></div>
  </section>;
}
