import { ImageFinderService } from "../core/service.js";
import { validateInvocation } from "../bridge.js";
import {
  officialArtworkURL,
  type SourceReply,
} from "../core/network-contract.js";
let serial = 0;
const requests = new Map<
  number,
  {
    resolve: (r: Response) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const fetcher = async (url: string): Promise<Response> => {
  if (!officialArtworkURL(url)) throw new Error("Source URL denied");
  return new Promise((resolve, reject) => {
    const requestId = ++serial;
    const timer = setTimeout(() => {
      requests.delete(requestId);
      reject(new Error("Source host timed out"));
    }, 35000);
    requests.set(requestId, { resolve, reject, timer });
    process.send?.({ kind: "source-request", requestId, url });
  });
};
const sauceRequests = new Map<
  number,
  {
    resolve: (r: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const sauceRequest = (
  preview: Uint8Array,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const requestId = ++serial;
    const timer = setTimeout(() => {
      sauceRequests.delete(requestId);
      reject(new Error("Sauce timeout"));
    }, 35000);
    sauceRequests.set(requestId, { resolve, reject, timer });
    process.send?.({
      kind: "sauce-request",
      requestId,
      preview: Array.from(preview),
    });
  });
const service = new ImageFinderService(process.argv[2], {
  fetcher,
  sauceRequest,
  startPaused: process.argv.includes("--start-paused"),
});
process.on("message", async (message: any) => {
  if (message?.kind === "sauce-response") {
    const p = sauceRequests.get(message.requestId);
    if (!p) return;
    sauceRequests.delete(message.requestId);
    clearTimeout(p.timer);
    message.error
      ? p.reject(new Error("Sauce failed"))
      : p.resolve(message.result);
    return;
  }
  if (message?.kind === "source-response") {
    const pending = requests.get(message.requestId);
    if (!pending) return;
    requests.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error("Source host request failed"));
    else {
      const r = message.result as SourceReply;
      pending.resolve(
        new Response(r.body, {
          status: r.status,
          headers: r.retryAfter ? { "retry-after": r.retryAfter } : {},
        }),
      );
    }
    return;
  }
  const { id, method, payload } = message ?? {};
  try {
    if (method === "__sourceEvidence") {
      const artworks = service.catalog.db
        .prepare(
          "SELECT a.id,a.page_count pageCount,(SELECT count(*) FROM artwork_tags t WHERE t.artwork_id=a.id) tagCount FROM artworks a",
        )
        .all();
      process.send?.({ id, result: { artworks, jobs: service.queue.list() } });
      return;
    }
    if (method === "__close") {
      await service.close();
      process.send?.({ id, result: true });
      process.exit(0);
    }
    validateInvocation(method, payload, { privileged: true });
    const result = await service.invoke(method, payload);
    process.send?.({ id, result });
  } catch (error) {
    process.send?.({
      id,
      error: {
        code: "SERVICE_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
process.on("disconnect", () => {
  for (const p of requests.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("Host disconnected"));
  }
  requests.clear();
  for (const p of sauceRequests.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("Host disconnected"));
  }
  sauceRequests.clear();
  void service.close().finally(() => process.exit(0));
});
