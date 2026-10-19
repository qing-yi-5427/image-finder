export interface PixivBatchScope {
  rootId: string;
  relativePath: string;
  recursive: boolean;
  mode: "missing_or_failed" | "all";
}
export interface PixivBatchPreview {
  scope: PixivBatchScope;
  rootPath: string;
  fileCount: number;
  boundFileCount: number;
  unboundFileCount: number;
  artworkCount: number;
  eligibleArtworkCount: number;
  eligibleFileCount: number;
  queuedArtworkCount: number;
  runningArtworkCount: number;
  completedArtworkCount: number;
  unavailableArtworkCount: number;
  previewToken: string;
}
export interface PixivBatchResult {
  enqueued: number;
  requeued: number;
  queuedArtworkCount: number;
  queuedFileCount: number;
  paused: boolean;
  preview: PixivBatchPreview;
}
