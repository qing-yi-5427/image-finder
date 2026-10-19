import type { NetworkStatus } from "../src/api";
export function networkSummary(status: NetworkStatus | null): string {
  if (!status) return "正在读取来源状态…";
  const session = status.sessionPresent ? "已保存会话" : "未保存会话";
  const states: Record<NetworkStatus["authState"], string> = {
    unknown: "登录状态尚未验证",
    checking: "正在验证登录状态…",
    authenticated: "已登录 · 官方身份验证通过",
    unauthenticated: status.sessionPresent
      ? "会话已失效，请重新登录"
      : "尚未登录",
    network_error: "验证未完成，现有会话已保留",
  };
  return `${session} · ${states[status.authState]}${status.loginWindowOpen ? " · 登录窗口已打开" : ""}`;
}
