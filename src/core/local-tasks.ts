import {isExcludedImagePath} from "./directory-policy.js";
import { watch, lstatSync, type FSWatcher } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Catalog } from "./catalog.js";
import type { Scanner } from "./filesystem.js";
import { ALGORITHM_VERSION, type ImageProcessor } from "./images.js";
import type { ScanResult } from "../contracts.js";
import path from "node:path";
import { isDataPath } from "./data-path.js";

export type { LocalTaskKind, LocalTaskStatus } from "../contracts.js";
import type { LocalTaskKind, LocalTaskStatus } from "../contracts.js";
type DurableState = Omit<LocalTaskStatus, "images" | "running">;
export class LocalTasks {
  private state: DurableState;
  private worker: Promise<void> | null = null;
  private closed = false;
  private generation=0;
  async cancel() {
    this.generation++;
    const roots=new Set([...this.state.pendingRoots,...(this.state.activeRoot?[this.state.activeRoot]:[])]);
    const cancelled=this.status().images.pending+roots.size;
    this.state.scanPaused=true;this.state.imagesPaused=true;
    this.state.pendingRoots=[];
    for(const rootId of roots)this.catalog.db.prepare("INSERT OR IGNORE INTO local_cancelled_roots VALUES(?)").run(rootId);
    this.controller.abort();
    this.catalog.db.prepare("INSERT OR REPLACE INTO local_cancelled_images SELECT id,bytes,mtime_ms FROM files_visible WHERE missing=0 AND processing_error IS NULL AND ((thumbnail_key IS NULL AND cache_evicted=0) OR feature_version IS NULL OR feature_version<>?)").run(ALGORITHM_VERSION);
    for(const list of this.waiters.values())for(const waiter of list)waiter.reject(new Error('LOCAL_TASK_CANCELLED'));
    this.waiters.clear();this.emit();
    await this.worker;
    this.state.pendingRoots=[];this.emit();
    return {cancelled};
  }
  private held = false;
  private controller = new AbortController();
  private watchers: FSWatcher[] = [];
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private waiters = new Map<
    string,
    Array<{
      resolve: (value: ScanResult) => void;
      reject: (error: Error) => void;
    }>
  >();
  constructor(
    private catalog: Catalog,
    private scanner: Scanner,
    private images: ImageProcessor,
    private onProgress?: (status: LocalTaskStatus) => void,
  ) {
    catalog.db.exec(
      "CREATE TABLE IF NOT EXISTS local_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    const saved = catalog.db
      .prepare("SELECT value FROM local_state WHERE key='tasks'")
      .get() as { value: string } | undefined;
    this.state = saved
      ? JSON.parse(saved.value)
      : {
          scanPaused: false,
          imagesPaused: true,
          pendingRoots: [],
          activeRoot: null,
          discovered: 0,
          added: 0,
          changed: 0,
          processed: 0,
          failed: 0,
          lastScan: null,
          lastError: null,
        };
    if (
      this.state.activeRoot &&
      !this.state.pendingRoots.includes(this.state.activeRoot)
    )
      this.state.pendingRoots.unshift(this.state.activeRoot);
    this.state.activeRoot = null;
    this.save();
  }
  private save() {
    this.catalog.db
      .prepare(
        "INSERT INTO local_state(key,value) VALUES('tasks',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(this.state));
  }
  private emit() {
    this.save();
    try {
      this.onProgress?.(this.status());
    } catch {
      /* Progress listeners cannot stop durable work. */
    }
  }
  status(): LocalTaskStatus {
    const counts = this.catalog.db
      .prepare(
        `SELECT SUM(CASE WHEN missing=0 AND processing_error IS NULL AND NOT EXISTS(SELECT 1 FROM local_cancelled_images x WHERE x.file_id=files.id AND x.bytes=files.bytes AND x.mtime_ms=files.mtime_ms) AND ((thumbnail_key IS NULL AND cache_evicted=0) OR feature_version IS NULL OR feature_version<>?) THEN 1 ELSE 0 END) pending,SUM(CASE WHEN thumbnail_key IS NOT NULL AND feature_version=? THEN 1 ELSE 0 END) ready,SUM(CASE WHEN processing_error IS NOT NULL THEN 1 ELSE 0 END) failed FROM files_visible files`,
      )
      .get(ALGORITHM_VERSION, ALGORITHM_VERSION) as {
      pending: number;
      ready: number;
      failed: number;
    };
    return {
      ...this.state,
      pendingRoots: [...this.state.pendingRoots],
      running: !!this.worker,
      images: {
        pending: counts.pending ?? 0,
        ready: counts.ready ?? 0,
        failed: counts.failed ?? 0,
      },
    };
  }
  async start(options: { watch?: boolean } = {}): Promise<void> {
    if (this.closed) throw new Error("Local tasks closed");
    for (const root of this.catalog.roots()) this.enqueue(root.id);
    if (options.watch !== false) this.refreshWatchers();
    this.kick();
    // Background start is nonblocking; callers can display status during reconciliation.
  }
  private enqueue(rootId: string) {
    if(this.catalog.db.prepare("SELECT 1 FROM local_cancelled_roots WHERE root_id=?").get(rootId))return;
    if (!this.state.pendingRoots.includes(rootId))
      this.state.pendingRoots.push(rootId);
    this.emit();
  }
  private refreshWatchers() {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const root of this.catalog.roots())
      try {
        const watcher = watch(root.path, { recursive: true }, (_event, filename) => {
          // Database/WAL/cache writes must not trigger a reconciliation loop.
          if(filename&&isExcludedImagePath(String(filename)))return;
          if(filename&&path.basename(String(filename)).startsWith(".")){try{if(lstatSync(path.join(root.path,String(filename))).isDirectory())return;}catch{}}
          if (filename && this.catalog.isManagedPath(path.join(root.path, String(filename)))) return;
          const previous = this.debounce.get(root.id);
          if (previous) clearTimeout(previous);
          const timer = setTimeout(() => {
            this.debounce.delete(root.id);
            if (!this.closed) {
              this.enqueue(root.id);
              this.kick();
            }
          }, 750);
          timer.unref();
          this.debounce.set(root.id, timer);
        });
        watcher.on("error", () => {
          if (!this.closed) {
            this.enqueue(root.id);
            this.kick();
          }
        });
        this.watchers.push(watcher);
      } catch {
        /* Offline roots are reconciled on startup and manual scans. */
      }
  }
  pause(kind: LocalTaskKind) {
    if (kind === "scan") this.state.scanPaused = true;
    else this.state.imagesPaused = true;
    this.controller.abort();
    this.emit();
    return this.status();
  }
  resume(kind: LocalTaskKind) {
    if (this.closed) throw new Error("Local tasks closed");
    if (kind === "scan") this.state.scanPaused = false;
    else this.state.imagesPaused = false;
    this.emit();
    this.kick();
    return this.status();
  }
  scan(
    rootId: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ScanResult> {
    if (this.closed) return Promise.reject(new Error("Local tasks closed"));
    this.catalog.getRoot(rootId);
    this.catalog.db.prepare("DELETE FROM local_cancelled_roots WHERE root_id=?").run(rootId);
    this.catalog.db.prepare("DELETE FROM local_cancelled_images WHERE file_id IN (SELECT id FROM files_visible WHERE root_id=?)").run(rootId);
    // Manual bounded acceptance scans are serialized with the same owning worker.
    if (options.limit !== undefined) return this.boundedScan(rootId, options);
    const result = new Promise<ScanResult>((resolve, reject) => {
      const current = this.waiters.get(rootId) ?? [];
      current.push({ resolve, reject });
      this.waiters.set(rootId, current);
    });
    this.enqueue(rootId);
    this.state.scanPaused = false;
    this.kick();
    return result;
  }
  private async boundedScan(
    rootId: string,
    options: { limit?: number; signal?: AbortSignal },
  ): Promise<ScanResult> {
    return this.exclusive(async () => {
      const result = await this.scanner.scan(rootId, options);
      this.recordScan(result);
      return result;
    });
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Local tasks closed");
    if (this.held) throw new Error("Local task operation already active");
    this.held = true;
    this.controller.abort();
    await this.worker;
    try {
      return await operation();
    } finally {
      this.held = false;
      if (!this.closed) {
        this.emit();
        this.kick();
      }
    }
  }
  retry(fileIds?: string[]) {
    let rebuilt=0;
    if(fileIds)for(const id of fileIds)rebuilt+=this.catalog.db.prepare("DELETE FROM local_cancelled_images WHERE file_id=?").run(id).changes;
    else rebuilt=this.catalog.db.prepare("DELETE FROM local_cancelled_images").run().changes;
    const retried = this.images.retryFailed(fileIds)+rebuilt;
    this.emit();
    this.kick();
    return { retried, status: this.status() };
  }
  private recordScan(result: ScanResult) {
    this.state.scanProgress = null;
    this.state.lastScan = result;
    this.state.discovered += result.discovered;
    this.state.added += result.added;
    this.state.changed += result.changed;
    this.state.lastError = result.errors[0] ?? null;
    this.emit();
  }
  private kick() {
    if (this.closed || this.held || this.worker) return;
    this.worker = this.run().finally(() => {
      this.worker = null;
      if (
        !this.closed &&
        this.state.pendingRoots.length &&
        !this.state.scanPaused
      )
        this.kick();
    });
  }
  private async run() {
    while (!this.closed && !this.held) {
      this.controller = new AbortController();
      const rootId = !this.state.scanPaused
        ? this.state.pendingRoots.shift()
        : undefined;
      if (rootId) {
        const generation=this.generation;
        this.state.activeRoot = rootId;
        this.emit();
        try {
          const result = await this.scanner.scan(rootId, {
            signal: this.controller.signal,
            onProgress: (progress) => {
              this.state.scanProgress = progress;
              this.emit();
            },
          });
          this.recordScan(result);
          if (this.controller.signal.aborted && generation===this.generation) this.enqueue(rootId);
          else {
            for (const waiter of this.waiters.get(rootId) ?? [])
              waiter.resolve(result);
            this.waiters.delete(rootId);
          }
        } catch (error) {
          this.state.lastError = String(error);
          for (const waiter of this.waiters.get(rootId) ?? [])
            waiter.reject(new Error(String(error)));
          this.waiters.delete(rootId);
        } finally {
          this.state.activeRoot = null;
          this.emit();
        }
        await yieldTurn();
        continue;
      }
      if (this.state.imagesPaused) break;
      const batch = await this.images.processPending({
        limit: 25,
        signal: this.controller.signal,
      });
      if (
        this.catalog.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='settings'")
          .get()
      ) {
        const cap = this.catalog.db
          .prepare("SELECT value FROM settings WHERE key='cacheLimitBytes'")
          .get() as { value: string } | undefined;
        await this.images.trimCache(cap ? Number(cap.value) : 5 * 1024 ** 3);
      }
      this.state.processed += batch.processed;
      this.state.failed += batch.failed;
      this.emit();
      if (!batch.processed && !batch.failed) break;
      await yieldTurn();
    }
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    for (const watcher of this.watchers) watcher.close();
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    await this.worker;
    for (const waiters of this.waiters.values())
      for (const waiter of waiters)
        waiter.reject(new Error("Local tasks closed"));
    this.waiters.clear();
    this.save();
  }
}
