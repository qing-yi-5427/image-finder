import type { Catalog } from "./catalog.js";
import type { ScanResult } from "../contracts.js";
import { stat } from "node:fs/promises";
export const AUTO_NEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS auto_new_roots(root_id TEXT PRIMARY KEY REFERENCES roots(id) ON DELETE CASCADE,baseline_complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auto_new_images(file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,status TEXT NOT NULL,bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL,stable_since INTEGER NOT NULL,next_check_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT);
CREATE INDEX IF NOT EXISTS auto_new_images_ready ON auto_new_images(status,next_check_at);`;
/** Only identities first discovered after a root's baseline enter this durable, bounded queue. */
export class AutoNewImages {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private closed = false;
  private reconciled = new Map<string, number>();
  constructor(
    private c: Catalog,
    private options: {
      prepare: (id: string) => Promise<void>;
      enqueue: (id: string) => void;
      canProcess: () => boolean;
      reconcile: (rootId: string) => void;
      now?: () => number;
      settleMs?: number;
      startTimer?: boolean;
    },
  ) {
    c.db.exec(
      "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    c.db
      .prepare(
        "INSERT OR IGNORE INTO auto_new_roots SELECT r.id,CASE WHEN (r.last_scan_at IS NOT NULL AND r.status='online') OR EXISTS(SELECT 1 FROM files f WHERE f.root_id=r.id) THEN 1 ELSE 0 END FROM roots r",
      )
      .run();
    if (options.startTimer !== false) {
      this.timer = setInterval(() => {
        void this.tick().catch((error) => {
          try {
            this.c.db
              .prepare(
                "INSERT INTO settings VALUES('autoProcessLastError',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              )
              .run(String(error).slice(0, 2000));
          } catch {}
        });
      }, 1000);
      this.timer.unref();
    }
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  enabled() {
    return (
      (
        this.c.db
          .prepare(
            "SELECT value FROM settings WHERE key='autoProcessNewImages'",
          )
          .get() as any
      )?.value !== "false"
    );
  }
  setEnabled(enabled: boolean) {
    this.c.db
      .prepare(
        "INSERT INTO settings VALUES('autoProcessNewImages',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(enabled));
    if (!enabled)
      this.c.db
        .prepare(
          "UPDATE auto_new_images SET status='ignored' WHERE status IN ('waiting','failed','missing')",
        )
        .run();
  }
  observed(
    rootId: string,
    fileId: string,
    isNew: boolean,
    bytes: number,
    mtimeMs: number,
  ) {
    this.c.db
      .prepare("INSERT OR IGNORE INTO auto_new_roots VALUES(?,0)")
      .run(rootId);
    const baseline = (
      this.c.db
        .prepare(
          "SELECT baseline_complete n FROM auto_new_roots WHERE root_id=?",
        )
        .get(rootId) as any
    ).n;
    if (isNew && baseline && this.enabled()) this.register([fileId]);
    else
      this.c.db
        .prepare(
          "UPDATE auto_new_images SET status='waiting',bytes=?,mtime_ms=?,stable_since=?,next_check_at=?,attempts=0,error=NULL WHERE file_id=? AND status IN ('waiting','failed') AND (bytes<>? OR mtime_ms<>?)",
        )
        .run(
          bytes,
          mtimeMs,
          this.now(),
          this.now() + (this.options.settleMs ?? 2000),
          fileId,
          bytes,
          mtimeMs,
        );
  }
  scanned(rootId: string, result: ScanResult) {
    if (result.complete)
      this.c.db
        .prepare(
          "INSERT INTO auto_new_roots VALUES(?,1) ON CONFLICT(root_id) DO UPDATE SET baseline_complete=1",
        )
        .run(rootId);
  }
  register(fileIds: string[]) {
    if (!this.enabled()) return { added: 0 };
    let added = 0;
    const now = this.now();
    this.c.db.transaction(() => {
      for (const id of new Set(fileIds)) {
        const f = this.c.getFile(id);
        if (f.missing) continue;
        added += this.c.db
          .prepare(
            "INSERT OR IGNORE INTO auto_new_images(file_id,status,bytes,mtime_ms,stable_since,next_check_at) VALUES(?,'waiting',?,?,?,?)",
          )
          .run(
            id,
            f.bytes,
            f.mtimeMs,
            now,
            now + (this.options.settleMs ?? 2000),
          ).changes;
      }
    })();
    return { added };
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    const task = this.run().finally(() => {
      if (this.active === task) this.active = null;
    });
    this.active = task;
    return task;
  }
  private cancelled(row: { file_id: string; bytes: number; mtime_ms: number }) {
    if (
      !this.c.db
        .prepare(
          "SELECT 1 FROM local_cancelled_images WHERE file_id=? AND bytes=? AND mtime_ms=?",
        )
        .get(row.file_id, row.bytes, row.mtime_ms)
    )
      return false;
    this.c.db
      .prepare(
        "UPDATE auto_new_images SET status='ignored' WHERE file_id=? AND bytes=? AND mtime_ms=?",
      )
      .run(row.file_id, row.bytes, row.mtime_ms);
    return true;
  }
  private async run() {
    if (this.closed || !this.enabled() || !this.options.canProcess()) return;
    const rows = this.c.db
      .prepare(
        "SELECT * FROM auto_new_images WHERE status='waiting' AND next_check_at<=? ORDER BY next_check_at,file_id LIMIT 8",
      )
      .all(this.now()) as any[];
    for (const row of rows) {
      if (this.closed || !this.enabled() || !this.options.canProcess()) break;
      try {
        if (this.cancelled(row)) continue;
        if (this.now() - row.stable_since < (this.options.settleMs ?? 2000)) {
          this.c.db
            .prepare(
              "UPDATE auto_new_images SET next_check_at=? WHERE file_id=?",
            )
            .run(
              row.stable_since + (this.options.settleMs ?? 2000),
              row.file_id,
            );
          continue;
        }
        const file = this.c.getFile(row.file_id);
        if (file.missing) {
          this.c.db
            .prepare(
              "UPDATE auto_new_images SET status='missing' WHERE file_id=?",
            )
            .run(file.id);
          continue;
        }
        const actual = await stat(await this.c.resolveOriginal(file.id));
        if (actual.size !== row.bytes || actual.mtimeMs !== row.mtime_ms)
          throw new Error("等待目录重新确认文件写入");
        if (this.closed || !this.enabled() || !this.options.canProcess()) break;
        await this.options.prepare(file.id);
        if (this.cancelled(row)) continue;
        const current = this.c.getFile(file.id);
        const after = await stat(await this.c.resolveOriginal(file.id));
        if (
          current.bytes !== file.bytes ||
          current.mtimeMs !== file.mtimeMs ||
          after.size !== actual.size ||
          after.mtimeMs !== actual.mtimeMs ||
          after.ino !== actual.ino
        )
          throw new Error("新增图片在准备后发生变化，等待重新扫描");
        if (this.closed || !this.enabled()) break;
        this.c.db.transaction(() => {
          this.options.enqueue(file.id);
          this.c.db
            .prepare(
              "UPDATE auto_new_images SET status='enqueued',error=NULL WHERE file_id=?",
            )
            .run(file.id);
        })();
      } catch (error) {
        if (this.cancelled(row)) continue;
        const file = this.c.db
          .prepare("SELECT root_id rootId FROM files WHERE id=?")
          .get(row.file_id) as { rootId: string } | undefined;
        if (!file) continue;
        const now = this.now();
        if (
          /rescan required|等待目录重新确认|新增图片在准备后发生变化/.test(
            String(error),
          ) &&
          now - (this.reconciled.get(file.rootId) ?? 0) >= 30000
        ) {
          this.reconciled.set(file.rootId, now);
          this.options.reconcile(file.rootId);
        }
        const attempts = row.attempts + 1;
        this.c.db
          .prepare(
            "UPDATE auto_new_images SET attempts=?,error=?,status=?,next_check_at=? WHERE file_id=? AND status='waiting'",
          )
          .run(
            attempts,
            String(error),
            attempts >= 5 ? "failed" : "waiting",
            now + Math.min(30000, 2000 * 2 ** attempts),
            row.file_id,
          );
        if (attempts >= 5)
          this.c.db
            .prepare(
              "UPDATE files SET processing_error=? WHERE id=? AND bytes=? AND mtime_ms=?",
            )
            .run(
              "自动处理新增图片失败：" + String(error),
              row.file_id,
              row.bytes,
              row.mtime_ms,
            );
      }
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
