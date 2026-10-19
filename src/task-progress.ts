/** Current persistent queue snapshot, not an estimate of a submission batch. */
export function taskProgress(counts: Record<string, number>) {
  const count = (status: string) => Math.max(0, counts[status] ?? 0);
  const success = count("done");
  const failed = count("failed") + count("needs_login") + count("unavailable");
  const pending = count("waiting") + count("retry_wait") + count("paused");
  const running = count("running");
  const total = Object.values(counts).reduce((sum, value) => sum + Math.max(0, value), 0);
  const cancelled=count("cancelled");
  const processed = success + failed+cancelled;
  return { success, failed, pending, running, cancelled, total, processed, percent: total ? Math.min(100, processed / total * 100) : null };
}

export const jobStatusNames = {
  waiting: "待处理", running: "处理中", retry_wait: "等待重试",
  done: "已完成", failed: "失败", needs_login: "需要登录", unavailable: "不可用",
  paused: "已暂停",
  cancelled: "已取消",
} as const;
