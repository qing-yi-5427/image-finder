import { taskProgress } from "../src/task-progress";

export function QueueProgress({ counts, label, state }: { counts: Record<string, number> | null; label: string; state: string }) {
  if (!counts) return <p className="if-queue-note" role="status">正在读取{label}任务…</p>;
  const progress = taskProgress(counts);
  return <div className="if-queue-progress" aria-label={`${label}队列进度`}>
    <div className="if-queue-progress-label"><strong>{progress.total ? `已处理 ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}` : "尚无任务"}</strong><span>{state}{progress.percent !== null ? ` · ${progress.percent.toFixed(1)}%` : ""}</span></div>
    {progress.percent !== null && <div className="if-queue-track" role="progressbar" aria-label={`${label}已处理比例`} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.processed} aria-valuetext={`已处理 ${progress.processed} / ${progress.total}`}><span style={{ width: `${progress.percent}%` }} /></div>}
    <p className="if-queue-counts">成功 {progress.success.toLocaleString()} · 失败 {progress.failed.toLocaleString()} · 已取消 {progress.cancelled.toLocaleString()} · 待处理 {progress.pending.toLocaleString()} · 处理中 {progress.running.toLocaleString()}</p>
    <p className="if-queue-note">{progress.total ? "当前累计队列，已处理含失败和取消，取消不算成功。新增任务会增加总数；重试回到待处理，进度随之变化。" : "添加任务后显示实际处理进度。"}</p>
  </div>;
}
