import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Catalog } from "./catalog.js";
import { directoryPath } from "../directory-path.js";
export interface DanbooruScope {
  rootId: string;
  relativePath: string;
  recursive: boolean;
}
export interface DanbooruReply {
  status: number;
  body: string;
}
export interface DanbooruPost {
  id: number;
  md5: string;
  tags: Array<{ name: string; category: string }>;
}
export interface DanbooruUnavailable {
  kind: "unavailable";
  id: number;
  reason: "post_banned" | "post_deleted";
}
export type DanbooruResult = DanbooruPost | DanbooruUnavailable | null;
export interface DanbooruStatus {
  paused: boolean;
  reason: string | null;
  counts: Array<{ status: string; count: number }>;
}
export interface DanbooruItem {
  fileId: string;
  relativePath: string;
  status: string;
  error: string | null;
  postId: number | null;
  matchedBy: string | null;
}
export interface DanbooruTag {
  name: string;
  displayName: string;
  category: string;
  postId: number;
  matchedBy: string;
}
export const DANBOORU_INTERVAL_MS = 3200;
export const DANBOORU_USER_AGENT =
  "ImageFinder/0.2.11 (local illustration catalog; exact MD5 lookup)";
export function danbooruURL(md5: string) {
  if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error("DANBOORU_INVALID_MD5");
  return `https://danbooru.donmai.us/posts.json?tags=md5%3A${md5}&limit=2`;
}
/** No image bytes, source URLs, cookies, credentials, or redirects leave this transport. */
export async function requestDanbooru(
  md5: string,
  signal?: AbortSignal,
): Promise<DanbooruReply> {
  const r = await fetch(danbooruURL(md5), {
    headers: { "User-Agent": DANBOORU_USER_AGENT, Accept: "application/json" },
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
      : AbortSignal.timeout(25000),
  });
  if (r.status !== 200) {
    await r.body?.cancel();
    return { status: r.status, body: "" };
  }
  const reader = r.body?.getReader();
  if (!reader) throw new Error("DANBOORU_EMPTY_RESPONSE");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024)
        throw new Error("DANBOORU_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { status: r.status, body: Buffer.concat(chunks).toString("utf8") };
}
export function parseDanbooru(
  reply: DanbooruReply,
  md5: string,
): DanbooruResult {
  if (reply.status !== 200)
    throw new Error(
      reply.status === 429
        ? "rate_limit"
        : [401, 403].includes(reply.status)
          ? "access_restricted"
          : `http_${reply.status}`,
    );
  const rows = JSON.parse(reply.body);
  if (!Array.isArray(rows) || rows.length > 2)
    throw new Error("invalid_response");
  if (!rows.length) return null;
  // Even a Pixiv ID match is insufficient: page-specific tags require identical bytes.
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(rows[0]?.id) ||
    rows[0].id <= 0
  )
    throw new Error("ambiguous_or_invalid_match");
  const p = rows[0];
  if (p.md5 !== undefined && p.md5 !== null && p.md5 !== "" && p.md5 !== md5)
    throw new Error("ambiguous_or_invalid_match");
  for (const flag of ["is_deleted", "is_banned"])
    if (p[flag] !== undefined && typeof p[flag] !== "boolean")
      throw new Error("invalid_response");
  if (p.is_banned === true || p.is_deleted === true)
    return {
      kind: "unavailable",
      id: p.id,
      reason: p.is_banned === true ? "post_banned" : "post_deleted",
    };
  if (p.md5 !== md5) throw new Error("ambiguous_or_invalid_match");
  const tags: DanbooruPost["tags"] = [];
  for (const category of [
    "general",
    "character",
    "copyright",
    "artist",
    "meta",
  ]) {
    const value = p[`tag_string_${category}`];
    if (typeof value !== "string" || value.length > 200000)
      throw new Error("invalid_tags");
    for (const name of new Set(value.split(/\s+/).filter(Boolean))) {
      if (name.length > 300 || /[\u0000-\u001f]/.test(name))
        throw new Error("invalid_tag");
      tags.push({ name, category });
    }
  }
  return { id: p.id, md5, tags };
}
/** Accept the pre-0.2.11 post/null cache and the new typed unavailable entry. */
export function decodeDanbooruCache(json: string, md5: string): DanbooruResult {
  const value = JSON.parse(json);
  if (value === null) return null;
  if (
    value?.kind === "unavailable" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    ["post_banned", "post_deleted"].includes(value.reason)
  )
    return value;
  if (
    value &&
    value.kind === undefined &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    value.md5 === md5 &&
    Array.isArray(value.tags) &&
    value.tags.every(
      (t: any) => typeof t.name === "string" && typeof t.category === "string",
    )
  )
    return value;
  throw new Error("invalid_cache");
}
export async function fileMd5(filename: string) {
  const hash = createHash("md5");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}
