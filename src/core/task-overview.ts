import type { Catalog } from "./catalog.js";
import { directoryPath } from "../directory-path.js";
import { ALGORITHM_VERSION } from "./images.js";
import type { AutoTagScope } from "./ai-effective.js";
export type TaskKind =
  | "pixiv"
  | "wd"
  | "semantic"
  | "danbooru"
  | "sauce"
  | "local";
export interface TaskOverviewCard {
  kind: TaskKind;
  cancellable: number;
  label: string;
  coverage: { covered: number; total: number; automaticTagged?: number };
  progress: {
    total: number;
    processed: number;
    unit: "作品" | "图片";
    counts: Array<{ status: string; count: number }>;
  };
  paused: boolean;
  reason: string | null;
  lastError?: string | null;
  queueState?: "running" | "waiting" | "paused" | "blocked" | "idle";
}
export interface TaskOverview {
  scope: {
    rootId: string | null;
    relativePath: string;
    recursive: boolean;
    total: number;
    label: string;
  };
  executionScope: AutoTagScope | null;
  cards: TaskOverviewCard[];
}
export function taskOverview(
  c: Catalog,
  scope: AutoTagScope | null,
  executionScope: AutoTagScope | null,
  states: { pixiv: any; ai: any; danbooru: any; sauce: any; local: any },
): TaskOverview {
  let where = "f.missing=0";
  const args: any[] = [];
  let label = "全库";
  let relative = "";
  if (scope) {
    const root = c.getRoot(scope.rootId);
    relative = directoryPath(scope.relativePath);
    where += " AND f.root_id=?";
    args.push(root.id);
    if (relative) {
      where += " AND substr(replace(f.relative_path,char(92),'/'),1,?)=?";
      args.push(relative.length + 1, relative + "/");
    }
    if (!scope.recursive) {
      where +=
        " AND instr(substr(replace(f.relative_path,char(92),'/'),?),'/')=0";
      args.push(relative ? relative.length + 2 : 1);
    }
    label =
      root.path +
      (relative ? " / " + relative : "") +
      (scope.recursive ? "（含子目录）" : "（不含子目录）");
  }
  // Bind one immutable scope CTE to every metric; viewing cannot mutate any queue.
  const prefix = `WITH scoped AS (SELECT f.* FROM files_visible f WHERE ${where}) `;
  const count = (sql: string, ...extra: any[]) =>
    Number((c.db.prepare(prefix + sql).get(...args, ...extra) as any)?.n ?? 0);
  const groups = (sql: string, ...extra: any[]) =>
    c.db.prepare(prefix + sql).all(...args, ...extra) as Array<{
      status: string;
      count: number;
    }>;
  const total = count("SELECT count(*) n FROM scoped");
  const terminal = new Set([
    "done",
    "no_match",
    "unavailable",
    "failed",
    "error",
    "cancelled",
    "confirmed",
    "rejected",
    "review",
    "no_source",
    "ready",
  ]);
  const card = (
    kind: TaskKind,
    label: string,
    covered: number,
    counts: Array<{ status: string; count: number }>,
    paused: boolean,
    reason: string | null,
    unit: "作品" | "图片" = "图片",
  ): TaskOverviewCard => ({
    kind,
    cancellable: Number((c.db.prepare(kind==='pixiv'?"SELECT count(*) n FROM jobs WHERE status IN ('waiting','retry_wait','running')":kind==='wd'||kind==='semantic'?"SELECT count(*) n FROM ai_jobs WHERE kind=? AND status IN ('waiting','running')":kind==='local'?"SELECT 0 n":`SELECT count(*) n FROM ${kind}_jobs WHERE status IN ('waiting','running')`).get(...(kind==='wd'||kind==='semantic'?[kind]:[])) as any)?.n??0),
    label,
    coverage: { covered, total },
    progress: {
      total: counts.reduce((s, r) => s + r.count, 0),
      processed: counts
        .filter((r) => terminal.has(r.status))
        .reduce((s, r) => s + r.count, 0),
      unit,
      counts,
    },
    paused,
    reason,
  });
  const pixiv = card(
    "pixiv",
    "Pixiv 信息补全",
    count(
      "SELECT count(*) n FROM scoped f JOIN artworks a ON a.id=f.artwork_id",
    ),
    groups(
      "SELECT j.status,count(*) count FROM jobs j WHERE EXISTS(SELECT 1 FROM scoped f WHERE f.artwork_id=j.artwork_id) GROUP BY j.status",
    ),
    !!states.pixiv.paused,
    states.pixiv.reason,
    "作品",
  );
  const aiCard = (kind: "wd" | "semantic", label: string) => {
    const state = states.ai.queues.find((q: any) => q.kind === kind);
    const valid =
      kind === "wd"
        ? "SELECT count(*) n FROM scoped f JOIN ai_valid_runs r ON r.file_id=f.id AND r.kind='wd'"
        : "SELECT count(*) n FROM scoped f JOIN ai_valid_runs r ON r.file_id=f.id AND r.kind='semantic' JOIN ai_vectors v ON v.file_id=f.id AND v.model_version=r.model_version WHERE v.dimension=512 AND length(v.vector)=2048";
    const result = card(
      kind,
      label,
      count(valid),
      groups(
        "SELECT j.status,count(*) count FROM ai_jobs j JOIN scoped f ON f.id=j.file_id WHERE j.kind=? GROUP BY j.status",
        kind,
      ),
      !!state?.paused,
      state?.blockingError ?? null,
    );
    result.lastError = state?.lastError ?? null;
    result.queueState = state?.blockingError ? "blocked" : state?.paused ? "paused" : state?.activeFileId || state?.counts?.running ? "running" : state?.counts?.waiting ? "waiting" : "idle";
    return result;
  };
  const wd = aiCard("wd", "WD 自动标签");
  wd.coverage.automaticTagged = count(
    "SELECT count(*) n FROM scoped f WHERE EXISTS(SELECT 1 FROM ai_auto_effective ae WHERE ae.file_id=f.id AND NOT EXISTS(SELECT 1 FROM file_tag_overrides o WHERE o.file_id=f.id AND o.tag_id=ae.tag_id AND o.action='exclude'))",
  );
  const semantic = aiCard("semantic", "中文语义索引");
  const dan = card(
    "danbooru",
    "Danbooru 精确匹配",
    count(
      "SELECT count(*) n FROM scoped f JOIN danbooru_jobs j ON j.file_id=f.id WHERE j.status='done' AND j.bytes=f.bytes AND j.mtime_ms=f.mtime_ms AND EXISTS(SELECT 1 FROM danbooru_tags t WHERE t.file_id=f.id)",
    ),
    groups(
      "SELECT j.status,count(*) count FROM danbooru_jobs j JOIN scoped f ON f.id=j.file_id GROUP BY j.status",
    ),
    !!states.danbooru.paused,
    states.danbooru.reason,
  );
  const sauce = card(
    "sauce",
    "SauceNAO 来源识别",
    count(
      "SELECT count(*) n FROM scoped f JOIN sauce_jobs j ON j.file_id=f.id WHERE j.status='confirmed' AND f.artwork_id IS NOT NULL",
    ),
    groups(
      "SELECT j.status,count(*) count FROM sauce_jobs j JOIN scoped f ON f.id=j.file_id GROUP BY j.status",
    ),
    !!states.sauce.paused,
    states.sauce.reason,
  );
  const localCovered = count(
    "SELECT count(*) n FROM scoped f JOIN features z ON z.file_id=f.id WHERE z.algorithm_version=? AND f.feature_version=? AND f.processing_error IS NULL",
    ALGORITHM_VERSION,
    ALGORITHM_VERSION,
  );
  const localFailed = count(
    "SELECT count(*) n FROM scoped f WHERE f.processing_error IS NOT NULL",
  );
  const localCancelled = count("SELECT count(*) n FROM scoped f JOIN local_cancelled_images x ON x.file_id=f.id AND x.bytes=f.bytes AND x.mtime_ms=f.mtime_ms WHERE f.processing_error IS NULL AND ((f.thumbnail_key IS NULL AND f.cache_evicted=0) OR f.feature_version IS NULL OR f.feature_version<>?)",ALGORITHM_VERSION);
  const cancelledCovered=count("SELECT count(*) n FROM scoped f JOIN features z ON z.file_id=f.id JOIN local_cancelled_images x ON x.file_id=f.id AND x.bytes=f.bytes AND x.mtime_ms=f.mtime_ms WHERE f.processing_error IS NULL AND z.algorithm_version=? AND f.feature_version=? AND ((f.thumbnail_key IS NULL AND f.cache_evicted=0) OR f.feature_version IS NULL OR f.feature_version<>?)",ALGORITHM_VERSION,ALGORITHM_VERSION,ALGORITHM_VERSION);
  const localReady=localCovered-cancelledCovered;
  const local = card(
    "local",
    "本地图片处理",
    localCovered,
    [
      { status: "ready", count: localReady },
      { status: "failed", count: localFailed },
      { status: "cancelled", count: localCancelled },
      {
        status: "waiting",
        count: Math.max(0, total - localReady - localFailed-localCancelled),
      },
    ],
    !!states.local.imagesPaused,
    states.local.lastError ?? null,
  );
  local.cancellable=(states.local.images?.pending??0)+new Set([...(states.local.pendingRoots??[]),...(states.local.activeRoot?[states.local.activeRoot]:[])]).size;
  return {
    scope: {
      rootId: scope?.rootId ?? null,
      relativePath: relative,
      recursive: scope?.recursive ?? true,
      total,
      label,
    },
    executionScope,
    cards: [pixiv, wd, semantic, dan, sauce, local],
  };
}
