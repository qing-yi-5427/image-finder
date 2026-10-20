import type { Filter, QueryResult } from "../contracts.js";
export type AiKind = "wd" | "semantic";
export interface AiConfig {
  provider: "cpu" | "directml";
  generalThreshold: number;
  characterThreshold: number;
}
export interface AiStatus {
  maintenance?:boolean;
  home: string;
  python: string;
  config: AiConfig;
  models: Array<{
    kind: AiKind;
    id: string;
    version: string;
    ready: boolean;
    filesMissing: string[];
    license: string;
  }>;
  queues: Array<{
    kind: AiKind;
    paused: boolean;
    activeFileId: string | null;
    lastError?: string | null;
    blockingError?: string | null;
    counts: { waiting: number; running: number; done: number; failed: number; cancelled?:number };
    indexed: number;
    stale: number;
    total: number;
  }>;
  install: { running: boolean; stage: string; error: string | null };
}
export type AiProgress = { queues: Array<Pick<AiStatus["queues"][number], "kind" | "paused" | "activeFileId" | "blockingError" | "counts" | "lastError">> };
export interface AiCandidate {
  tag: string;
  displayName: string;
  category: "rating" | "content" | "character";
  score: number;
  automatic?: boolean;
  effective?: boolean;
  review: "pending" | "accepted" | "excluded";
  tagId?: string;
}
export interface AiCandidates {
  fileId: string;
  job?: { status: string; attempts: number; lastError: string | null } | null;
  run: {
    modelId: string;
    modelVersion: string;
    inputFingerprint: string;
    createdAt: number;
    thresholds: { general: number; character: number };
  } | null;
  candidates: AiCandidate[];
}
export interface AiMethodMap {
  "ai.autoEnable": {
    request: import("./ai-effective.js").AutoTagScope;
    result: {
      scope: import("./ai-effective.js").AutoTagScope;
      generalThreshold: number;
      characterThreshold: number;
      registeredTags: number;
    };
  };
  "ai.status": { request: Record<string, never>; result: AiStatus };
  "ai.progress": { request: Record<string, never>; result: AiProgress };
  "ai.configure": { request: Partial<AiConfig>; result: AiStatus };
  "ai.install": { request: Record<string, never>; result: AiStatus };
  "ai.enqueue": {
    request: {
      kind: AiKind;
      fileIds?: string[];
      filter?: Filter;
      scope?: "missing" | "all" | "missing_source";
    };
    result: { enqueued: number; status: AiStatus };
  };
  "ai.pause": { request: { kind: AiKind }; result: AiStatus };
  "ai.resume": { request: { kind: AiKind }; result: AiStatus };
  "ai.retry": {
    request: { kind: AiKind; fileIds?: string[] };
    result: { retried: number; status: AiStatus };
  };
  "ai.candidates": { request: { fileId: string }; result: AiCandidates };
  "ai.runCurrent": {
    request: { fileId: string };
    result: {
      fileId: string;
      status: "done" | "failed";
      error: string | null;
      candidates: AiCandidates;
    };
  };
  "ai.review": {
    request: {
      fileIds: string[];
      tag: string;
      action: "accept" | "exclude" | "restore";
    };
    result: { updated: number };
  };
  "ai.translate": {
    request: { tag: string; displayName: string };
    result: void;
  };
}
export type SemanticQueryResult = QueryResult;
