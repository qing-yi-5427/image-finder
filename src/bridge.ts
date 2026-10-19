import { validateProxySettings } from "./core/network-contract.js";
import { validatePixivQueueSettings } from "./core/queue-settings.js";
import { directoryPath } from "./directory-path.js";
const categories = [
  "character",
  "franchise",
  "content",
  "style",
  "uncategorized",
];
type Rule = (v: any) => boolean;
const str: Rule = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4000 &&
  !v.includes("\0");
const num: Rule = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const integer: Rule = (v) => num(v) && Number.isInteger(v);
const bool: Rule = (v) => typeof v === "boolean";
const ids: Rule = (v) => Array.isArray(v) && v.length <= 10000 && v.every(str);
const one =
  (items: readonly string[]): Rule =>
  (v) =>
    items.includes(v);
const shape =
  (rules: Record<string, Rule>, required: string[] = []): Rule =>
  (v) =>
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).every((k) => Object.hasOwn(rules, k) && rules[k](v[k])) &&
    required.every((k) => Object.hasOwn(v, k));
const filterRules: Record<string, Rule> = {};
const relativeDirectory: Rule = (value) => {
  try {
    directoryPath(value);
    return true;
  } catch {
    return false;
  }
};
filterRules.directory = shape(
  { rootId: str, relativePath: relativeDirectory },
  ["rootId", "relativePath"],
);
for (const k of ["text", "collectionId", "publishedAfter", "publishedBefore"])
  filterRules[k] = str;
for (const k of [
  "rootIds",
  "formats",
  "excludeTagIds",
  "creatorIds",
  "artworkIds",
])
  filterRules[k] = ids;
for (const k of ["favorite", "missing", "unorganized"]) filterRules[k] = bool;
for (const k of [
  "ratingMin",
  "ratingMax",
  "widthMin",
  "widthMax",
  "heightMin",
  "heightMax",
  "bytesMin",
  "bytesMax",
  "pixelsMin",
  "pixelsMax",
  "aspect",
  "aspectTolerance",
  "addedAfter",
])
  filterRules[k] = num;
filterRules.orientation = one(["portrait", "landscape", "square"]);
filterRules.enrichmentStatus = (v) =>
  Array.isArray(v) &&
  v.every(
    one([
      "waiting",
      "running",
      "retry_wait",
      "needs_login",
      "unavailable",
      "done",
      "failed",
      "paused",
      "cancelled",
    ]),
  );
filterRules.tags = (v) =>
  Array.isArray(v) &&
  v.length <= 100 &&
  v.every(shape({ ids, mode: one(["any", "all"]) }, ["ids"]));
filterRules.color = shape(
  {
    hex: (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v),
    restrict: bool,
    tolerance: num,
    minWeight: (v) => num(v) && v <= 1,
    includeUnanalyzed: bool,
  },
  ["hex"],
);
filterRules.tone = shape({
  warmth: one(["warm", "cool", "neutral"]),
  brightnessMin: num,
  brightnessMax: num,
  saturationMin: num,
  saturationMax: num,
});
const filter = shape(filterRules);
const routes: Record<string, [Record<string, Rule>, string[]]> = {};
function route(
  name: string,
  rules: Record<string, Rule> = {},
  required = Object.keys(rules),
) {
  routes[name] = [rules, required];
}
for (const name of ["sauce.status", "sauce.resume", "sauce.pause"]) route(name);
for (const name of [
  "danbooru.status",
  "danbooru.resume",
  "danbooru.pause",
  "danbooru.cancel",
])
  route(name);
for (const name of ["danbooru.preview", "danbooru.enqueue"])
  route(name, {
    rootId: str,
    relativePath: relativeDirectory,
    recursive: bool,
  });
for (const name of ["danbooru.enqueueFile", "danbooru.tags"])
  route(name, { fileId: str });
route("danbooru.list", { limit: (v) => integer(v) && v > 0 && v <= 500 }, []);
route(
  "tasks.overview",
  {
    scope: (v) =>
      v === null ||
      shape({ rootId: str, relativePath: relativeDirectory, recursive: bool }, [
        "rootId",
        "relativePath",
        "recursive",
      ])(v),
  },
  [],
);
route("ai.autoEnable", {
  rootId: str,
  relativePath: relativeDirectory,
  recursive: bool,
});
route("tray.status");
route("power.get");
route("power.set", { enabled: bool });
route("sauce.importLedger", { source: str });
route("sauce.configure", {
  apiKey: (v) =>
    typeof v === "string" && (v === "" || /^[a-zA-Z0-9_-]{16,128}$/.test(v)),
});
route("sauce.enqueue", {
  rootId: str,
  relativePath: relativeDirectory,
  recursive: bool,
});
route("sauce.list", { limit: (v) => integer(v) && v > 0 && v <= 500 }, []);
route(
  "sauce.review",
  {
    fileId: str,
    action: one(["confirm", "reject"]),
    artworkId: (v) => typeof v === "string" && /^[1-9]\d{0,11}$/.test(v),
    page: (v) => v === null || integer(v),
  },
  ["fileId", "action"],
);
route("sauce.openCandidate", {
  fileId: str,
  artworkId: (v) => typeof v === "string" && /^[1-9]\d{0,11}$/.test(v),
});
for (const m of [
  "library.list",
  "tags.list",
  "collections.list",
  "jobs.list",
  "jobs.pause",
  "jobs.resume",
  "system.stats",
  "system.clearCache",
])
  route(m);
