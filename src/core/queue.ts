import { randomUUID } from "node:crypto";
import type { Catalog } from "./catalog.js";
import type { JobItem } from "../contracts.js";
import { fetchArtwork, SourceError, type Fetcher } from "./pixiv.js";
import {
  DEFAULT_PIXIV_QUEUE_SETTINGS,
  validatePixivQueueSettings,
  type PixivQueueSettings,
} from "./queue-settings.js";
import { pixivBatchSelection } from "./pixiv-batch.js";
import type {
  PixivBatchScope,
  PixivBatchPreview,
  PixivBatchResult,
} from "./pixiv-batch-contracts.js";
export class PixivQueue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<boolean> | undefined;
  private stopped = true;
  private closed = false;
  private generation = 0;
  async cancel() {
    this.generation++;
    const reason=this.sourceState().reason;
    this.pause();
    if(reason && !['user','shutdown','restart','completed','not_started','batch_rest'].includes(reason))this.catalog.db.prepare("UPDATE source_state SET reason=? WHERE source='pixiv'").run(reason);
    else this.catalog.db.prepare("UPDATE source_state SET reason='cancelled' WHERE source='pixiv'").run();
    const cancelled=this.catalog.db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE status IN ('waiting','retry_wait','running')").run(this.now()).changes;
    await this.active;
    return {cancelled};
  }
  constructor(
    private catalog: Catalog,
    private options: {
      fetcher?: Fetcher;
      intervalMs?: number;
      jitterMs?: number;
      now?: () => number;
      random?: () => number;
    } = {},
  ) {
    const columns = catalog.db
      .prepare("PRAGMA table_info(source_state)")
      .all() as { name: string }[];
    if (!columns.some((c) => c.name === "batch_used"))
      catalog.db.exec(
        "ALTER TABLE source_state ADD COLUMN batch_used INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.some((c) => c.name === "settings_json"))
      catalog.db.exec("ALTER TABLE source_state ADD COLUMN settings_json TEXT");
    if (!columns.some((c) => c.name === "rest_until"))
      catalog.db.exec(
        "ALTER TABLE source_state ADD COLUMN rest_until INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.some(c => c.name === "scope_json")) catalog.db.exec("ALTER TABLE source_state ADD COLUMN scope_json TEXT");
    catalog.db
      .prepare("UPDATE jobs SET status='waiting' WHERE status='running'")
      .run();
    catalog.db
      .prepare(
        "INSERT OR IGNORE INTO source_state(source,paused,pause_until,reason) VALUES('pixiv',1,0,'not_started')",
      )
      .run();
  }
  runScope(): PixivBatchScope | null {
    const row = this.catalog.db.prepare("SELECT scope_json FROM source_state WHERE source='pixiv'").get() as { scope_json: string | null };
    return row.scope_json ? JSON.parse(row.scope_json) : null;
  }
  setRunScope(scope: PixivBatchScope | null) {
    if (this.active) throw new Error("Wait for the active source request before changing scope");
    const normalized = scope ? this.previewScope(scope).scope : null;
    this.pause();
    this.catalog.db.prepare("UPDATE source_state SET scope_json=? WHERE source='pixiv'").run(normalized ? JSON.stringify(normalized) : null);
    return this.runScope();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private random() {
    return this.options.random?.() ?? Math.random();
  }
  settings(): PixivQueueSettings {
    const row = this.catalog.db
      .prepare("SELECT settings_json FROM source_state WHERE source='pixiv'")
      .get() as { settings_json: string | null };
    if (!row.settings_json) return { ...DEFAULT_PIXIV_QUEUE_SETTINGS };
    const settings: unknown = JSON.parse(row.settings_json);
    validatePixivQueueSettings(settings);
    return settings;
  }
  configure(settings: PixivQueueSettings) {
    validatePixivQueueSettings(settings);
    this.catalog.db
      .prepare("UPDATE source_state SET settings_json=? WHERE source='pixiv'")
      .run(JSON.stringify(settings));
    // A saved deadline is an existing commitment; editing settings never shortens it.
    if (!settings.autoRest)
      this.catalog.db
        .prepare(
          "UPDATE source_state SET reason='batch_limit' WHERE source='pixiv' AND reason='batch_rest'",
        )
        .run();
    return this.settings();
  }
  private scopeSql() {
    const scope = this.runScope();
    const scopeArgs: (string | number)[] = [];
    let scopeFilter = "";
    if (scope) {
      this.catalog.getRoot(scope.rootId);
      const prefix = scope.relativePath ? scope.relativePath + "/" : "";
      scopeFilter = " AND EXISTS(SELECT 1 FROM files f WHERE f.artwork_id=jobs.artwork_id AND f.root_id=? AND f.missing=0 AND substr(replace(f.relative_path,char(92),'/'),1,?)=?";
      scopeArgs.push(scope.rootId, prefix.length, prefix);
      if (!scope.recursive) {
        scopeFilter += " AND instr(substr(replace(f.relative_path,char(92),'/'),?),'/')=0";
        scopeArgs.push(prefix.length + 1);
      }
      scopeFilter += ")";
    }
    return {scopeFilter, scopeArgs};
  }
  scopePending() {
    const {scopeFilter, scopeArgs} = this.scopeSql();
    return (this.catalog.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('waiting','retry_wait','running')" + scopeFilter).get(...scopeArgs) as {n: number}).n;
  }
  sourceState() {
    const row = this.catalog.db
      .prepare(
        "SELECT paused,pause_until,reason,batch_used,rest_until FROM source_state WHERE source='pixiv'",
      )
      .get() as {
      paused: number;
      pause_until: number;
      reason: string | null;
      batch_used: number;
      rest_until: number;
    };
    return {
      ...row,
      runScope: this.runScope(),
      scopePending: this.scopePending(),
      batchLimit: this.settings().batchLimit,
      settings: this.settings(),
    };
  }
  private protectedPause(reason: string | null) {
    return (
      !!reason &&
      (["needs_login", "restricted", "challenge"].includes(reason) ||
        reason.startsWith("rate_limit"))
    );
  }
  private cadence() {
    const settings = this.settings();
    const minimum =
      this.options.intervalMs ?? settings.intervalMinSeconds * 1000;
    const jitter =
      this.options.jitterMs ??
      (settings.intervalMaxSeconds - settings.intervalMinSeconds) * 1000;
    return minimum + this.random() * jitter;
  }
  private enforceBatchLimit() {
    const state = this.sourceState();
    if (state.batch_used < state.batchLimit || state.paused) return;
    if (state.settings.autoRest) {
      this.catalog.db
        .prepare(
          "UPDATE source_state SET paused=1,reason='batch_rest',rest_until=MAX(rest_until,?) WHERE source='pixiv'",
        )
        .run(this.now() + state.settings.restMinutes * 60000);
    } else {
      this.catalog.db
        .prepare(
          "UPDATE source_state SET paused=1,reason='batch_limit' WHERE source='pixiv'",
        )
        .run();
    }
  }
  private completeRest() {
    const state = this.sourceState();
    if (
      state.reason !== "batch_rest" ||
      !state.settings.autoRest ||
      state.rest_until > this.now()
    )
      return;
    this.catalog.db
      .prepare(
        "UPDATE source_state SET paused=0,reason=NULL,rest_until=0,batch_used=0 WHERE source='pixiv' AND reason='batch_rest'",
      )
      .run();
  }
  enqueue(ids: string[], priority = 0, rebuildCancelled=false): number {
    let count = 0;
    const stmt = this.catalog.db.prepare(
      "INSERT OR IGNORE INTO jobs(id,artwork_id,status,attempts,priority,next_run_at,last_error,updated_at) VALUES(?,?,'waiting',0,?,0,NULL,?)",
    );
    const raise = this.catalog.db.prepare(
      "UPDATE jobs SET priority=MAX(priority,?) WHERE artwork_id=? AND status IN ('waiting','retry_wait')",
    );
    this.catalog.db.transaction(() => {
      for (const id of new Set(ids)) {
        if (!/^[1-9]\d{4,11}$/.test(id)) throw new Error("Invalid artwork ID");
        count += stmt.run(randomUUID(), id, priority, this.now()).changes;
        if(rebuildCancelled)count+=this.catalog.db.prepare("UPDATE jobs SET status='waiting',last_error=NULL,updated_at=? WHERE artwork_id=? AND status='cancelled'").run(this.now(),id).changes;
        raise.run(priority, id);
      }
    })();
    return count;
  }
  previewScope(scope: PixivBatchScope): PixivBatchPreview {
    return pixivBatchSelection(this.catalog, scope).preview;
  }
  enqueueScope(
    scope: PixivBatchScope,
    previewToken: string,
    start = false,
  ): PixivBatchResult {
    if (start && this.protectedPause(this.sourceState().reason))
      throw new Error(
        "来源保护已暂停队列，请先在后台任务检查原因并手动继续。 ",
      );
    if (start && this.sourceState().batch_used >= this.sourceState().batchLimit)
      throw new Error("本批请求额度已用完，请在后台任务点击继续下一批。");
    const result = this.catalog.db.transaction(() => {
      const selection = pixivBatchSelection(this.catalog, scope);
      if (selection.preview.previewToken !== previewToken)
        throw new Error("补全范围或队列状态已经变化，请重新预览。");
      if (
        start &&
        selection.preview.eligibleArtworkCount +
          selection.preview.queuedArtworkCount ===
          0
      )
        throw new Error("当前范围没有可开始的作品，请重新选择或预览。");
      this.setRunScope(scope);
      let enqueued = 0,
        requeued = 0;
      const insert = this.catalog.db.prepare(
        "INSERT INTO jobs(id,artwork_id,status,attempts,priority,next_run_at,last_error,updated_at) VALUES(?,?,'waiting',0,0,0,NULL,?)",
      );
      const reset = this.catalog.db.prepare(
        "UPDATE jobs SET status='waiting',attempts=0,next_run_at=0,last_error=NULL,updated_at=? WHERE id=? AND status NOT IN ('running','waiting','retry_wait','unavailable')",
      );
      for (const artwork of selection.artworks) {
        if (artwork.jobId)
          requeued += reset.run(this.now(), artwork.jobId).changes;
        else
          enqueued += insert.run(
            randomUUID(),
            artwork.artworkId,
            this.now(),
          ).changes;
      }
      return {
        enqueued,
        requeued,
        queuedArtworkCount: enqueued + requeued,
        queuedFileCount: selection.preview.eligibleFileCount,
        paused: !start,
        preview: selection.preview,
      };
    })();
    if (start) this.resume();
    else this.pause();
    return { ...result, paused: !!this.sourceState().paused };
  }
  list(
    options: {
      offset?: number;
      limit?: number;
      statuses?: string[];
      artworkId?: string;
    } = {},
  ): JobItem[] {
    return this.listPage(options).items;
  }
  listPage(
    options: {
      offset?: number;
      limit?: number;
      statuses?: string[];
      artworkId?: string;
    } = {},
  ) {
    const offset = Math.max(0, Math.floor(options.offset ?? 0)),
      limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
    const statuses = options.statuses ?? [];
    let where = statuses.length
      ? " WHERE status IN (" + statuses.map(() => "?").join(",") + ")"
      : "";
    const parameters: (string | number)[] = [...statuses];
    if (options.artworkId) {
      if (!/^\d{1,12}$/.test(options.artworkId))
        throw new Error("Invalid artwork ID prefix");
      where += (where ? " AND " : " WHERE ") + "artwork_id LIKE ?";
      parameters.push(options.artworkId + "%");
    }
    const items = this.catalog.db
      .prepare(
        "SELECT id,artwork_id artworkId,status,attempts,priority,next_run_at nextRunAt,last_error lastError FROM jobs" +
          where +
          " ORDER BY priority DESC,updated_at,id LIMIT ? OFFSET ?",
      )
      .all(...parameters, limit, offset) as JobItem[];
    const metadata = this.catalog.db.prepare(
      "SELECT a.title,c.name creatorName FROM artworks a LEFT JOIN creators c ON c.id=a.creator_id WHERE a.id=?",
    );
    const thumbnail = this.catalog.db.prepare(
      "SELECT id FROM files WHERE artwork_id=? AND thumbnail_key IS NOT NULL AND missing=0 LIMIT 1",
    );
    for (const item of items) {
      Object.assign(item, metadata.get(item.artworkId) ?? {});
      const file = thumbnail.get(item.artworkId) as { id: string } | undefined;
      item.thumbnailUrl = file
        ? `image-finder://image/${encodeURIComponent(file.id)}?variant=thumbnail`
        : null;
    }
    const total = (
      this.catalog.db
        .prepare("SELECT COUNT(*) n FROM jobs" + where)
        .get(...parameters) as { n: number }
    ).n;
    const counts = Object.fromEntries(
      (
        this.catalog.db
          .prepare("SELECT status,COUNT(*) count FROM jobs GROUP BY status")
          .all() as { status: string; count: number }[]
      ).map((row) => [row.status, row.count]),
    );
    return {
      items,
      total,
      allTotal: Object.values(counts).reduce((sum, n) => sum + n, 0),
      offset,
      limit,
      counts,
    };
  }
  start() {
    if (this.closed) return;
    const state = this.catalog.db
      .prepare("SELECT paused,reason FROM source_state WHERE source='pixiv'")
      .get() as any;
    if (
      (state.paused && state.reason !== "batch_rest") ||
      state.reason === "not_started"
    )
      return;
    this.stopped = false;
    this.schedule();
  }
  private schedule() {
    if (this.stopped || this.closed || this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.tick().finally(() => this.schedule());
      },
      Math.min(this.options.intervalMs ?? 1000, 1000),
    );
    this.timer.unref();
  }
  pause() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.catalog.db
      .prepare(
        "UPDATE source_state SET paused=1,reason=CASE WHEN reason IN ('needs_login','restricted','challenge') OR reason LIKE 'rate_limit%' THEN reason ELSE 'user' END WHERE source='pixiv'",
      )
      .run();
  }
  resume(nextBatch = false) {
    const state = this.sourceState();
    // Even an explicit next-batch action cannot erase a saved rest deadline.
    if (state.rest_until > this.now()) {
      this.catalog.db
        .prepare(
          "UPDATE source_state SET paused=1,reason=? WHERE source='pixiv'",
        )
        .run(state.settings.autoRest ? "batch_rest" : "batch_limit");
      this.start();
      return;
    }
    if (state.batch_used >= state.batchLimit) {
      if (!nextBatch) throw new Error("本批请求额度已用完，请点击继续下一批。");
      this.catalog.db
        .prepare("UPDATE source_state SET batch_used=0 WHERE source='pixiv'")
        .run();
    }
    this.catalog.db
      .prepare(
        "UPDATE source_state SET paused=0,reason=NULL,rest_until=0 WHERE source='pixiv'",
      )
      .run();
    this.start();
  }
  retry(ids?: string[]) {
    const stmt = this.catalog.db.prepare(
      "UPDATE jobs SET status='waiting',attempts=0,next_run_at=0,last_error=NULL WHERE id=? AND status!='running'",
    );
    if (ids) for (const id of ids) stmt.run(id);
    else
      this.catalog.db
        .prepare(
          "UPDATE jobs SET status='waiting',attempts=0,next_run_at=0,last_error=NULL WHERE status IN ('failed','needs_login','retry_wait')",
        )
        .run();
  }
  async close() {
    this.closed = true;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }
  tick(): Promise<boolean> {
    if (this.active) return this.active;
    if (this.closed) return Promise.resolve(false);
    this.active = this.execute().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async execute(): Promise<boolean> {
    const generation=this.generation;
    const db = this.catalog.db,
      now = this.now();
    this.completeRest();
    this.enforceBatchLimit();
    const state = db
      .prepare("SELECT * FROM source_state WHERE source='pixiv'")
      .get() as any;
    if (state.paused || state.pause_until > now) return false;
    const {scopeFilter, scopeArgs} = this.scopeSql();
    const job = db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('waiting','retry_wait') AND next_run_at<=?" + scopeFilter + " ORDER BY priority DESC,updated_at,id LIMIT 1",
      )
      .get(now, ...scopeArgs) as any;
    if (!job) return false;
    db.prepare(
      "UPDATE source_state SET batch_used=batch_used+1,pause_until=? WHERE source='pixiv'",
    ).run(now + this.cadence());
    db.prepare(
      "UPDATE jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?",
    ).run(now, job.id);
    try {
      const payload = await fetchArtwork(job.artwork_id, this.options.fetcher);
      if(generation!==this.generation)return true;
      const bad = db
        .prepare("SELECT 1 FROM files WHERE artwork_id=? AND page>=? LIMIT 1")
        .get(payload.id, payload.pageCount);
      if (bad)
        throw new SourceError(
          "invalid_response",
          "Local page exceeds source page count",
        );
      db.transaction(() => {
        this.catalog.applyArtwork(payload);
        db.prepare(
          "UPDATE source_state SET reason=CASE WHEN paused=1 THEN reason ELSE NULL END,pause_until=MAX(pause_until,?) WHERE source='pixiv'",
        ).run(this.now() + this.cadence());
        db.prepare(
          "UPDATE jobs SET status='done',last_error=NULL,updated_at=? WHERE id=?",
        ).run(this.now(), job.id);
      })();
    } catch (error) {
      const e =
        error instanceof SourceError
          ? error
          : new SourceError("invalid_response", String(error));
      if(generation!==this.generation){
        if(['rate_limit','needs_login','restricted','challenge'].includes(e.code))db.prepare("UPDATE source_state SET paused=1,reason=?,pause_until=MAX(pause_until,?) WHERE source='pixiv'").run(e.code,this.now()+Math.max(e.retryAfterMs,e.code==='rate_limit'?900000:0));
        return true;
      }
      const attempts = job.attempts + 1;
      const delay =
        Math.max(
          e.retryAfterMs,
          e.code === "rate_limit" ? 900000 : 0,
          Math.min(3600000, 5000 * 2 ** Math.min(attempts, 9)),
        ) +
        this.random() * (this.options.jitterMs ?? 1000);
      let status = "retry_wait";
      if (e.code === "needs_login") status = "needs_login";
      else if (e.code === "restricted" || e.code === "unavailable")
        status = "unavailable";
      else if (e.code === "invalid_response" || attempts >= 8)
        status = "failed";
      db.transaction(() => {
        db.prepare(
          "UPDATE source_state SET pause_until=MAX(pause_until,?) WHERE source='pixiv'",
        ).run(this.now() + this.cadence());
        db.prepare(
          "UPDATE jobs SET status=?,next_run_at=?,last_error=?,updated_at=? WHERE id=?",
        ).run(
          status,
          this.now() + delay,
          `${e.code}: ${e.message}`,
          this.now(),
          job.id,
        );
        if (["needs_login", "restricted", "challenge"].includes(e.code))
          db.prepare(
            "UPDATE source_state SET paused=1,reason=? WHERE source='pixiv'",
          ).run(e.code);
        if (e.code === "rate_limit")
          db.prepare(
            "UPDATE source_state SET pause_until=MAX(pause_until,?),paused=1,reason='rate_limit' WHERE source='pixiv'",
          ).run(this.now() + delay);
      })();
    }
    this.enforceBatchLimit();
    return true;
  }
}
