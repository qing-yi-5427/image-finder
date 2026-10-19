import type {
  FileDetail,
  FileItem,
  Filter,
  JobItem,
  LibraryRoot,
  DirectoryItem,
  ProgressEvent,
  QueryRequest,
  QueryResult,
  ScanResult,
  TagCategory,
} from "./contracts.js";
import type { LocalTaskStatus } from "./contracts.js";
import type { SourceNetworkStatus } from "./core/network-contract.js";
import type { AiMethodMap as importAiMethodMap } from "./core/ai-contracts.js";
export interface TagDto {
  id: string;
  name: string;
  category: TagCategory;
  aliases: string[];
  usageCount: number;
}
export interface AuthorDto {
  id: string;
  name: string;
  usageCount: number;
}
export interface CollectionDto {
  id: string;
  name: string;
  kind: "normal" | "smart";
  filter: Filter | null;
  createdAt: number;
}
export type NetworkStatus = SourceNetworkStatus;
export interface SettingsDto {
  dataDir: string;
  cacheLimitBytes: number;
}
export interface FileActionResult {
  successIds: string[];
  failures: Array<{ fileId: string; message: string }>;
  canceled: boolean;
}
type Route<P, R> = { request: P; result: R };
type Empty = Record<string, never>;
/** Single shared frontend request/result catalogue. Runtime validation remains mandatory. */
export interface MethodMap extends importAiMethodMap {
  "ai.environment": Route<Empty,{home:string;managed:boolean;cleanupSupported:boolean;bytes:number|null;error:string|null}>;
  "ai.environmentClear": Route<Empty,{clearedBytes:number}>;
  "tasks.cancel": Route<{kind:import("./core/task-overview.js").TaskKind},{cancelled:number}>;
  "app.version": Route<Empty,{version:string;packaged:boolean}>;
  "files.drag": Route<{fileIds:string[]},{started:true;count:number}>;
  "danbooru.status": Route<Empty, import("./core/danbooru.js").DanbooruStatus>;
  "danbooru.preview": Route<
    import("./core/danbooru.js").DanbooruScope,
    { total: number; eligible: number }
  >;
  "danbooru.enqueue": Route<
    import("./core/danbooru.js").DanbooruScope,
    { added: number }
  >;
  "danbooru.enqueueFile": Route<{ fileId: string }, { added: number }>;
  "danbooru.resume": Route<Empty, void>;
  "danbooru.pause": Route<Empty, void>;
  "danbooru.cancel": Route<Empty, void>;
  "danbooru.list": Route<
    { limit?: number },
    import("./core/danbooru.js").DanbooruItem[]
  >;
  "danbooru.tags": Route<
    { fileId: string },
    import("./core/danbooru.js").DanbooruTag[]
  >;
  "sauce.importLedger": Route<
    Empty,
    { imported: number; skipped: number } | null
  >;
  "sauce.status": Route<Empty, import("./core/sauce.js").SauceStatus>;
  "sauce.configure": Route<{ apiKey: string }, { configured: boolean }>;
  "sauce.enqueue": Route<
    import("./core/sauce.js").SauceScope,
    { added: number }
  >;
  "sauce.resume": Route<Empty, void>;
  "sauce.pause": Route<Empty, void>;
  "sauce.list": Route<
    { limit?: number },
    import("./core/sauce.js").SauceItem[]
  >;
  "sauce.review": Route<import("./core/sauce.js").SauceReview, void>;
  "sauce.openCandidate": Route<{ fileId: string; artworkId: string }, void>;
  "library.list": Route<Empty, LibraryRoot[]>;
  "library.directories": Route<
    { rootId: string; relativePath?: string; offset?: number; limit?: number },
    { items: DirectoryItem[]; total: number; offset: number; limit: number }
  >;
  "library.add": Route<Empty, LibraryRoot | null>;
  "library.remove": Route<{ rootId: string }, void>;
  "library.relocate": Route<{ rootId: string }, LibraryRoot | null>;
  "library.scan": Route<{ rootId: string }, ScanResult>;
  "files.query": Route<QueryRequest, QueryResult>;
  "files.detail": Route<{ fileId: string }, FileDetail>;
  "files.reveal": Route<{ fileId: string }, void>;
  "files.open": Route<{ fileId: string }, void>;
  "files.copy": Route<
    { fileIds: string[]; format: "files" | "paths" },
    FileActionResult
  >;
  "files.trash": Route<{ fileIds: string[] }, FileActionResult>;
  "files.openSource": Route<{ fileId: string }, void>;
  "window.control": Route<{ action: "minimize" | "maximize" | "close" }, void>;
  "authors.list": Route<
    { text?: string; offset?: number; limit?: number },
    AuthorDto[]
  >;
  "organization.apply": Route<
    {
      fileIds: string[];
      collection?: { collectionId: string; mode: "add" | "remove" };
      favorite?: boolean;
      rating?: number;
      tags?: Array<{
        name?: string;
        tagId?: string;
        mode: "add" | "exclude" | "inherit";
      }>;
    },
    { undoId: string }
  >;
  "organization.undo": Route<{ undoId: string }, void>;
  "files.favorite": Route<{ fileIds: string[]; favorite: boolean }, number>;
  "files.rate": Route<{ fileIds: string[]; rating: number }, number>;
  "files.confirmCandidate": Route<
    { fileId: string; artworkId: string; page: number },
    FileItem
  >;
  "tags.list": Route<
    { text?: string; category?: TagCategory; offset?: number; limit?: number },
    TagDto[]
  >;
  "tags.create": Route<{ name: string; category: TagCategory }, string>;
  "tags.update": Route<
    { tagId: string; name?: string; category?: TagCategory },
    void
  >;
  "tags.override": Route<
    { fileIds: string[]; tagId: string; mode: "add" | "exclude" | "inherit" },
    number
  >;
  "tags.addAlias": Route<{ tagId: string; alias: string }, void>;
  "tags.mergePreview": Route<
    { sourceId: string; targetId: string },
    {
      fromId: string;
      toId: string;
      files: number;
      aliases: Array<{ alias: string }>;
      overrideConflicts: { n: number };
    }
  >;
  "tags.merge": Route<
    MethodMap["tags.mergePreview"]["request"],
    MethodMap["tags.mergePreview"]["result"] & { undoId: string }
  >;
  "tags.classify": Route<
    { tagIds: string[]; category: TagCategory },
    { undoId: string }
  >;
  "tags.undo": Route<{ undoId: string }, void>;
  "collections.list": Route<Empty, CollectionDto[]>;
  "collections.create": Route<
    { name: string; kind: "normal" | "smart"; filter?: Filter },
    string
  >;
  "collections.update": Route<
    { collectionId: string; name?: string; filter?: Filter },
    void
  >;
  "collections.delete": Route<{ collectionId: string }, void>;
  "collections.add": Route<{ collectionId: string; fileIds: string[] }, void>;
  "collections.remove": Route<
    { collectionId: string; fileIds: string[] },
    void
  >;
  "jobs.enqueue": Route<{ artworkIds: string[]; priority?: number }, number>;
  "jobs.settings": Route<
    Empty,
    import("./core/queue-settings.js").PixivQueueSettings
  >;
  "jobs.configure": Route<
    import("./core/queue-settings.js").PixivQueueSettings,
    import("./core/queue-settings.js").PixivQueueSettings
  >;
  "jobs.scopePreview": Route<
    import("./core/pixiv-batch-contracts.js").PixivBatchScope,
    import("./core/pixiv-batch-contracts.js").PixivBatchPreview
  >;
  "jobs.enqueueScope": Route<
    import("./core/pixiv-batch-contracts.js").PixivBatchScope & {
      previewToken: string;
      start?: boolean;
    },
    import("./core/pixiv-batch-contracts.js").PixivBatchResult
  >;
  "jobs.list": Route<
    {
      offset?: number;
      limit?: number;
      statuses?: import("./contracts.js").JobStatus[];
      artworkId?: string;
    },
    {
      items: JobItem[];
      allTotal: number;
      total: number;
      offset: number;
      limit: number;
      counts: Array<{
        status: import("./contracts.js").JobStatus;
        count: number;
      }>;
      source: {
        runScope:
          | import("./core/pixiv-batch-contracts.js").PixivBatchScope
          | null;
        scopePending: number;
        paused: number;
        pause_until: number;
        reason: string | null;
        batch_used: number;
        batchLimit: number;
        rest_until: number;
        settings: import("./core/queue-settings.js").PixivQueueSettings;
      };
    }
  >;
  "jobs.runScope": Route<
    Empty,
    import("./core/pixiv-batch-contracts.js").PixivBatchScope | null
  >;
  "jobs.setRunScope": Route<
    import("./core/pixiv-batch-contracts.js").PixivBatchScope,
    import("./core/pixiv-batch-contracts.js").PixivBatchScope | null
  >;
  "jobs.clearRunScope": Route<Empty, null>;
  "jobs.pause": Route<Empty, void>;
  "jobs.resume": Route<{ nextBatch?: boolean }, void>;
  "jobs.retry": Route<{ jobIds?: string[] }, void>;
  "images.processPending": Route<
    { limit?: number },
    { processed: number; failed: number }
  >;
  "images.retry": Route<
    { fileIds?: string[] },
    { retried: number; status: LocalTaskStatus }
  >;
  "local.status": Route<Empty, LocalTaskStatus>;
  "local.pause": Route<{ kind: "scan" | "images" }, LocalTaskStatus>;
  "local.resume": Route<{ kind: "scan" | "images" }, LocalTaskStatus>;
  "local.retry": Route<
    { fileIds?: string[] },
    { retried: number; status: LocalTaskStatus }
  >;
  "system.stats": Route<Empty, ProgressEvent & { local: LocalTaskStatus }>;
  "system.backup": Route<Empty, string | null>;
  "system.export": Route<Empty, string | null>;
  "system.restore": Route<Empty, ProgressEvent | null>;
  "system.clearCache": Route<Empty, boolean>;
  "tasks.overview": Route<
    { scope?: import("./core/ai-effective.js").AutoTagScope | null },
    import("./core/task-overview.js").TaskOverview
  >;
  "tray.status": Route<Empty, { exists: boolean }>;
  "power.get": Route<
    Empty,
    import("./electron/task-power-preference.js").TaskPowerStatus
  >;
  "power.set": Route<
    { enabled: boolean },
    import("./electron/task-power-preference.js").TaskPowerStatus
  >;
  "settings.get": Route<Empty, SettingsDto>;
  "settings.update": Route<{ cacheLimitBytes: number }, SettingsDto>;
  "network.status": Route<Empty, NetworkStatus>;
  "network.verify": Route<Empty, NetworkStatus>;
  "network.configure": Route<
    { mode: "system" | "direct" | "custom"; proxyRules?: string },
    NetworkStatus
  >;
  "network.connect": Route<Empty, { opened: true }>;
  "network.logout": Route<Empty, NetworkStatus>;
}
export type PublicMethod = keyof MethodMap;
export type AppEvent = { type: "navigate"; page: "tasks" | "settings" } | { type: "power"; status: {enabled:boolean;active:boolean;error:string|null} };
export interface TypedImageFinderClient {
  onAppEvent?(callback:(event:AppEvent)=>void):()=>void;
  invoke<M extends PublicMethod>(
    method: M,
    payload: MethodMap[M]["request"],
  ): Promise<MethodMap[M]["result"]>;
  onProgress(
    callback: (event: ProgressEvent & { local: LocalTaskStatus }) => void,
  ): () => void;
}
declare global {
  interface Window {
    imageFinder: TypedImageFinderClient;
  }
}