export class DanbooruQueue {
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private generation = 0;
  private abort: AbortController | null = null;
  constructor(
    private c: Catalog,
    private options: {
      request?: (md5: string, signal?: AbortSignal) => Promise<DanbooruReply>;
      intervalMs?: number;
    } = {},
  ) {
    c.db.exec(
      `CREATE TABLE IF NOT EXISTS danbooru_state(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL DEFAULT 1,reason TEXT,last_request_at INTEGER NOT NULL DEFAULT 0);INSERT OR IGNORE INTO danbooru_state(id,reason) VALUES(1,'not_started');CREATE TABLE IF NOT EXISTS danbooru_jobs(file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,status TEXT NOT NULL,md5 TEXT,bytes INTEGER,mtime_ms REAL,post_id INTEGER,error TEXT,updated_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS danbooru_cache(md5 TEXT PRIMARY KEY,post_json TEXT NOT NULL,created_at INTEGER NOT NULL);`,
    );
    c.db.exec(
      "UPDATE danbooru_jobs SET status='waiting',error='interrupted' WHERE status='running';UPDATE danbooru_state SET paused=1,reason=COALESCE(reason,'restart') WHERE id=1",
    );
  }
  status(): DanbooruStatus {
    const s = this.c.db
      .prepare("SELECT * FROM danbooru_state WHERE id=1")
      .get() as any;
    return {
      paused: !!s.paused,
      reason: s.reason,
      counts: this.c.db
        .prepare(
          "SELECT status,count(*) count FROM danbooru_jobs GROUP BY status",
        )
        .all() as any,
    };
  }
  list(limit = 100): DanbooruItem[] {
    return this.c.db
      .prepare(
        "SELECT j.file_id fileId,f.relative_path relativePath,j.status,j.error,j.post_id postId,CASE WHEN j.status='done' THEN 'md5' ELSE NULL END matchedBy FROM danbooru_jobs j JOIN files f ON f.id=j.file_id ORDER BY j.updated_at DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(limit, 500))) as DanbooruItem[];
  }
  tags(fileId: string): DanbooruTag[] {
    this.c.getFile(fileId);
    return this.c.db
      .prepare(
        "SELECT d.raw_name name,COALESCE(l.display_name,(SELECT alias FROM tag_aliases a WHERE a.tag_id=d.tag_id AND alias GLOB '*[一-龥]*' ORDER BY alias LIMIT 1),t.name,d.raw_name) displayName,d.category,d.post_id postId,'md5' matchedBy FROM danbooru_tags d JOIN tags t ON t.id=d.tag_id LEFT JOIN ai_lexicon l ON l.tag=d.raw_name WHERE d.file_id=? ORDER BY d.category,d.raw_name",
      )
      .all(fileId) as DanbooruTag[];
  }
  private scope(scope: DanbooruScope) {
    this.c.getRoot(scope.rootId);
    const dir = directoryPath(scope.relativePath);
    const prefix = dir ? dir + "/" : "";
    return (
      this.c.db
        .prepare(
          "SELECT f.id,f.relative_path,f.bytes,f.mtime_ms,j.status,j.bytes job_bytes,j.mtime_ms job_mtime FROM files f LEFT JOIN danbooru_jobs j ON j.file_id=f.id WHERE f.root_id=? AND f.missing=0",
        )
        .all(scope.rootId) as any[]
    ).filter((r) => {
      const p = r.relative_path.replace(/\\/g, "/");
      return (
        p.startsWith(prefix) &&
        (scope.recursive || !p.slice(prefix.length).includes("/"))
      );
    });
  }
  private eligible(r: any) {
    return (
      !r.status ||
      ["error", "cancelled"].includes(r.status) ||
      r.bytes !== r.job_bytes ||
      r.mtime_ms !== r.job_mtime
    );
  }
  preview(scope: DanbooruScope) {
    const rows = this.scope(scope);
    return {
      total: rows.length,
      eligible: rows.filter((r) => this.eligible(r)).length,
    };
  }
  enqueue(scope: DanbooruScope) {
    const rows = this.scope(scope).filter((r) => this.eligible(r));
    this.c.db.transaction(() => {
      for (const r of rows) this.add(r.id);
    })();
    return { added: rows.length };
  }
  enqueueFile(fileId: string) {
    this.c.getFile(fileId);
    return { added: this.add(fileId) };
  }
  private add(fileId: string) {
    const f = this.c.getFile(fileId);
    if (f.missing) throw new Error("FILE_MISSING");
    return this.c.db
      .prepare(
        "INSERT INTO danbooru_jobs(file_id,status,bytes,mtime_ms,updated_at) VALUES(?,'waiting',?,?,?) ON CONFLICT(file_id) DO UPDATE SET status='waiting',bytes=excluded.bytes,mtime_ms=excluded.mtime_ms,error=NULL,updated_at=excluded.updated_at WHERE danbooru_jobs.status NOT IN ('waiting','running')",
      )
      .run(fileId, f.bytes, f.mtimeMs, Date.now()).changes;
  }
  pause(reason = "user") {
    this.c.db
      .prepare(
        "UPDATE danbooru_state SET paused=1,reason=CASE WHEN ? IN ('user','shutdown','cancelled') AND reason IS NOT NULL AND reason NOT IN ('user','shutdown','cancelled','completed','not_started','restart','settings_changed') THEN reason ELSE ? END WHERE id=1",
      )
      .run(reason, reason);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  resume() {
    if (this.closed) throw new Error("DANBOORU_CLOSED");
    this.c.db
      .prepare(
        "UPDATE danbooru_jobs SET status='waiting',error=NULL WHERE status='error'",
      )
      .run();
    this.c.db
      .prepare("UPDATE danbooru_state SET paused=0,reason=NULL WHERE id=1")
      .run();
    this.kick();
  }
  async cancel() {
    this.generation++;
    this.pause("cancelled");
    this.abort?.abort();
    const cancelled=this.c.db
      .prepare(
        "UPDATE danbooru_jobs SET status='cancelled',error=NULL,updated_at=? WHERE status IN ('waiting','running')",
      )
      .run(Date.now()).changes;
    await this.active;
    return {cancelled};
  }
  private kick() {
    if (this.closed || this.active || this.status().paused) return;
    const s = this.c.db
      .prepare("SELECT last_request_at FROM danbooru_state WHERE id=1")
      .get() as any;
    const wait = Math.max(
      0,
      s.last_request_at +
        Math.max(DANBOORU_INTERVAL_MS, this.options.intervalMs ?? 0) -
        Date.now(),
    );
    if (wait) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, wait);
      return;
    }
    this.active = this.runOne()
      .catch(() => this.pause("unexpected_error"))
      .finally(() => {
        this.active = null;
        if (!this.closed && !this.status().paused) {
          this.timer = setTimeout(
            () => {
              this.timer = null;
              this.kick();
            },
            Math.max(DANBOORU_INTERVAL_MS, this.options.intervalMs ?? 0),
          );
        }
      });
  }
  private async runOne() {
    const row = this.c.db
      .prepare(
        "SELECT j.file_id FROM danbooru_jobs j JOIN files f ON f.id=j.file_id WHERE j.status='waiting' AND f.missing=0 ORDER BY j.updated_at,j.file_id LIMIT 1",
      )
      .get() as any;
    if (!row) {
      this.pause("completed");
      return;
    }
    const id = row.file_id;
    const gen = this.generation;
    this.c.db
      .prepare(
        "UPDATE danbooru_jobs SET status='running',error=NULL,updated_at=? WHERE file_id=?",
      )
      .run(Date.now(), id);
    try {
      const file = this.c.getFile(id);
      const filename = await this.c.resolveOriginal(id);
      const before = await stat(filename);
      if (
        before.size !== file.bytes ||
        Math.abs(before.mtimeMs - file.mtimeMs) > 1
      )
        throw new Error("file_changed");
      const md5 = await fileMd5(filename);
      if (gen !== this.generation || this.closed) return;
      if (this.status().paused) {
        this.c.db
          .prepare("UPDATE danbooru_jobs SET status='waiting' WHERE file_id=?")
          .run(id);
        return;
      }
      const cached = this.c.db
        .prepare("SELECT * FROM danbooru_cache WHERE md5=?")
        .get(md5) as any;
      let result: DanbooruResult;
      const cachedResult = cached
        ? decodeDanbooruCache(cached.post_json, md5)
        : null;
      const ttl =
        !cachedResult || "kind" in cachedResult ? 86400000 : 30 * 86400000;
      if (cached && Date.now() - cached.created_at < ttl) result = cachedResult;
      else {
        this.abort = new AbortController();
        this.c.db
          .prepare("UPDATE danbooru_state SET last_request_at=? WHERE id=1")
          .run(Date.now());
        result = parseDanbooru(
          await (this.options.request ?? requestDanbooru)(
            md5,
            this.abort.signal,
          ),
          md5,
        );
        if (gen !== this.generation || this.closed) return;
        this.c.db
          .prepare(
            "INSERT INTO danbooru_cache VALUES(?,?,?) ON CONFLICT(md5) DO UPDATE SET post_json=excluded.post_json,created_at=excluded.created_at",
          )
          .run(md5, JSON.stringify(result), Date.now());
      }
      const unavailable = result && "kind" in result ? result : null;
      const post = result && !unavailable ? (result as DanbooruPost) : null;
      const after = await stat(filename);
      const current = this.c.getFile(id);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        current.bytes !== file.bytes ||
        current.mtimeMs !== file.mtimeMs
      )
        throw new Error("file_changed");
      if (gen !== this.generation || this.closed) return;
      this.c.db.transaction(() => {
        this.c.db.prepare("DELETE FROM danbooru_tags WHERE file_id=?").run(id);
        if (post)
          for (const tag of post.tags) {
            const existing = this.c.db
              .prepare(
                "SELECT tag_id FROM tag_aliases WHERE alias_key=normalize_text(?)",
              )
              .get(tag.name) as any;
            const tagId =
              existing?.tag_id ??
              this.c.createTag(
                tag.name,
                tag.category === "character"
                  ? "character"
                  : tag.category === "copyright"
                    ? "franchise"
                    : tag.category === "general"
                      ? "content"
                      : "uncategorized",
              );
            // Reuse the offline WD dictionary, but never identify two English keys by a translation.
            const translated = this.c.db
              .prepare("SELECT display_name FROM ai_lexicon WHERE tag=?")
              .get(tag.name) as any;
            if (translated && /[一-龥]/.test(translated.display_name)) {
              const alias = this.c.db
                .prepare(
                  "SELECT tag_id FROM tag_aliases WHERE alias_key=normalize_text(?)",
                )
                .get(translated.display_name) as any;
              if (!alias || alias.tag_id === tagId)
                this.c.addAlias(tagId, translated.display_name);
            }
            this.c.db
              .prepare(
                "INSERT INTO danbooru_tags(file_id,raw_name,tag_id,category,post_id) VALUES(?,?,?,?,?)",
              )
              .run(id, tag.name, tagId, tag.category, post.id);
          }
        this.c.db
          .prepare(
            "UPDATE danbooru_jobs SET status=?,md5=?,bytes=?,mtime_ms=?,post_id=?,error=?,updated_at=? WHERE file_id=?",
          )
          .run(
            unavailable ? "unavailable" : post ? "done" : "no_match",
            md5,
            file.bytes,
            file.mtimeMs,
            unavailable?.id ?? post?.id ?? null,
            unavailable?.reason ?? null,
            Date.now(),
            id,
          );
      })();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "request_failed";
      if (gen !== this.generation || this.closed) {if(['rate_limit','access_restricted'].includes(reason))this.pause(reason);return;}
      this.c.db
        .prepare(
          "UPDATE danbooru_jobs SET status='error',error=?,updated_at=? WHERE file_id=?",
        )
        .run(reason.slice(0, 200), Date.now(), id);
      this.pause(reason);
    } finally {
      this.abort = null;
    }
  }
  async close() {
    this.closed = true;
    this.generation++;
    this.pause("shutdown");
    this.abort?.abort();
    await this.active;
    this.c.db
      .prepare(
        "UPDATE danbooru_jobs SET status='waiting' WHERE status='running'",
      )
      .run();
  }
}
