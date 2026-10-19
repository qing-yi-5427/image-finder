export interface ProxySettings {
  mode: "system" | "direct" | "custom";
  proxyRules?: string;
}
export function validateProxySettings(
  value: unknown,
): asserts value is ProxySettings {
  const p = value as ProxySettings;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some((k) => !["mode", "proxyRules"].includes(k)) ||
    !["system", "direct", "custom"].includes(p.mode)
  )
    throw new Error("Invalid proxy settings");
  if (p.mode === "custom") {
    if (
      typeof p.proxyRules !== "string" ||
      !/^((http|https|socks5):\/\/)?[a-zA-Z0-9.-]+:\d{1,5}$/.test(
        p.proxyRules,
      ) ||
      Number(p.proxyRules.split(":").at(-1)) > 65535
    )
      throw new Error("Proxy must be a host and port without credentials");
  } else if (p.proxyRules !== undefined)
    throw new Error("Unexpected proxy address");
}
export interface SourceReply {
  status: number;
  retryAfter: string | null;
  body: string;
}
export function officialArtworkURL(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === "www.pixiv.net" &&
      u.port === "" &&
      /^\/ajax\/illust\/[1-9]\d{4,11}$/.test(u.pathname) &&
      [...u.searchParams.keys()].every((k) => k === "lang") &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

export interface SourceNetworkStatus {
  proxy: ProxySettings;
  sessionPresent: boolean;
  authenticationVerified: boolean;
  authState:
    | "unknown"
    | "checking"
    | "authenticated"
    | "unauthenticated"
    | "network_error";
  checkedAt: number | null;
  error: {
    code: "timeout" | "network" | "http" | "challenge" | "invalid_response";
    message: string;
  } | null;
  loginWindowOpen: boolean;
}
/** Fixed current-session bootstrap endpoint used by Pixiv's own web client. */
export const PIXIV_AUTH_URL = "https://www.pixiv.net/ajax/user/self";