route(
  "tags.list",
  {
    text: str,
    category: one(categories),
    offset: integer,
    limit: (v) => integer(v) && v > 0 && v <= 500,
  },
  [],
);
route("cache.status");
route("cache.select");
route("cache.initialize",{directory:str,configurationError:str},["directory"]);
route("cache.configure",{directory:str});
route("library.add", { directory: str });
route("library.remove", { rootId: str });
route("library.relocate", { rootId: str, directory: str });
route("library.scan", { rootId: str });
route(
  "library.directories",
  {
    rootId: str,
    relativePath: relativeDirectory,
    offset: integer,
    limit: (v) => integer(v) && v > 0 && v <= 500,
  },
  ["rootId"],
);
route(
  "files.query",
  {
    semantic: shape({ query: str }, ["query"]),
    filter,
    offset: integer,
    limit: (v) => integer(v) && v > 0 && v <= 500,
    sort: one(["added_desc", "name", "rating_desc", "pixels_desc", "color"]),
    stackArtworks: bool,
  },
  [],
);
route("files.detail", { fileId: str });
route("app.version", {});
route("tasks.cancel", {kind:one(["pixiv","wd","semantic","danbooru","sauce","local"])});
route("ai.environment",{});
route("ai.environmentClear",{});
route("ai.prepareCleanup",{});
route("ai.finishCleanup",{});
route("files.drag", {fileIds: v=>ids(v)&&v.length>0&&v.length<=500});
for (const m of ["files.reveal", "files.openSource", "files.open"])
  route(m, { fileId: str });
