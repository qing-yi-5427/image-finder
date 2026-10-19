import { sauceQuotaPause } from "./sauce.js";
import { open, unlink } from "node:fs/promises";
/** Exclusive sidecar run lock; stale locks require an operator review. */
export async function acquireSauceLock(output: string) {
  const filename = output + ".lock";
  const handle = await open(filename, "wx");
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  return async () => {
    await handle.close();
    await unlink(filename);
  };
}
export async function sauceInterval(
  index: number,
  count: number,
  stopping: boolean,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
) {
  if (index + 1 < count && !stopping) await sleep(35000);
}

/** Cached records do not consume quota and need not carry quota metadata. */
export function sauceLedgerPause(item: any): string | null {
  if (["running", "uncertain", "error"].includes(item.status))
    return "previous_attempt_uncertain";
  if (item.cacheHit) return null;
  return (
    sauceQuotaPause(item.shortRemaining, item.longRemaining) ??
    ([
      "quota_reserve",
      "quota_exhausted",
      "quota_unknown",
      "rate_limit",
      "authentication",
      "api_error",
      "api_status",
    ].includes(item.pause)
      ? item.pause
      : null)
  );
}
