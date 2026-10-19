import { readFile, stat } from "node:fs/promises";
import type { Catalog } from "./catalog.js";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { directoryPath } from "../directory-path.js";
export interface SauceCandidate {
  artworkId: string;
  url: string;
  similarity: number;
  title: string;
}
export interface SauceReply {
  status: number;
  body: string;
}
export interface SauceScope {
  rootId: string;
  relativePath: string;
  recursive: boolean;
}
export interface SauceReview {
  fileId: string;
  action: "confirm" | "reject";
  artworkId?: string;
  page?: number | null;
}
export interface SauceItem {
  fileId: string;
  status: string;
  candidates: SauceCandidate[];
  error: string | null;
  relativePath: string;
}
export interface SauceStatus {
  configured: boolean;
  paused: boolean;
  reason: string | null;
  shortRemaining: number | null;
  longRemaining: number | null;
  counts: Array<{ status: string; count: number }>;
}
function remaining(value: unknown): number | null {
  const n = Number(value);
  return value !== undefined && value !== null && Number.isFinite(n) && n >= 0
    ? n
    : null;
}
export const SAUCE_LONG_RESERVE = 5;
/** The first request may bootstrap quota; every recorded response must be known. */
export function sauceQuotaPause(short: unknown, long: unknown) {
  const s = remaining(short),
    l = remaining(long);
  if (s === 0 || l === 0) return "quota_exhausted";
  if (s === null || l === null) return "quota_unknown";
  return l <= SAUCE_LONG_RESERVE ? "quota_reserve" : null;
}
export function parseSauce(reply: SauceReply) {
  if ([401, 403, 429].includes(reply.status))
    return {
      candidates: [],
      shortRemaining: null,
      longRemaining: null,
      pause: reply.status === 429 ? "rate_limit" : "authentication",
    };
  if (reply.status !== 200) throw new Error("SAUCE_HTTP_ERROR");
  const body = JSON.parse(reply.body);
  const h = body?.header;
  if (!h || !Number.isFinite(Number(h.status)))
    throw new Error("SAUCE_INVALID_RESPONSE");
  const shortRemaining = remaining(h.short_remaining),
    longRemaining = remaining(h.long_remaining);
  if (Number(h.status) !== 0)
    return {
      candidates: [],
      shortRemaining,
      longRemaining,
      pause: Number(h.status) === -1 ? "api_error" : "api_status",
    };
  if (!Array.isArray(body.results)) throw new Error("SAUCE_INVALID_RESULTS");
  const diagnostics = {
    resultCount: body.results.length,
    pixivIdCount: 0,
    unsupportedOfficialUrlCount: 0,
  };
  const found = new Map<string, SauceCandidate>();
  for (const result of body.results.slice(0, 100)) {
    const d = result?.data;
    const similarity = Number(result?.header?.similarity);
    const id = String(d?.pixiv_id ?? "");
    if (
      !/^[1-9]\d{0,11}$/.test(id) ||
      !Number.isFinite(similarity) ||
      similarity < 0 ||
      similarity > 100
    )
      continue;
    diagnostics.pixivIdCount++;
    const urls = Array.isArray(d.ext_urls) ? d.ext_urls : [];
    const official = urls.some((v: unknown) => {
      try {
        const u = new URL(String(v));
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.port &&
          ["www.pixiv.net", "pixiv.net"].includes(u.hostname) &&
          (u.pathname === `/artworks/${id}` ||
            (u.pathname === "/member_illust.php" &&
              u.searchParams.get("illust_id") === id &&
              ["medium", "big", null].includes(u.searchParams.get("mode"))))
        );
      } catch {
        return false;
      }
    });
    if (!official) {
      diagnostics.unsupportedOfficialUrlCount++;
      continue;
    }
    const candidate = {
      artworkId: id,
      url: `https://www.pixiv.net/artworks/${id}`,
      similarity,
      title: String(d.title ?? "").slice(0, 300),
    };
    if ((found.get(id)?.similarity ?? -1) < similarity)
      found.set(id, candidate);
  }
  return {
    diagnostics,
    candidates: [...found.values()].sort((a, b) => b.similarity - a.similarity),
    shortRemaining,
    longRemaining,
    pause: sauceQuotaPause(shortRemaining, longRemaining),
  };
}
export async function saucePreview(filename: string): Promise<Buffer> {
  return sharp(filename, { limitInputPixels: 100_000_000, animated: false })
    .rotate()
    .resize({
      width: 512,
      height: 512,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 80 })
    .toBuffer();
}
export class SauceQueue {
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private generation = 0;
  async cancel() {
    this.generation++;
    const reason=this.status().reason;
    this.pause();
    if(reason&&!['user','shutdown','restart','completed','not_started','settings_changed','cancelled'].includes(reason))this.c.db.prepare('UPDATE sauce_state SET reason=? WHERE id=1').run(reason);
    else this.c.db.prepare("UPDATE sauce_state SET reason='cancelled' WHERE id=1").run();
    const cancelled=this.c.db.prepare("UPDATE sauce_jobs SET status='cancelled',updated_at=? WHERE status IN ('waiting','running')").run(Date.now()).changes;
    await this.active;
    return {cancelled};
  }
  constructor(
    private c: Catalog,
    private options: {
      request?: (preview: Uint8Array) => Promise<SauceReply>;
      onConfirmed?: (id: string) => void;
      intervalMs?: number;
    } = {},
  ) {
    c.db.exec(
      `CREATE TABLE IF NOT EXISTS sauce_state(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL DEFAULT 1,reason TEXT,short_remaining REAL,long_remaining REAL);INSERT OR IGNORE INTO sauce_state(id,paused,reason) VALUES(1,1,'not_started');CREATE TABLE IF NOT EXISTS sauce_jobs(file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,status TEXT NOT NULL,hash TEXT,candidates_json TEXT NOT NULL DEFAULT '[]',error TEXT,updated_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS sauce_cache(hash TEXT PRIMARY KEY,candidates_json TEXT NOT NULL,created_at INTEGER NOT NULL);`,
    );
    c.db
      .prepare(
        "UPDATE sauce_jobs SET status='uncertain',error='interrupted' WHERE status='running'",
      )
      .run();
    c.db
      .prepare(
        "UPDATE sauce_state SET paused=1,reason=CASE WHEN reason IS NULL THEN 'restart' ELSE reason END WHERE id=1",
      )
      .run();
  }
  status(): SauceStatus {
    const s = this.c.db
      .prepare("SELECT * FROM sauce_state WHERE id=1")
      .get() as any;
    return {
      configured: false,
      paused: !!s.paused,
      reason: s.reason,
      shortRemaining: s.short_remaining,
      longRemaining: s.long_remaining,
      counts: this.c.db
        .prepare("SELECT status,count(*) count FROM sauce_jobs GROUP BY status")
        .all() as any,
    };
  }
  list(limit = 100): SauceItem[] {
    return (
      this.c.db
        .prepare(
          "SELECT j.*,f.relative_path FROM sauce_jobs j JOIN files f ON f.id=j.file_id ORDER BY updated_at DESC LIMIT ?",
        )
        .all(Math.max(1, Math.min(limit, 500))) as any[]
    ).map((r) => ({
      fileId: r.file_id,
      status: r.status,
      candidates: JSON.parse(r.candidates_json),
      error: r.error,
      relativePath: r.relative_path,
    }));
  }
  enqueue(scope: SauceScope) {
    this.c.getRoot(scope.rootId);
    const dir = directoryPath(scope.relativePath);
    const prefix = dir ? dir + "/" : "";
    const rows = this.c.db
      .prepare(
        "SELECT id,relative_path FROM files WHERE root_id=? AND missing=0 AND artwork_id IS NULL",
      )
      .all(scope.rootId) as any[];
    let added = 0;
    const insert = this.c.db.prepare(
      "INSERT OR IGNORE INTO sauce_jobs(file_id,status,updated_at) VALUES(?,'waiting',?)",
    );
    this.c.db.transaction(() => {
      for (const r of rows) {
        const p = r.relative_path.replace(/\\/g, "/");
        if (
          !p.startsWith(prefix) ||
          (!scope.recursive && p.slice(prefix.length).includes("/"))
        )
          continue;
        added += insert.run(r.id, Date.now()).changes;
        added += this.c.db.prepare("UPDATE sauce_jobs SET status='waiting',updated_at=? WHERE file_id=? AND status='cancelled'").run(Date.now(),r.id).changes;
      }
    })();
    return { added };
  }
  pause(reason = "user") {
    this.c.db
      .prepare(
        "UPDATE sauce_state SET paused=1,reason=CASE WHEN ? IN ('user','shutdown') AND reason IN ('quota_exhausted','quota_reserve','quota_unknown','rate_limit','authentication','api_error','api_status') THEN reason ELSE ? END WHERE id=1",
      )
      .run(reason, reason);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  resume() {
    if (!this.options.request) throw new Error("SAUCE_NOT_CONFIGURED");
    const s = this.status();
    const recorded =
      s.shortRemaining !== null ||
      s.longRemaining !== null ||
      !!this.c.db.prepare("SELECT 1 FROM sauce_cache LIMIT 1").get();
    const quota = recorded
      ? sauceQuotaPause(s.shortRemaining, s.longRemaining)
      : null;
    if (quota) {
      this.pause(quota);
      throw new Error("SAUCE_REQUIRES_SETTINGS_REVIEW");
    }
    if (
      [
        "quota_exhausted",
        "quota_reserve",
        "quota_unknown",
        "rate_limit",
        "authentication",
        "api_error",
        "api_status",
      ].includes(s.reason ?? "")
    )
      throw new Error("SAUCE_REQUIRES_SETTINGS_REVIEW");
    this.c.db
      .prepare("UPDATE sauce_state SET paused=0,reason=NULL WHERE id=1")
      .run();
    this.kick();
  }
  // Explicit configuration unlocks a paused source; no automatic quota retry.
  configured() {
    this.pause("settings_changed");
  }
  private kick() {
    if (this.closed || this.active || this.status().paused) return;
    this.active = this.runOne()
      .catch(() => this.pause("unexpected_error"))
      .finally(() => {
        this.active = null;
        if (!this.closed && !this.status().paused)
          this.timer = setTimeout(() => {
            this.timer = null;
            this.kick();
          }, this.options.intervalMs ?? 35000);
      });
  }
  private async runOne() {
    const generation=this.generation;
    const row = this.c.db
      .prepare(
        "SELECT j.file_id FROM sauce_jobs j JOIN files f ON f.id=j.file_id WHERE j.status='waiting' AND f.missing=0 AND f.artwork_id IS NULL ORDER BY j.updated_at,j.file_id LIMIT 1",
      )
      .get() as any;
    if (!row) {
      this.pause("completed");
      return;
    }
    const id = row.file_id;
    this.c.db
      .prepare(
        "UPDATE sauce_jobs SET status='running',updated_at=? WHERE file_id=?",
      )
      .run(Date.now(), id);
    try {
      const preview = await saucePreview(await this.c.resolveOriginal(id));
      if(generation!==this.generation)return;
      const hash = createHash("sha256").update(preview).digest("hex");
      this.c.db
        .prepare("UPDATE sauce_jobs SET hash=? WHERE file_id=?")
        .run(hash, id);
      const previous = this.c.db
        .prepare(
          "SELECT file_id FROM sauce_jobs WHERE hash=? AND file_id<>? AND status IN ('uncertain','error','running') LIMIT 1",
        )
        .get(hash, id);
      if (previous) {
        this.c.db
          .prepare(
            "UPDATE sauce_jobs SET status='uncertain',error='duplicate_previous_attempt' WHERE file_id=?",
          )
          .run(id);
        this.pause("previous_attempt_uncertain");
        return;
      }
      const cache = this.c.db
        .prepare("SELECT candidates_json FROM sauce_cache WHERE hash=?")
        .get(hash) as any;
      let candidates: SauceCandidate[];
      if (cache) candidates = JSON.parse(cache.candidates_json);
      else {
        if (this.status().paused) {
          this.c.db
            .prepare("UPDATE sauce_jobs SET status='waiting' WHERE file_id=?")
            .run(id);
          return;
        }
        const parsed = parseSauce(await this.options.request!(preview));
        candidates = parsed.candidates;
        this.c.db
          .prepare(
            "UPDATE sauce_state SET short_remaining=?,long_remaining=? WHERE id=1",
          )
          .run(parsed.shortRemaining, parsed.longRemaining);
        if (parsed.pause) this.pause(parsed.pause);
        if(generation!==this.generation)return;
        if (
          ["rate_limit", "authentication", "api_error", "api_status"].includes(
            parsed.pause ?? "",
          )
        ) {
          this.c.db
            .prepare(
              "UPDATE sauce_jobs SET status='error',error=?,hash=?,updated_at=? WHERE file_id=?",
            )
            .run(parsed.pause, hash, Date.now(), id);
          return;
        }
        this.c.db
          .prepare(
            "INSERT OR IGNORE INTO sauce_cache(hash,candidates_json,created_at) VALUES(?,?,?)",
          )
          .run(hash, JSON.stringify(candidates), Date.now());
      }
      this.c.db
        .prepare(
          "UPDATE sauce_jobs SET status=?,hash=?,candidates_json=?,error=NULL,updated_at=? WHERE file_id=?",
        )
        .run(
          candidates.length ? "review" : "no_match",
          hash,
          JSON.stringify(candidates),
          Date.now(),
          id,
        );
    } catch {
      if(generation!==this.generation){if(['user','cancelled'].includes(this.status().reason??''))this.pause('quota_unknown');return;}
      this.c.db
        .prepare(
          "UPDATE sauce_jobs SET status='uncertain',error='search_failed',updated_at=? WHERE file_id=?",
        )
        .run(Date.now(), id);
      this.pause("search_failed");
    }
  }
  async review(input: SauceReview) {
    const row = this.c.db
      .prepare("SELECT * FROM sauce_jobs WHERE file_id=?")
      .get(input.fileId) as any;
    if (!row || row.status !== "review")
      throw new Error("SAUCE_NOT_REVIEWABLE");
    if (input.action === "reject") {
      this.c.db
        .prepare(
          "UPDATE sauce_jobs SET status='rejected',updated_at=? WHERE file_id=?",
        )
        .run(Date.now(), input.fileId);
      return;
    }
    const candidates = JSON.parse(row.candidates_json) as SauceCandidate[];
    if (!candidates.some((c) => c.artworkId === input.artworkId))
      throw new Error("SAUCE_INVALID_CANDIDATE");
    const file = this.c.getFile(input.fileId);
    if (file.missing) throw new Error("FILE_MISSING");
    const currentHash = createHash("sha256")
      .update(await saucePreview(await this.c.resolveOriginal(input.fileId)))
      .digest("hex");
    if (!row.hash || currentHash !== row.hash)
      throw new Error("SAUCE_FILE_CHANGED");
    if (this.c.getFile(input.fileId).artworkId)
      throw new Error("ALREADY_BOUND");
    if (file.artworkId) throw new Error("ALREADY_BOUND");
    const page = input.page ?? null;
    if (page !== null && (!Number.isInteger(page) || page < 0))
      throw new Error("INVALID_PAGE");
    const source = this.c.db
      .prepare("SELECT page_count FROM artworks WHERE id=?")
      .get(input.artworkId) as any;
    if (source && page !== null && page >= source.page_count)
      throw new Error("PAGE_OUT_OF_RANGE");
    this.c.db.transaction(() => {
      this.c.db
        .prepare(
          "UPDATE files SET artwork_id=?,page=?,candidate_artwork_id=NULL WHERE id=? AND artwork_id IS NULL",
        )
        .run(input.artworkId, page, input.fileId);
      this.c.db
        .prepare(
          "UPDATE sauce_jobs SET status='confirmed',updated_at=? WHERE file_id=?",
        )
        .run(Date.now(), input.fileId);
      this.options.onConfirmed?.(input.artworkId!);
    })();
  }
  async importLedger(source: string) {
    const info = await stat(source);
    if (!info.isFile() || info.size > 10 * 1024 * 1024)
      throw new Error("SAUCE_INVALID_LEDGER");
    const ledger = JSON.parse(await readFile(source, "utf8"));
    if (
      ledger.version !== 1 ||
      !Array.isArray(ledger.results) ||
      ledger.results.length > 10000
    )
      throw new Error("SAUCE_INVALID_LEDGER");
    let imported = 0,
      skipped = 0;
    for (const item of ledger.results) {
      try {
        const file = this.c.getFile(item.fileId);
        if (
          file.rootId !== ledger.rootId ||
          file.missing ||
          file.artworkId ||
          file.bytes !== item.bytes ||
          Math.abs(file.mtimeMs - item.mtimeMs) > 1
        ) {
          skipped++;
          continue;
        }
        const hash = createHash("sha256")
          .update(await saucePreview(await this.c.resolveOriginal(item.fileId)))
          .digest("hex");
        if (hash !== item.previewHash) {
          skipped++;
          continue;
        }
        const lastShort = remaining(item.shortRemaining),
          lastLong = remaining(item.longRemaining);
        this.c.db
          .prepare(
            "UPDATE sauce_state SET short_remaining=?,long_remaining=? WHERE id=1",
          )
          .run(lastShort, lastLong);
        const quota = sauceQuotaPause(lastShort, lastLong);
        if (quota) this.pause(quota);
        if (
          [
            "quota_exhausted",
            "quota_reserve",
            "quota_unknown",
            "rate_limit",
            "authentication",
            "api_error",
            "api_status",
          ].includes(item.pause)
        )
          this.pause(item.pause);
        const uncertain = ["running", "uncertain", "error"].includes(
          item.status,
        );
        const parsed = parseSauce({
          status: 200,
          body: JSON.stringify({
            header: { status: 0, short_remaining: 1, long_remaining: 1 },
            results: (item.candidates ?? []).map((v: any) => ({
              header: { similarity: v.similarity },
              data: {
                pixiv_id: v.artworkId,
                title: v.title,
                ext_urls: [v.url],
              },
            })),
          }),
        });
        const candidates = parsed.candidates;
        const status = uncertain
          ? "uncertain"
          : candidates.length
            ? "review"
            : "no_match";
        const inserted = this.c.db
          .prepare(
            "INSERT OR IGNORE INTO sauce_jobs(file_id,status,hash,candidates_json,error,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            item.fileId,
            status,
            hash,
            JSON.stringify(candidates),
            uncertain ? "imported_uncertain" : null,
            Date.now(),
          ).changes;
        if (inserted) {
          imported++;
          if (!uncertain)
            this.c.db
              .prepare(
                "INSERT OR IGNORE INTO sauce_cache(hash,candidates_json,created_at) VALUES(?,?,?)",
              )
              .run(hash, JSON.stringify(candidates), Date.now());
        } else skipped++;
      } catch {
        skipped++;
      }
    }
    return { imported, skipped };
  }
  async close() {
    this.closed = true;
    this.pause("shutdown");
    await this.active;
  }
}