route("files.copy", {
  fileIds: (v) => ids(v) && v.length > 0,
  format: one(["files", "paths"]),
});
route("files.trash", { fileIds: (v) => ids(v) && v.length > 0 });
route("files.trashCommitted", { fileIds: (v) => ids(v) && v.length > 0 });
route("window.control", { action: one(["minimize", "maximize", "close"]) });
route(
  "authors.list",
  { text: str, offset: integer, limit: (v) => integer(v) && v > 0 && v <= 500 },
  [],
);
route("collections.delete", { collectionId: str });
const organizationTag = shape(
  { name: str, tagId: str, mode: one(["add", "exclude", "inherit"]) },
  ["mode"],
);
route(
  "organization.apply",
  {
    fileIds: (v) => ids(v) && v.length > 0,
    collection: shape({ collectionId: str, mode: one(["add", "remove"]) }, [
      "collectionId",
      "mode",
    ]),
    favorite: bool,
    rating: (v) => integer(v) && v <= 5,
    tags: (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.length <= 30 &&
      v.every(
        (t) =>
          organizationTag(t) &&
          Object.hasOwn(t, "name") !== Object.hasOwn(t, "tagId"),
      ),
  },
  ["fileIds"],
);
route("organization.undo", { undoId: str });
route("files.favorite", { fileIds: ids, favorite: bool });
route("files.rate", { fileIds: ids, rating: (v) => integer(v) && v <= 5 });
route("files.confirmCandidate", {
  fileId: str,
  artworkId: (v) => str(v) && /^[1-9]\d{4,11}$/.test(v),
  page: integer,
});
route("tags.classify", {
  tagIds: (v) => ids(v) && v.length > 0,
  category: one(categories),
});
route("tags.undo", { undoId: str });
route("tags.create", { name: str, category: one(categories) });
route("tags.update", { tagId: str, name: str, category: one(categories) }, [
  "tagId",
]);
route("tags.override", {
  fileIds: ids,
  tagId: str,
  mode: one(["add", "exclude", "inherit"]),
});
route("tags.addAlias", { tagId: str, alias: str });
for (const m of ["tags.merge", "tags.mergePreview"])
  route(m, { sourceId: str, targetId: str });
route(
  "collections.create",
  { name: str, kind: one(["normal", "smart"]), filter },
  ["name", "kind"],
);
route("collections.update", { collectionId: str, name: str, filter }, [
  "collectionId",
]);
for (const m of ["collections.add", "collections.remove"])
  route(m, { collectionId: str, fileIds: ids });
route(
  "jobs.enqueue",
  {
    artworkIds: (v) =>
      ids(v) && v.every((id: string) => /^[1-9]\d{4,11}$/.test(id)),
    priority: integer,
  },
  ["artworkIds"],
);
route("jobs.retry", { jobIds: ids }, []);
route("jobs.resume", { nextBatch: bool }, []);
route("jobs.settings");
route("jobs.configure", {
  intervalMinSeconds: integer,
  intervalMaxSeconds: integer,
  batchLimit: integer,
  autoRest: bool,
  restMinutes: integer,
});
const pixivScopeRules = {
  rootId: str,
  relativePath: relativeDirectory,
  recursive: bool,
  mode: one(["missing_or_failed", "all"]),
};
route("jobs.scopePreview", pixivScopeRules);
route("jobs.runScope");
route("jobs.clearRunScope");
route("jobs.setRunScope", pixivScopeRules);
route(
  "jobs.enqueueScope",
  {
    ...pixivScopeRules,
    previewToken: (value) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    start: bool,
  },
  [...Object.keys(pixivScopeRules), "previewToken"],
);
route(
  "jobs.list",
  {
    offset: integer,
    limit: (v) => integer(v) && v > 0 && v <= 500,
    statuses: filterRules.enrichmentStatus,
    artworkId: (v) => typeof v === "string" && /^\d{1,12}$/.test(v),
  },
  [],
);
route(
  "images.processPending",
  { limit: (v) => integer(v) && v > 0 && v <= 1000 },
  [],
);
route("images.resolve", {
  fileId: str,
  variant: one(["thumbnail", "original"]),
});
route("system.backup", { destination: str });
route("system.export", { destination: str });
for (const m of [
  "network.status",
  "network.verify",
  "network.connect",
  "network.logout",
  "local.status",
  "settings.get",
])
  route(m);
route(
  "network.configure",
  { mode: one(["system", "direct", "custom"]), proxyRules: str },
  ["mode"],
);
for (const m of ["local.pause", "local.resume"])
  route(m, { kind: one(["scan", "images"]) });
for (const m of ["local.retry", "images.retry"]) route(m, { fileIds: ids }, []);
route("settings.update", { cacheLimitBytes: integer });
route("system.restore", { source: str });
const aiKind = one(["wd", "semantic"]);
for (const name of ["ai.status", "ai.install"]) route(name);
route(
  "ai.configure",
  {
    provider: one(["cpu", "directml"]),
    generalThreshold: (v) => num(v) && v <= 1,
    characterThreshold: (v) => num(v) && v <= 1,
  },
  [],
);
route(
  "ai.enqueue",
  {
    kind: aiKind,
    fileIds: ids,
    filter,
    scope: one(["missing", "all", "missing_source"]),
  },
  ["kind"],
);
route("ai.runCurrent", { fileId: str });
for (const name of ["ai.pause", "ai.resume"]) route(name, { kind: aiKind });
route("ai.retry", { kind: aiKind, fileIds: ids }, ["kind"]);
route("ai.candidates", { fileId: str });
route("ai.review", {
  fileIds: (v) => ids(v) && v.length > 0,
  tag: str,
  action: one(["accept", "exclude", "restore"]),
});
route("ai.translate", { tag: str, displayName: str });
export type ServiceMethod =
  | keyof import("./api.js").MethodMap
  | "images.resolve"
  | "files.trashCommitted";
// files.trashCommitted is host-only and never exposed by the public client.
export function validateInvocation(
  method: unknown,
  payload: unknown = {},
  options: { privileged?: boolean } = {},
): asserts method is ServiceMethod {
  if (typeof method !== "string" || !Object.hasOwn(routes, method))
    throw new Error("Unknown service method");
  if (
    !options.privileged &&
    [
      "cache.initialize",
      "cache.configure",
      "images.resolve",
      "ai.prepareCleanup",
      "ai.finishCleanup",
      "files.trashCommitted",
      "library.add",
      "library.relocate",
      "system.backup",
      "system.export",
      "system.restore",
      "sauce.importLedger",
    ].includes(method)
  )
    throw new Error("Privileged host operation");
  if (JSON.stringify(payload)?.length > 100000)
    throw new Error("Payload too large");
  if (method === "network.configure") validateProxySettings(payload);
  if (method === "jobs.configure") validatePixivQueueSettings(payload);
  if (
    method === "organization.apply" &&
    payload &&
    typeof payload === "object" &&
    !["favorite", "rating", "tags", "collection"].some((k) =>
      Object.hasOwn(payload, k),
    )
  )
    throw new Error("Malformed invocation payload");
  const [rules, required] = routes[method];
  if (!shape(rules, required)(payload))
    throw new Error("Malformed invocation payload");
}

/** Derive the official source URL only from a bound catalog artwork id. */
export function boundSourceUrl(artworkId: unknown): string {
  if (typeof artworkId !== "string" || !/^[1-9]\d{4,11}$/.test(artworkId))
    throw new Error("SOURCE_NOT_BOUND");
  return `https://www.pixiv.net/artworks/${artworkId}`;
}
