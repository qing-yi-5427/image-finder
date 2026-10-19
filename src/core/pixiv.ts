import type { ArtworkPayload } from "../contracts.js";
export class SourceError extends Error {
  constructor(
    public code:
      | "network"
      | "needs_login"
      | "restricted"
      | "unavailable"
      | "invalid_response"
      | "rate_limit"
      | "challenge",
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export async function fetchArtwork(
  id: string,
  fetcher: Fetcher = fetch,
): Promise<ArtworkPayload> {
  if (!/^[1-9]\d{4,11}$/.test(id))
    throw new SourceError("invalid_response", "Invalid artwork ID");
  let response: Response;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([
      fetcher(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      }),
      new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("timeout")), 31000);
      }),
    ]);
  } catch {
    throw new SourceError("network", "Source network request failed");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const retry = response.headers.get("retry-after");
  const delay = retry
    ? /^\d+$/.test(retry)
      ? Number(retry) * 1000
      : Math.max(0, Date.parse(retry) - Date.now())
    : 0;
  if (response.status === 429)
    throw new SourceError(
      "rate_limit",
      "Source rate limited",
      Number.isFinite(delay) ? delay : 0,
    );
  if (response.status === 401)
    throw new SourceError("needs_login", "Source requires login");
  if (response.status === 403)
    throw new SourceError("restricted", "Source access restricted");
  if (response.status >= 500)
    throw new SourceError("network", "Source temporarily unavailable");
  if (!response.ok)
    throw new SourceError("unavailable", `Source HTTP ${response.status}`);
  let json: any;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    json = await Promise.race([
      (async () => {
        if (Number(response.headers.get("content-length") ?? 0) > 4000000)
          throw new Error("large");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("empty");
        const decoder = new TextDecoder();
        let text = "",
          bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 4000000) throw new Error("large");
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          if (/^\s*</.test(text))
            throw new SourceError("challenge", "Source returned an HTML login or verification page");
          return JSON.parse(text);
        } finally {
          void reader.cancel().catch(() => {});
        }
      })(),
      new Promise((_, reject) => {
        bodyTimer = setTimeout(
          () => reject(new SourceError("network", "Source body timed out")),
          30000,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(
      "invalid_response",
      "Source returned invalid or oversized JSON",
    );
  } finally {
    if (bodyTimer) clearTimeout(bodyTimer);
  }
  if (json?.error)
    throw new SourceError("unavailable", "Source could not provide artwork");
  const b = json?.body;
  if (
    !b ||
    String(b.illustId ?? b.id) !== id ||
    typeof b.illustTitle !== "string" ||
    !/^\d+$/.test(String(b.userId)) ||
    typeof b.userName !== "string" ||
    !Number.isInteger(b.pageCount) ||
    b.pageCount < 1 ||
    b.pageCount > 10000 ||
    !Array.isArray(b.tags?.tags) ||
    b.tags.tags.some((t: any) => typeof t?.tag !== "string")
  )
    throw new SourceError(
      "invalid_response",
      "Source artwork structure or ID mismatch",
    );
  return {
    id,
    title: b.illustTitle,
    creator: { id: String(b.userId), name: b.userName },
    pageCount: b.pageCount,
    publishedAt: typeof b.createDate === "string" ? b.createDate : null,
    tags: b.tags.tags.map((t: any) => ({
      name: t.tag,
      translation:
        typeof t.translation?.en === "string" ? t.translation.en : undefined,
    })),
    raw: json,
  };
}
