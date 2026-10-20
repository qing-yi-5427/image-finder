import {ThumbnailCache} from "./thumbnail-cache.js";
import { taskOverview } from "./task-overview.js";
import { DanbooruQueue, type DanbooruReply } from "./danbooru.js";
import path from "node:path";
import { SauceQueue, type SauceReply } from "./sauce.js";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { Catalog } from "./catalog.js";
import { Scanner } from "./filesystem.js";
import { ImageProcessor } from "./images.js";
import { PixivQueue } from "./queue.js";
import { LocalTasks } from "./local-tasks.js";
import { LocalAi } from "./ai.js";
import type { Fetcher } from "./pixiv.js";
import { validateInvocation } from "../bridge.js";
import { directories } from "./directories.js";

/** Lives exclusively in the service process. The renderer receives DTOs only. */
export class ImageFinderService {
  readonly catalog: Catalog;
  readonly cache: ThumbnailCache;
  readonly scanner: Scanner;
  readonly images: ImageProcessor;
  queue: PixivQueue;
  local: LocalTasks;
  ai: LocalAi;
  sauce: SauceQueue;
  danbooru: DanbooruQueue;
  private closing = false;
  private thumbnailTasks = new Map<string, Promise<{ path: string }>>();
  private cancellation = new AbortController();
  private localCancellation = new AbortController();
  private pending = new Set<Promise<any>>();
  private localTail: Promise<unknown> = Promise.resolve();
  private activity = {
    scanningRootId: null as string | null,
    processing: false,
  };
  constructor(
    readonly dataDir: string,
    private options: {
      aiHomePreferenceFile?:string;
      cachePreferenceFile?:string;
      fetcher?: Fetcher;
      startPaused?: boolean;
      danbooruRequest?: (
        md5: string,
        signal?: AbortSignal,
      ) => Promise<DanbooruReply>;
      sauceRequest?: (preview: Uint8Array) => Promise<SauceReply>;
    } = {},
  ) {
    this.catalog = new Catalog(dataDir);
    this.cache=new ThumbnailCache(this.catalog,options.cachePreferenceFile);
    this.scanner = new Scanner(this.catalog);
    this.images = new ImageProcessor(this.catalog, dataDir);
    this.queue = new PixivQueue(this.catalog, { fetcher: options.fetcher });

    this.sauce = new SauceQueue(this.catalog, {
      request: options.sauceRequest,
      onConfirmed: (id) => {
        this.queue.enqueue([id]);
      },
    });
    this.danbooru = new DanbooruQueue(this.catalog, {
      request: options.danbooruRequest,
    });
    this.local = new LocalTasks(this.catalog, this.scanner, this.images);
    this.ai = new LocalAi(this.catalog);
    if (options.startPaused) {
      this.queue.pause();
      this.local.pause("scan");
      this.local.pause("images");
      this.ai.pause("wd");
      this.ai.pause("semantic");
    }
    this.queue.start();
    if(!options.cachePreferenceFile)void this.local.start();
    this.catalog.db.exec(
      "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
  }
  private settings() {
    const row = this.catalog.db
      .prepare("SELECT value FROM settings WHERE key='cacheLimitBytes'")
      .get() as any;
    return {
      dataDir: path.resolve(this.dataDir),
      dataDirectoryWarning:this.catalog.dataDirectoryWarning,
      cacheLimitBytes: row ? Number(row.value) : 5 * 1024 ** 3,
    };
  }
  invoke(method: string, payload: any = {}): Promise<any> {
    if (this.closing) return Promise.reject(new Error("SERVICE_CLOSING"));
    try {
      validateInvocation(method, payload, { privileged: true });
    } catch (error) {
      return Promise.reject(error);
    }
    const exclusive = [
      "cache.initialize",
      "cache.configure",
      "library.add",
      "library.remove",
      "library.relocate",
      "library.scan",
      "files.trashCommitted",
      "images.processPending",
      "system.clearCache",
      "system.backup",
      "system.export",
      "system.restore",
      "settings.update",
    ].includes(method);
    const operation = () =>
      method === "library.scan"
        ? this.execute(method, payload)
        : exclusive
          ? this.local.exclusive(() => this.execute(method, payload))
          : this.execute(method, payload);
    const work = exclusive ? this.localTail.then(operation) : operation();
    if (exclusive) this.localTail = work.catch(() => undefined);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }
  private async cachedThumbnail(
    fileId: string,
  ): Promise<{ path: string } | null> {
    const file = this.catalog.db.prepare("SELECT thumbnail_key thumbnailKey FROM files_visible WHERE id=?").get(fileId) as {thumbnailKey: string | null} | undefined;
    if (!file) throw new Error("FILE_NOT_FOUND");
    if (!file.thumbnailKey || !/^[a-f0-9]{64}\.webp$/.test(file.thumbnailKey))
      return null;
    const cached = path.join(this.catalog.cacheDirectory, file.thumbnailKey);
    try {
      return (await stat(cached)).isFile() ? { path: cached } : null;
    } catch {
      return null;
    }
  }
  private async ensureThumbnail(fileId: string): Promise<{ path: string }> {
    const cached = await this.cachedThumbnail(fileId);
    if (cached) return cached;
    const existing = this.thumbnailTasks.get(fileId);
    if (existing) return existing;
    const task = this.localTail.then(() =>
      this.local.exclusive(async () => {
        const ready = await this.cachedThumbnail(fileId);
        if (ready) return ready;
        const feature = await this.images.process(fileId);
        return {
          path: path.join(this.catalog.cacheDirectory, feature.thumbnailKey),
        };
      }),
    );
    this.localTail = task.catch(() => undefined);
    this.thumbnailTasks.set(fileId, task);
    void task
      .finally(() => this.thumbnailTasks.delete(fileId))
      .catch(() => undefined);
    return task;
  }
  private async execute(method: string, payload: any): Promise<any> {
    const c = this.catalog,
      p = payload;
    switch (method) {
      case "cache.status":return this.cache.status();
      case "cache.initialize":
      case "cache.configure": {
        const result=await this.cache.configure(p.directory,method==="cache.configure",p.configurationError);
        this.images.invalidateCacheSize();
        if(method==="cache.initialize"&&this.options.cachePreferenceFile)await this.local.start();
        return result;
      }
      case "ai.configureHome": {if(!this.options.aiHomePreferenceFile)throw new Error("AI环境位置配置不可用");return this.ai.configureHome(p.directory,this.options.aiHomePreferenceFile);}
      case "ai.prepareCleanup":return this.ai.prepareCleanup();
      case "ai.finishCleanup":return this.ai.finishCleanup();
      case "tasks.cancel":
        if(p.kind==='pixiv')return this.queue.cancel();
        if(p.kind==='wd'||p.kind==='semantic')return this.ai.cancel(p.kind);
        if(p.kind==='danbooru')return this.danbooru.cancel();
        if(p.kind==='sauce')return this.sauce.cancel();
        this.localCancellation.abort();
        const localCancelled=await this.local.cancel();
        await this.localTail;
        this.localCancellation=new AbortController();
        return localCancelled;
      case "tasks.overview":
        return taskOverview(
          c,
          Object.hasOwn(p, "scope") ? p.scope : this.queue.runScope(),
          this.queue.runScope(),
          {
            pixiv: this.queue.sourceState(),
            ai: this.ai.status(),
            danbooru: this.danbooru.status(),
            sauce: this.sauce.status(),
            local: this.local.status(),
          },
        );
      case "ai.autoEnable":
        return c.enableAutomaticTags(p);
      case "danbooru.status":
        return this.danbooru.status();
      case "danbooru.preview":
        return this.danbooru.preview(p);
      case "danbooru.enqueue":
        return this.danbooru.enqueue(p);
      case "danbooru.enqueueFile":
        return this.danbooru.enqueueFile(p.fileId);
      case "danbooru.tags":
        return this.danbooru.tags(p.fileId);
      case "danbooru.list":
        return this.danbooru.list(p.limit);
      case "danbooru.resume":
        return this.danbooru.resume();
      case "danbooru.pause":
        return this.danbooru.pause();
      case "danbooru.cancel":
        return this.danbooru.cancel();
      case "sauce.importLedger":
        return this.sauce.importLedger(p.source);
      case "sauce.status":
        return this.sauce.status();
      case "sauce.enqueue":
        return this.sauce.enqueue(p);
      case "sauce.list":
        return this.sauce.list(p.limit);
      case "sauce.pause":
        return this.sauce.pause();
      case "sauce.resume":
        return this.sauce.resume();
      case "sauce.review":
        return this.sauce.review(p);
      case "sauce.configure":
        return this.sauce.configured();

      case "library.list":
        return c.roots();
      case "library.directories":
        return directories(c, p.rootId, p.relativePath, p.offset, p.limit);
      case "library.add": {
        const s = await stat(p.directory);
        if (!s.isDirectory()) throw new Error("NOT_DIRECTORY");
        const root = c.addRoot(p.directory);
        void this.local.start();
        return root;
      }
      case "library.remove": {
        c.removeRoot(p.rootId);
        void this.local.start();
        return;
      }
      case "library.relocate": {
        const root = await this.scanner.relocateRoot(p.rootId, p.directory);
        void this.local.start();
        return root;
      }
      case "library.scan": {
        this.activity.scanningRootId = p.rootId;
        try {
          return await this.local.scan(p.rootId);
        } finally {
          this.activity.scanningRootId = null;
        }
      }
      case "files.query":
        return p.semantic ? this.ai.search(p) : c.query(p);
      case "ai.status":
        return this.ai.status();
      case "ai.configure":
        return this.ai.configure(p);
      case "ai.install":
        return this.ai.install();
      case "ai.enqueue":
        return this.ai.enqueue(p);
      case "ai.pause":
        return this.ai.pause(p.kind);
      case "ai.resume":
        return this.ai.resume(p.kind);
      case "ai.retry":
        return this.ai.retry(p.kind, p.fileIds);
      case "ai.candidates":
        return this.ai.candidates(p.fileId);
      case "ai.runCurrent":
        return this.ai.runCurrent(p.fileId);
      case "ai.review":
        return this.ai.review(p);
      case "ai.translate":
        return this.ai.translate(p.tag, p.displayName);
      case "files.detail":
        return c.detail(p.fileId);
      case "files.trashCommitted":
        c.db.transaction(() => {
          const update = c.db.prepare("UPDATE files SET missing=1 WHERE id=?");
          for (const fileId of p.fileIds) {
            c.getFile(fileId);
            update.run(fileId);
          }
        })();
        return;
      case "organization.apply":
        return c.applyOrganization(p);
      case "organization.undo":
        return c.undoOrganization(p.undoId);
      case "files.favorite":
        return c.setFavorite(p.fileIds, p.favorite);
      case "files.rate":
        return c.setRating(p.fileIds, p.rating);
      case "files.confirmCandidate": {
        const file = c.getFile(p.fileId);
        if (file.artworkId && file.artworkId !== p.artworkId)
          throw new Error("ALREADY_BOUND");
        const source = c.db
          .prepare("SELECT page_count FROM artworks WHERE id=?")
          .get(p.artworkId) as any;
        if (source && p.page >= source.page_count)
          throw new Error("PAGE_OUT_OF_RANGE");
        c.db
          .prepare(
            "UPDATE files SET artwork_id=?,page=?,candidate_artwork_id=NULL WHERE id=?",
          )
          .run(p.artworkId, p.page, p.fileId);
        return c.getFile(p.fileId);
      }
      case "authors.list":
        return c.authors(p.text, p.offset, p.limit);
      case "collections.delete":
        return c.deleteCollection(p.collectionId);
      case "files.reveal":
      case "files.open":
      case "files.copy":
      case "files.trash":
      case "files.openSource":
      case "window.control":
        throw new Error("HOST_OPERATION_REQUIRED");
      case "tags.list":
        return c.tags(p.text, p.offset, p.limit, p.category);
      case "tags.classify":
        return c.classifyTags(p.tagIds, p.category);
      case "tags.undo":
        return c.undoTags(p.undoId);
      case "tags.create":
        return c.createTag(p.name, p.category);
      case "tags.update":
        return c.updateTag(p.tagId, { name: p.name, category: p.category });
      case "tags.override":
        return c.overrideTags(
          p.fileIds,
          [p.tagId],
          p.mode === "inherit" ? "clear" : p.mode,
        );
      case "tags.addAlias":
        return c.addAlias(p.tagId, p.alias);
      case "tags.mergePreview":
        return c.mergePreview(p.sourceId, p.targetId);
      case "tags.merge":
        return c.mergeTags(p.sourceId, p.targetId);
      case "collections.list":
        return c.collections();
      case "collections.create":
        return c.createCollection(p.name, p.kind, p.filter);
      case "collections.update":
        return c.updateCollection(p.collectionId, {
          name: p.name,
          filter: p.filter,
        });
      case "collections.add":
        return c.collectionItems(p.collectionId, p.fileIds);
      case "collections.remove":
        return c.collectionItems(p.collectionId, p.fileIds, true);
      case "jobs.enqueue":
        return this.queue.enqueue(p.artworkIds, p.priority,true);
      case "jobs.settings":
        return this.queue.settings();
      case "jobs.configure":
        return this.queue.configure(p);
      case "jobs.runScope":
        return this.queue.runScope();
      case "jobs.setRunScope":
        return this.queue.setRunScope(p);
      case "jobs.clearRunScope":
        return this.queue.setRunScope(null);
      case "jobs.scopePreview":
        return this.queue.previewScope(p);
      case "jobs.enqueueScope":
        return this.queue.enqueueScope(
          {
            rootId: p.rootId,
            relativePath: p.relativePath,
            recursive: p.recursive,
            mode: p.mode,
          },
          p.previewToken,
          p.start,
        );
      case "jobs.list": {
        const page = this.queue.listPage(p);
        return {
          ...page,
          counts: Object.entries(page.counts).map(([status, count]) => ({
            status,
            count,
          })),
          source: this.queue.sourceState(),
        };
      }
      case "jobs.pause":
        return this.queue.pause();
      case "jobs.resume":
        return this.queue.resume(p.nextBatch);
      case "jobs.retry":
        return this.queue.retry(p.jobIds);
      case "images.processPending": {
        this.activity.processing = true;
        try {
          const result = await this.images.processPending({
            limit: p.limit,
            signal: AbortSignal.any([this.cancellation.signal,this.localCancellation.signal]),
          });
          await this.images.trimCache(this.settings().cacheLimitBytes);
          return result;
        } finally {
          this.activity.processing = false;
        }
      }
      case "images.resolve": {
        if (p.variant === "original")
          return { path: await c.resolveOriginal(p.fileId) };
        return this.ensureThumbnail(p.fileId);
      }
      case "system.stats":
        return {
          ...c.stats(),
          at: Date.now(),
          activity: { ...this.activity },
          local: this.local.status(),
        };
      case "local.status":
        return this.local.status();
      case "local.pause":
        return this.local.pause(p.kind);
      case "local.resume":
        return this.local.resume(p.kind);
      case "local.retry":
      case "images.retry":
        return this.local.retry(p.fileIds);
      case "settings.get":
        return this.settings();
      case "settings.update": {
        c.db
          .prepare(
            "INSERT INTO settings VALUES('cacheLimitBytes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(String(p.cacheLimitBytes));
        await this.images.trimCache(p.cacheLimitBytes);
        return this.settings();
      }
      case "system.backup":
        return c.backup(p.destination);
      case "system.export":
        return c.export(p.destination);
      case "system.restore": {
        await this.danbooru.close();
        await this.sauce.close();
        await this.ai.close();
        await this.queue.close();
        await this.local.close();
        try {
          await c.restore(p.source);
          c.db.exec("DELETE FROM local_state");
        } finally {
          this.danbooru = new DanbooruQueue(c, {
            request: this.options.danbooruRequest,
          });
          this.sauce = new SauceQueue(this.catalog, {
            request: this.options.sauceRequest,
            onConfirmed: (id) => {
              this.queue.enqueue([id]);
            },
          });
          this.queue = new PixivQueue(c, { fetcher: this.options.fetcher });
          this.queue.start();

          this.local = new LocalTasks(c, this.scanner, this.images);
          this.ai = new LocalAi(c,{home:this.ai.home});
          void this.local.start();
        }
        return {
          ...c.stats(),
          at: Date.now(),
          activity: { ...this.activity },
          local: this.local.status(),
        };
      }
      case "system.clearCache": {
        this.images.invalidateCacheSize();
        const directory = this.catalog.cacheDirectory;
        await mkdir(directory, { recursive: true });
        for (const entry of await readdir(directory)) {
          if (/^[a-f0-9]{64}\.webp$/.test(entry))
            await rm(path.join(directory, entry), {
              force: true,
              recursive: false,
            });
        }
        c.db.exec(
          "DELETE FROM features;UPDATE files SET thumbnail_key=NULL,feature_version=NULL,cache_evicted=0",
        );
        return true;
      }
      default:
        throw new Error("UNKNOWN_METHOD");
    }
  }
  async close() {
    this.closing = true;
    this.cancellation.abort();
    await this.danbooru.close();
    await this.sauce.close();
    await this.ai.close();
    await this.local.close();
    await Promise.allSettled([...this.pending]);
    await this.queue.close();
    this.catalog.close();
  }
}
