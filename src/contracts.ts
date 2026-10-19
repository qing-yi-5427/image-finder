export type TagCategory =
  | "character"
  | "franchise"
  | "content"
  | "style"
  | "uncategorized";
export type JobStatus =
  | "cancelled"
  | "waiting"
  | "running"
  | "retry_wait"
  | "needs_login"
  | "unavailable"
  | "done"
  | "failed"
  | "paused";
export interface TagGroup {
  ids: string[];
  mode?: "any" | "all";
}
export interface Filter {
  text?: string;
  rootIds?: string[];
  directory?: { rootId: string; relativePath: string };
  formats?: string[];
  favorite?: boolean;
  ratingMin?: number;
  ratingMax?: number;
  widthMin?: number;
  widthMax?: number;
  heightMin?: number;
  heightMax?: number;
  bytesMin?: number;
  bytesMax?: number;
  pixelsMin?: number;
  pixelsMax?: number;
  aspect?: number;
  aspectTolerance?: number;
  orientation?: "portrait" | "landscape" | "square";
  tags?: TagGroup[];
  excludeTagIds?: string[];
  creatorIds?: string[];
  artworkIds?: string[];
  addedAfter?: number;
  publishedAfter?: string;
  publishedBefore?: string;
  collectionId?: string;
  missing?: boolean;
  unorganized?: boolean;
  enrichmentStatus?: JobStatus[];
  color?: {
    hex: string;
    restrict?: boolean;
    tolerance?: number;
    minWeight?: number;
    includeUnanalyzed?: boolean;
  };
  tone?: {
    warmth?: "warm" | "cool" | "neutral";
    brightnessMin?: number;
    brightnessMax?: number;
    saturationMin?: number;
    saturationMax?: number;
  };
}
export interface QueryRequest {
  semantic?: { query: string };
  filter?: Filter;
  offset?: number;
  limit?: number;
  sort?: "added_desc" | "name" | "rating_desc" | "pixels_desc" | "color";
  stackArtworks?: boolean;
}
export interface FileItem {
  semanticScore?: number;
  id: string;
  rootId: string;
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  addedAt: number;
  missing: boolean;
  artworkId: string | null;
  page: number | null;
  candidateArtworkId: string | null;
  favorite: boolean;
  rating: number;
  width: number | null;
  height: number | null;
  format: string | null;
  thumbnailKey: string | null;
  title: string | null;
  creatorName: string | null;
  palette?: Array<{ hex: string; weight: number }>;
  matchedCount?: number;
  localCount?: number;
}
export interface QueryResult {
  semantic?: {modelId: string; modelVersion: string; indexed: number; unindexed: number};
  items: FileItem[];
  total: number;
  offset: number;
  limit: number;
}
export interface ArtworkPayload {
  id: string;
  title: string;
  creator: { id: string; name: string };
  pageCount: number;
  publishedAt: string | null;
  tags: Array<{ name: string; translation?: string }>;
  raw: unknown;
}
export interface LibraryRoot {
  id: string;
  path: string;
  status: "online" | "offline" | "partial";
  createdAt: number;
  lastScanAt: number | null;
}
export interface DirectoryItem {
  rootId: string;
  relativePath: string;
  name: string;
  path: string;
  imageCount: number;
  hasChildren: boolean;
}
export interface ImageFeature {
  width: number;
  height: number;
  format: string;
  thumbnailKey: string;
  palette: Array<{ hex: string; weight: number }>;
  brightness: number;
  saturation: number;
  warmth: "warm" | "cool" | "neutral";
  algorithmVersion: string;
}
export interface JobItem {
  title?: string | null;
  creatorName?: string | null;
  thumbnailUrl?: string | null;
  id: string;
  artworkId: string;
  status: JobStatus;
  attempts: number;
  priority: number;
  nextRunAt: number;
  lastError: string | null;
}
export interface ScanResult {
  discovered: number;
  added: number;
  changed: number;
  missing: number;
  errors: string[];
  complete: boolean;
  elapsedMs: number;
}
export interface ApplicationOptions {
  dataDir: string;
}
export interface AppErrorShape {
  code: string;
  message: string;
}
export interface FileDetail extends FileItem {
  root: LibraryRoot;
  processing: {
    status: "pending" | "ready" | "error" | "evicted";
    error: string | null;
    algorithmVersion: string | null;
  };
  tags: Array<{
    id: string;
    name: string;
    category: TagCategory;
    aliases: string[];
    inherited: boolean;
    override: "add" | "exclude" | null;
    effective: boolean;
    rawSource: Array<{ name: string; translation: string | null }>;
  }>;
  source: {
    id: string;
    title: string;
    creatorId: string;
    creatorName: string;
    pageCount: number;
    publishedAt: string | null;
    fetchedAt: number;
    url: string;
  } | null;
}
export interface ProgressEvent {
  at: number;
  files: number;
  features: number;
  jobs: Array<{ status: JobStatus; count: number }>;
  roots: LibraryRoot[];
  activity?: { scanningRootId: string | null; processing: boolean };
}
export type ImageFinderClient = import("./api.js").TypedImageFinderClient;

export type LocalTaskKind = "scan" | "images";
export interface LocalTaskStatus {
  scanPaused: boolean;
  imagesPaused: boolean;
  pendingRoots: string[];
  activeRoot: string | null;
  discovered: number;
  added: number;
  changed: number;
  processed: number;
  failed: number;
  lastScan: ScanResult | null;
  scanProgress?: ScanResult | null;
  lastError: string | null;
  running: boolean;
  images: { pending: number; ready: number; failed: number };
}
