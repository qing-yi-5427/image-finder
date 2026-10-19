import {
  AI_EFFECTIVE_SCHEMA,
  automaticCandidateSelect,
  WD_AUTO_GENERAL,
  WD_AUTO_CHARACTER,
  type AutoTagScope,
} from "./ai-effective.js";
import Database from "better-sqlite3";
import { mkdirSync, realpathSync } from "node:fs";
import { writeFile, realpath, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ArtworkPayload,
  FileItem,
  Filter,
  LibraryRoot,
  QueryRequest,
  QueryResult,
  TagCategory,
} from "../contracts.js";
import { safeResolve } from "./filesystem.js";
import { deltaE } from "./images.js";
import { directoryPath } from "../directory-path.js";

export const normalize = (s: string) =>
  s.normalize("NFKC").trim().toLocaleLowerCase("und");
const id = () => randomUUID();
const clamp = (
  n: number | undefined,
  min: number,
  max: number,
  fallback: number,
) => Math.max(min, Math.min(max, n ?? fallback));
export class Catalog {
  private bulkQuery = false;
  private aiScores: Map<string, number> | null = null;
  readonly db: Database.Database;
  readonly dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new Database(path.join(this.dataDir, "catalog.sqlite"));
    this.db.function("normalize_text", { deterministic: true }, (value) =>
      normalize(String(value ?? "")),
    );
    this.db.function(
      "palette_distance",
      { deterministic: true },
      (palette, hex, minWeight) => {
        if (!palette) return null;
        const colors = JSON.parse(String(palette));
        const distances = colors
          .filter((x: any) => x.weight >= Number(minWeight))
          .map((x: any) => deltaE(String(hex), x.hex));
        return distances.length ? Math.min(...distances) : 1000;
      },
    );
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.function(
      "ai_similarity",
      (fileId) => this.aiScores?.get(String(fileId)) ?? null,
    );
    this.db.function(
      "ai_fingerprint",
      { deterministic: true },
      (id, bytes, mtime) =>
        createHash("sha256").update(`${id}:${bytes}:${mtime}`).digest("hex"),
    );
    this.db.exec(`
  CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'online',created_at INTEGER NOT NULL,last_scan_at INTEGER);
  CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,relative_path TEXT NOT NULL,bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL,identity TEXT,added_at INTEGER NOT NULL,last_seen_scan TEXT,missing INTEGER NOT NULL DEFAULT 0,artwork_id TEXT,page INTEGER,candidate_artwork_id TEXT,favorite INTEGER NOT NULL DEFAULT 0,rating INTEGER NOT NULL DEFAULT 0,width INTEGER,height INTEGER,format TEXT,thumbnail_key TEXT,feature_version TEXT,processing_error TEXT,UNIQUE(root_id,relative_path));
  CREATE TABLE IF NOT EXISTS creators(id TEXT PRIMARY KEY,name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS artworks(id TEXT PRIMARY KEY,title TEXT NOT NULL,creator_id TEXT NOT NULL REFERENCES creators(id),page_count INTEGER NOT NULL,published_at TEXT,fetched_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS organization_undo(id TEXT PRIMARY KEY,scope_json TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tag_undo(id TEXT PRIMARY KEY,scope_json TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tags(id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ai_reviews(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,tag TEXT NOT NULL,action TEXT NOT NULL,tag_id TEXT REFERENCES tags(id),created_at INTEGER NOT NULL,PRIMARY KEY(file_id,tag));
  CREATE TABLE IF NOT EXISTS ai_lexicon(tag TEXT PRIMARY KEY,display_name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tag_aliases(alias_key TEXT PRIMARY KEY,alias TEXT NOT NULL,tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS artwork_tags(artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES tags(id),raw_name TEXT NOT NULL,translation TEXT,PRIMARY KEY(artwork_id,raw_name));
  CREATE TABLE IF NOT EXISTS danbooru_tags(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,raw_name TEXT NOT NULL,tag_id TEXT NOT NULL REFERENCES tags(id),category TEXT NOT NULL,post_id INTEGER NOT NULL,PRIMARY KEY(file_id,raw_name));
  CREATE INDEX IF NOT EXISTS danbooru_tags_tag ON danbooru_tags(tag_id,file_id);
  CREATE TABLE IF NOT EXISTS local_cancelled_images(file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS local_cancelled_roots(root_id TEXT PRIMARY KEY REFERENCES roots(id) ON DELETE CASCADE);
  CREATE TRIGGER IF NOT EXISTS danbooru_invalidate_changed_file AFTER UPDATE OF bytes,mtime_ms,identity ON files WHEN OLD.bytes<>NEW.bytes OR OLD.mtime_ms<>NEW.mtime_ms OR OLD.identity IS NOT NEW.identity BEGIN DELETE FROM danbooru_tags WHERE file_id=NEW.id; END;
  CREATE TABLE IF NOT EXISTS file_tag_overrides(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES tags(id),action TEXT NOT NULL CHECK(action IN ('add','exclude')),PRIMARY KEY(file_id,tag_id));
  CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('normal','smart')),filter_json TEXT,created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS collection_items(collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,PRIMARY KEY(collection_id,file_id));
  CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,artwork_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,priority INTEGER NOT NULL DEFAULT 0,next_run_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS source_state(source TEXT PRIMARY KEY,paused INTEGER NOT NULL DEFAULT 0,pause_until INTEGER NOT NULL DEFAULT 0,reason TEXT);
  CREATE TABLE IF NOT EXISTS source_snapshots(id TEXT PRIMARY KEY,artwork_id TEXT NOT NULL,fetched_at INTEGER NOT NULL,raw_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS features(file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,palette_json TEXT NOT NULL,brightness REAL NOT NULL,saturation REAL NOT NULL,warmth TEXT NOT NULL,algorithm_version TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS files_root ON files(root_id,missing); CREATE INDEX IF NOT EXISTS files_identity ON files(root_id,identity,bytes,mtime_ms); CREATE INDEX IF NOT EXISTS files_artwork ON files(artwork_id); CREATE INDEX IF NOT EXISTS files_added ON files(added_at DESC,id); CREATE INDEX IF NOT EXISTS files_dimensions ON files(height,width);
  CREATE INDEX IF NOT EXISTS artwork_tags_tag ON artwork_tags(tag_id,artwork_id); CREATE INDEX IF NOT EXISTS overrides_tag ON file_tag_overrides(tag_id,file_id,action); CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,next_run_at,priority);
  PRAGMA user_version=1;`);
    this.db.exec(AI_EFFECTIVE_SCHEMA);
    if (
      !(this.db.pragma("table_info(files)") as any[]).some(
        (x) => x.name === "cache_evicted",
      )
    )
      this.db.exec(
        "ALTER TABLE files ADD COLUMN cache_evicted INTEGER NOT NULL DEFAULT 0",
      );
    this.db.exec(
      "UPDATE files SET format=CASE WHEN lower(relative_path) LIKE '%.jpg' OR lower(relative_path) LIKE '%.jpeg' THEN 'jpeg' WHEN lower(relative_path) LIKE '%.png' THEN 'png' ELSE format END WHERE format IS NULL",
    );
  }
  close() {
    if (this.db.open) this.db.close();
  }
  roots(): LibraryRoot[] {
    return this.db
      .prepare(
        "SELECT id,path,status,created_at createdAt,last_scan_at lastScanAt FROM roots ORDER BY created_at",
      )
      .all() as LibraryRoot[];
  }
  getRoot(rootId: string): LibraryRoot {
    const r = this.roots().find((x) => x.id === rootId);
    if (!r) throw new Error("ROOT_NOT_FOUND");
    return r;
  }
  validateRoot(directory: string, exceptId?: string) {
    const canonical = (value: string) => {
      try {
        return realpathSync(value);
      } catch {
        return path.resolve(value);
      }
    };
    const target = canonical(directory);
    const overlaps = (a: string, b: string) => {
      const rel = path.relative(a, b);
      return (
        !path.isAbsolute(rel) &&
        rel !== ".." &&
        !rel.startsWith(".." + path.sep)
      );
    };
    const data = canonical(this.dataDir);
    // A source may contain the data directory; scanning explicitly excludes it.
    // The data directory itself (or its descendants) cannot become a source.
    if (overlaps(data, target)) throw new Error("SOURCE_DATA_OVERLAP");
    for (const root of this.roots()) {
      if (
        root.id !== exceptId &&
        (overlaps(canonical(root.path), target) ||
          overlaps(target, canonical(root.path)))
      )
        throw new Error("ROOT_OVERLAP");
    }
    return target;
  }
  addRoot(directory: string): LibraryRoot {
    const existing = this.roots().find(
      (x) =>
        path.resolve(x.path).toLowerCase() ===
        path.resolve(directory).toLowerCase(),
    );
    if (existing) return existing;
    directory = this.validateRoot(directory);
    const rootId = id();
    this.db
      .prepare("INSERT INTO roots(id,path,created_at) VALUES(?,?,?)")
      .run(rootId, path.resolve(directory), Date.now());
    return this.getRoot(rootId);
  }
  removeRoot(rootId: string) {
    this.db.prepare("DELETE FROM roots WHERE id=?").run(rootId);
  }
  async resolveOriginal(fileId: string) {
    return safeResolve(this, fileId);
  }
  private selectSql() {
    return `SELECT f.id,f.root_id rootId,f.relative_path relativePath,f.bytes,f.mtime_ms mtimeMs,f.added_at addedAt,f.missing,f.artwork_id artworkId,f.page,f.candidate_artwork_id candidateArtworkId,f.favorite,f.rating,f.width,f.height,f.format,f.thumbnail_key thumbnailKey,a.title,c.name creatorName,z.palette_json paletteJson FROM files f LEFT JOIN artworks a ON a.id=f.artwork_id LEFT JOIN creators c ON c.id=a.creator_id LEFT JOIN features z ON z.file_id=f.id`;
  }
  private mapFile(row: any): FileItem {
    const { paletteJson, ...rest } = row;
    return {
      ...rest,
      missing: !!rest.missing,
      favorite: !!rest.favorite,
      ...(paletteJson ? { palette: JSON.parse(paletteJson) } : {}),
    };
  }
  getFile(fileId: string): FileItem {
    const row = this.db.prepare(this.selectSql() + " WHERE f.id=?").get(fileId);
    if (!row) throw new Error("FILE_NOT_FOUND");
    return this.mapFile(row);
  }
  detail(fileId: string) {
    const file = this.getFile(fileId);
    const row = this.db
      .prepare(
        "SELECT processing_error,feature_version,cache_evicted FROM files WHERE id=?",
      )
      .get(fileId) as any;
    const source = this.db
      .prepare(
        "SELECT a.*,c.name creator_name FROM artworks a JOIN creators c ON c.id=a.creator_id WHERE a.id=?",
      )
      .get(file.artworkId) as any;
    const tags = (
      this.db
        .prepare(
          `SELECT t.id,t.name,t.category,EXISTS(SELECT 1 FROM artwork_tags at WHERE at.artwork_id=f.artwork_id AND at.tag_id=t.id) inherited,o.action override FROM files f CROSS JOIN tags t LEFT JOIN file_tag_overrides o ON o.file_id=f.id AND o.tag_id=t.id WHERE f.id=? AND (o.action IS NOT NULL OR EXISTS(SELECT 1 FROM artwork_tags at WHERE at.artwork_id=f.artwork_id AND at.tag_id=t.id))`,
        )
        .all(fileId) as any[]
    ).map((t) => ({
      ...t,
      inherited: !!t.inherited,
      effective:
        t.override !== "exclude" && (!!t.inherited || t.override === "add"),
      aliases: (
        this.db
          .prepare("SELECT alias FROM tag_aliases WHERE tag_id=?")
          .all(t.id) as any[]
      ).map((x) => x.alias),
      rawSource: this.db
        .prepare(
          "SELECT raw_name name,translation FROM artwork_tags WHERE artwork_id=? AND tag_id=?",
        )
        .all(file.artworkId, t.id),
    }));
    return {
      ...file,
      root: this.getRoot(file.rootId),
      tags,
      processing: {
        status: row.processing_error
          ? "error"
          : file.thumbnailKey
            ? "ready"
            : row.cache_evicted
              ? "evicted"
              : "pending",
        error: row.processing_error,
        algorithmVersion: row.feature_version,
      },
      source: source
        ? {
            id: source.id,
            title: source.title,
            creatorId: source.creator_id,
            creatorName: source.creator_name,
            pageCount: source.page_count,
            publishedAt: source.published_at,
            fetchedAt: source.fetched_at,
            url: "https://www.pixiv.net/artworks/" + source.id,
          }
        : null,
    };
  }
  setFavorite(fileIds: string[], value: boolean) {
    return this.db.transaction(() => {
      for (const fileId of fileIds) {
        this.getFile(fileId);
        this.db
          .prepare("UPDATE files SET favorite=? WHERE id=?")
          .run(+value, fileId);
      }
      return fileIds.length;
    })();
  }
  setRating(fileIds: string[], rating: number) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 5)
      throw new Error("INVALID_RATING");
    return this.db.transaction(() => {
      for (const fileId of fileIds) {
        this.getFile(fileId);
        this.db
          .prepare("UPDATE files SET rating=? WHERE id=?")
          .run(rating, fileId);
      }
      return fileIds.length;
    })();
  }
  enableAutomaticTags(scope: AutoTagScope) {
    this.getRoot(scope.rootId);
    const relative = directoryPath(scope.relativePath);
    return this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO ai_auto_scopes VALUES(?,?,?,?,?) ON CONFLICT(root_id,relative_path) DO UPDATE SET recursive=excluded.recursive,general_threshold=excluded.general_threshold,character_threshold=excluded.character_threshold",
        )
        .run(
          scope.rootId,
          relative,
          scope.recursive ? 1 : 0,
          WD_AUTO_GENERAL,
          WD_AUTO_CHARACTER,
        );
      return {
        scope: { ...scope, relativePath: relative },
        generalThreshold: WD_AUTO_GENERAL,
        characterThreshold: WD_AUTO_CHARACTER,
        registeredTags: this.registerAutomaticTags(),
      };
    })();
  }
  registerAutomaticTags(fileId?: string) {
    const automaticRows = this.db
      .prepare(automaticCandidateSelect(!!fileId))
      .all(...(fileId ? [fileId] : [])) as any[];
    const rows = [
      ...new Map(
        automaticRows.map((row) => [
          row.tag,
          { tag: row.tag, category: row.category },
        ]),
      ).values(),
    ];
    const ids = new Map<string, string>();
    let created = 0;
    for (const row of rows) {
      const key = this.db
        .prepare("SELECT tag_id FROM ai_tag_keys WHERE tag=?")
        .get(row.tag) as any;
      const alias = this.db
        .prepare(
          "SELECT tag_id FROM tag_aliases WHERE alias_key=normalize_text(?)",
        )
        .get(row.tag) as any;
      let tagId = key?.tag_id ?? alias?.tag_id;
      if (!tagId) {
        tagId = this.createTag(
          row.tag,
          row.category === "character" ? "character" : "content",
        );
        created++;
      }
      this.db
        .prepare("INSERT OR IGNORE INTO ai_tag_keys VALUES(?,?)")
        .run(row.tag, tagId);
      ids.set(row.tag, tagId);
      const translated = this.db
        .prepare("SELECT display_name FROM ai_lexicon WHERE tag=?")
        .get(row.tag) as any;
      if (translated && /[一-龥]/.test(translated.display_name)) {
        const taken = this.db
          .prepare(
            "SELECT tag_id FROM tag_aliases WHERE alias_key=normalize_text(?)",
          )
          .get(translated.display_name) as any;
        if (!taken || taken.tag_id === tagId)
          this.addAlias(tagId, translated.display_name);
      }
    }
    if (fileId)
      this.db
        .prepare("DELETE FROM ai_automatic_tags WHERE file_id=?")
        .run(fileId);
    else this.db.prepare("DELETE FROM ai_automatic_tags").run();
    const save = this.db.prepare(
      "INSERT INTO ai_automatic_tags VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(file_id,tag) DO UPDATE SET tag_id=excluded.tag_id,category=excluded.category,score=excluded.score,input_fingerprint=excluded.input_fingerprint,model_version=excluded.model_version,bytes=excluded.bytes,mtime_ms=excluded.mtime_ms",
    );
    for (const r of automaticRows)
      save.run(
        r.file_id,
        r.tag,
        ids.get(r.tag),
        r.category,
        r.score,
        r.input_fingerprint,
        r.model_version,
        r.bytes,
        r.mtime_ms,
      );
    return created;
  }
  effectiveTag(tagId: string) {
    return `(EXISTS(SELECT 1 FROM artwork_tags at WHERE at.artwork_id=f.artwork_id AND at.tag_id=${tagId}) OR EXISTS(SELECT 1 FROM file_tag_overrides ot WHERE ot.file_id=f.id AND ot.tag_id=${tagId} AND ot.action='add') OR EXISTS(SELECT 1 FROM danbooru_tags dt WHERE dt.file_id=f.id AND dt.tag_id=${tagId}) OR EXISTS(SELECT 1 FROM ai_auto_effective ae WHERE ae.file_id=f.id AND ae.tag_id=${tagId}) OR EXISTS(SELECT 1 FROM ai_reviews ar WHERE ar.file_id=f.id AND ar.tag_id=${tagId} AND ar.action='accept')) AND NOT EXISTS(SELECT 1 FROM file_tag_overrides ex WHERE ex.file_id=f.id AND ex.tag_id=${tagId} AND ex.action='exclude')`;
  }
  private textTagFileIds(pattern: string): string[] {
    const rows = this.db
      .prepare(
        `WITH translated AS MATERIALIZED(SELECT tag FROM ai_lexicon WHERE normalize_text(display_name) LIKE ? ESCAPE '\\'), matching AS MATERIALIZED(SELECT tag_id FROM tag_aliases WHERE alias_key LIKE ? ESCAPE '\\' UNION SELECT k.tag_id FROM ai_tag_keys k JOIN translated x ON x.tag=k.tag UNION SELECT d.tag_id FROM danbooru_tags d JOIN translated x ON x.tag=d.raw_name), related AS (SELECT r.file_id,r.tag_id FROM ai_reviews r JOIN translated x ON x.tag=r.tag WHERE r.tag_id IS NOT NULL AND r.action='accept' UNION SELECT f.id file_id,a.tag_id FROM artwork_tags a JOIN matching m ON m.tag_id=a.tag_id JOIN files f ON f.artwork_id=a.artwork_id UNION SELECT o.file_id,o.tag_id FROM file_tag_overrides o JOIN matching m ON m.tag_id=o.tag_id WHERE o.action='add' UNION SELECT r.file_id,r.tag_id FROM ai_reviews r JOIN matching m ON m.tag_id=r.tag_id WHERE r.action='accept' UNION SELECT d.file_id,d.tag_id FROM danbooru_tags d JOIN matching m ON m.tag_id=d.tag_id UNION SELECT a.file_id,a.tag_id FROM ai_auto_effective a JOIN matching m ON m.tag_id=a.tag_id) SELECT DISTINCT r.file_id FROM related r WHERE NOT EXISTS(SELECT 1 FROM file_tag_overrides o WHERE o.file_id=r.file_id AND o.tag_id=r.tag_id AND o.action='exclude')`,
      )
      .all(pattern, pattern) as any[];
    return rows.map((r) => r.file_id);
  }
  query(req: QueryRequest = {}): QueryResult {
    const filters: Filter[] = [];
    const expand = (f: Filter, seen = new Set<string>()) => {
      const copy = { ...f };
      if (f.collectionId) {
        if (seen.has(f.collectionId)) throw new Error("COLLECTION_CYCLE");
        const collection = this.db
          .prepare("SELECT * FROM collections WHERE id=?")
          .get(f.collectionId) as any;
        if (collection?.kind === "smart") {
          seen.add(f.collectionId);
          delete copy.collectionId;
          expand(JSON.parse(collection.filter_json), seen);
        }
      }
      filters.push(copy);
    };
    expand(req.filter ?? {});
    const where: string[] = [];
    if (this.aiScores) where.push("ai_similarity(f.id) IS NOT NULL");
    const args: any[] = [];
    const add = (sql: string, ...values: any[]) => {
      where.push(sql);
      args.push(...values);
    };
    const list = (col: string, values: string[] | undefined) => {
      if (values?.length)
        add(`${col} IN (${values.map(() => "?").join(",")})`, ...values);
    };
    for (const filter of filters) {
      list("f.root_id", filter.rootIds);
      if (filter.directory) {
        const scope = directoryPath(filter.directory.relativePath);
        add("f.root_id=?", filter.directory.rootId);
        if (scope)
          add(
            "replace(f.relative_path,char(92),'/') LIKE ? ESCAPE '\\'",
            scope.replace(/[\\%_]/g, "\\$&") + "/%",
          );
      }
      list(
        "f.format",
        filter.formats?.map((x) => x.toLowerCase()),
      );
      list("f.artwork_id", filter.artworkIds);
      list("a.creator_id", filter.creatorIds);
      if (filter.favorite !== undefined) add("f.favorite=?", +filter.favorite);
      if (filter.missing !== undefined) add("f.missing=?", +filter.missing);
      for (const [key, col, op] of [
        ["ratingMin", "f.rating", ">="],
        ["ratingMax", "f.rating", "<="],
        ["widthMin", "f.width", ">="],
        ["widthMax", "f.width", "<="],
        ["heightMin", "f.height", ">="],
        ["heightMax", "f.height", "<="],
        ["bytesMin", "f.bytes", ">="],
        ["bytesMax", "f.bytes", "<="],
        ["pixelsMin", "(f.width*f.height)", ">="],
        ["pixelsMax", "(f.width*f.height)", "<="],
        ["addedAfter", "f.added_at", ">="],
        ["publishedAfter", "a.published_at", ">="],
        ["publishedBefore", "a.published_at", "<="],
      ] as const) {
        if (filter[key] !== undefined) add(`${col}${op}?`, filter[key]);
      }
      if (filter.orientation === "portrait") add("f.height>f.width");
      if (filter.orientation === "landscape") add("f.width>f.height");
      if (filter.orientation === "square") add("f.width=f.height");
      if (filter.aspect !== undefined)
        add(
          "ABS(1.0*f.width/NULLIF(f.height,0)-?)<=?",
          filter.aspect,
          filter.aspectTolerance ?? 0.03,
        );
      if (filter.text) {
        const t = "%" + normalize(filter.text).replace(/[\\%_]/g, "\\$&") + "%";
        const tagFiles = this.textTagFileIds(t);
        add(
          `(normalize_text(f.relative_path) LIKE ? ESCAPE '\\' OR normalize_text(a.title) LIKE ? ESCAPE '\\' OR normalize_text(c.name) LIKE ? ESCAPE '\\' OR f.id IN (SELECT value FROM json_each(?)))`,
          t,
          t,
          t,
          JSON.stringify(tagFiles),
        );
      }
      for (const group of filter.tags ?? []) {
        if (group.ids.length) {
          const parts = group.ids.map(() => `(${this.effectiveTag("?")})`); // each tag placeholder appears six times
          add(
            "(" + parts.join(group.mode === "all" ? " AND " : " OR ") + ")",
            ...group.ids.flatMap((x) => [x, x, x, x, x, x]),
          );
        }
      }
      for (const tag of filter.excludeTagIds ?? [])
        add(`NOT (${this.effectiveTag("?")})`, tag, tag, tag, tag, tag, tag);
      if (filter.collectionId)
        add(
          "EXISTS(SELECT 1 FROM collection_items ci WHERE ci.collection_id=? AND ci.file_id=f.id)",
          filter.collectionId,
        );
      if (filter.unorganized)
        add(
          `f.favorite=0 AND f.rating=0 AND NOT EXISTS(SELECT 1 FROM file_tag_overrides o WHERE o.file_id=f.id) AND NOT EXISTS(SELECT 1 FROM collection_items ci WHERE ci.file_id=f.id)`,
        );
      if (filter.enrichmentStatus?.length)
        add(
          `EXISTS(SELECT 1 FROM jobs j WHERE j.artwork_id=f.artwork_id AND j.status IN (${filter.enrichmentStatus.map(() => "?").join(",")}))`,
          ...filter.enrichmentStatus,
        );
      if (filter.tone) {
        const t = filter.tone;
        if (t.warmth) add("z.warmth=?", t.warmth);
        for (const [key, col, op] of [
          ["brightnessMin", "z.brightness", ">="],
          ["brightnessMax", "z.brightness", "<="],
          ["saturationMin", "z.saturation", ">="],
          ["saturationMax", "z.saturation", "<="],
        ] as const)
          if (t[key] !== undefined) add(`${col}${op}?`, t[key]);
      }
    }
    const base =
      this.selectSql() + (where.length ? " WHERE " + where.join(" AND ") : "");
    const sorts = {
      added_desc: "f.added_at DESC,f.id",
      name: "f.relative_path COLLATE NOCASE,f.id",
      rating_desc: "f.rating DESC,f.id",
      pixels_desc: "(f.width*f.height) DESC,f.id",
      color: "f.id",
    };
    const offset = clamp(req.offset, 0, 1e9, 0),
      limit = clamp(req.limit, 1, this.bulkQuery ? 1e9 : 500, 100);
    let queryBase = this.aiScores
      ? base.replace(
          "SELECT f.id,",
          "SELECT ai_similarity(f.id) semanticScore,f.id,",
        )
      : base;
    let order = this.aiScores
      ? "ai_similarity(f.id) DESC,f.id"
      : sorts[req.sort ?? "added_desc"];
    let distanceOrder = "NULL";
    for (const filter of filters) {
      if (filter.color) {
        const color = filter.color;
        if (!/^#[0-9a-f]{6}$/i.test(color.hex))
          throw new Error("INVALID_COLOR");
        const colorExpr = `palette_distance(z.palette_json, '${color.hex}', ${clamp(color.minWeight, 0, 1, 0.08)})`;
        const condition = `(${colorExpr}<=${clamp(color.tolerance, 0, 200, 35)}${color.includeUnanalyzed ? " OR z.file_id IS NULL" : ""})`;
        if (color.restrict !== false)
          queryBase += queryBase.includes(" WHERE ")
            ? " AND " + condition
            : " WHERE " + condition;
        if (req.sort === "color" && !this.aiScores) {
          distanceOrder = colorExpr;
          order = colorExpr + " ASC NULLS LAST,f.id";
        }
      }
    }
    if (req.stackArtworks) {
      const inner = queryBase
        .replace(
          "SELECT ",
          `SELECT ${distanceOrder} colorDistance,ROW_NUMBER() OVER(PARTITION BY COALESCE(f.artwork_id,f.id) ORDER BY ${order}) stackRow,COUNT(*) OVER(PARTITION BY COALESCE(f.artwork_id,f.id)) matchedCount,COALESCE(lc.localCount,1) localCount,`,
        )
        .replace(
          " FROM files f LEFT JOIN",
          " FROM files f LEFT JOIN (SELECT artwork_id,COUNT(*) localCount FROM files WHERE artwork_id IS NOT NULL GROUP BY artwork_id) lc ON lc.artwork_id=f.artwork_id LEFT JOIN",
        );
      const grouped = "SELECT * FROM (" + inner + ") WHERE stackRow=1";
      const total = (
        this.db
          .prepare("SELECT COUNT(*) n FROM (" + grouped + ")")
          .get(...args) as any
      ).n;
      const publicOrder = this.aiScores
        ? "semanticScore DESC,id"
        : req.sort === "color"
          ? "colorDistance ASC NULLS LAST,id"
          : req.sort === "name"
            ? "relativePath COLLATE NOCASE,id"
            : req.sort === "rating_desc"
              ? "rating DESC,id"
              : req.sort === "pixels_desc"
                ? "width*height DESC,id"
                : "addedAt DESC,id";
      return {
        items: this.db
          .prepare(grouped + " ORDER BY " + publicOrder + " LIMIT ? OFFSET ?")
          .all(...args, limit, offset)
          .map((row) => this.mapFile(row)),
        total,
        offset,
        limit,
      };
    }
    const total = (
      this.db
        .prepare("SELECT COUNT(*) n FROM (" + queryBase + ")")
        .get(...args) as any
    ).n;
    return {
      items: this.db
        .prepare(queryBase + " ORDER BY " + order + " LIMIT ? OFFSET ?")
        .all(...args, limit, offset)
        .map((row) => this.mapFile(row)),
      total,
      offset,
      limit,
    };
  }
  rankedQuery(req: QueryRequest, scores: Map<string, number>): QueryResult {
    this.aiScores = scores;
    try {
      return this.query(req);
    } finally {
      this.aiScores = null;
    }
  }
  queryAll(req: QueryRequest): import("../contracts.js").FileItem[] {
    this.bulkQuery = true;
    try {
      return this.query({ ...req, offset: 0, limit: 1e9, stackArtworks: false })
        .items;
    } finally {
      this.bulkQuery = false;
    }
  }
  authors(
    search = "",
    offset = 0,
    limit = 100,
  ): import("../api.js").AuthorDto[] {
    return this.db
      .prepare(
        `SELECT c.id,c.name,COUNT(f.id) usageCount FROM creators c LEFT JOIN artworks a ON a.creator_id=c.id LEFT JOIN files f ON f.artwork_id=a.id WHERE instr(normalize_text(c.name),?)>0 GROUP BY c.id ORDER BY normalize_text(c.name),c.id LIMIT ? OFFSET ?`,
      )
      .all(
        normalize(search),
        clamp(limit, 1, 500, 100),
        clamp(offset, 0, 1e9, 0),
      ) as import("../api.js").AuthorDto[];
  }
  deleteCollection(collectionId: string) {
    this.db.prepare("DELETE FROM collections WHERE id=?").run(collectionId);
  }
  tags(search = "", offset = 0, limit = 100, category?: TagCategory) {
    return this.db
      .prepare(
        `WITH effective AS (SELECT f.id file_id,at.tag_id FROM files f JOIN artwork_tags at ON at.artwork_id=f.artwork_id UNION SELECT file_id,tag_id FROM file_tag_overrides WHERE action='add' UNION SELECT file_id,tag_id FROM ai_reviews WHERE action='accept' AND tag_id IS NOT NULL UNION SELECT file_id,tag_id FROM danbooru_tags UNION SELECT file_id,tag_id FROM ai_auto_effective), counts AS (SELECT e.tag_id,COUNT(DISTINCT e.file_id) n FROM effective e LEFT JOIN file_tag_overrides o ON o.file_id=e.file_id AND o.tag_id=e.tag_id AND o.action='exclude' WHERE o.file_id IS NULL GROUP BY e.tag_id) SELECT t.*,(SELECT json_group_array(alias) FROM tag_aliases al WHERE al.tag_id=t.id) aliasesJson,COALESCE(counts.n,0) usageCount FROM tags t LEFT JOIN counts ON counts.tag_id=t.id WHERE (? IS NULL OR t.category=?) AND EXISTS(SELECT 1 FROM tag_aliases al WHERE al.tag_id=t.id AND instr(al.alias_key,?)>0) ORDER BY t.name,t.id LIMIT ? OFFSET ?`,
      )
      .all(
        category ?? null,
        category ?? null,
        normalize(search),
        clamp(limit, 1, 500, 100),
        clamp(offset, 0, 1e9, 0),
      )
      .map((r: any) => {
        const { aliasesJson, ...rest } = r;
        return { ...rest, aliases: JSON.parse(aliasesJson) };
      });
  }
  createTag(
    name: string,
    category: TagCategory = "uncategorized",
    aliases: string[] = [],
  ): string {
    return this.db.transaction(() => {
      const key = normalize(name);
      if (!key) throw new Error("EMPTY_TAG");
      if (
        this.db.prepare("SELECT 1 FROM tag_aliases WHERE alias_key=?").get(key)
      )
        throw new Error("ALIAS_CONFLICT");
      const tagId = id();
      this.db
        .prepare("INSERT INTO tags VALUES(?,?,?)")
        .run(tagId, name.trim(), category);
      for (const alias of new Set([name, ...aliases]))
        this.addAlias(tagId, alias);
      return tagId;
    })();
  }
  addAlias(tagId: string, alias: string) {
    const key = normalize(alias);
    if (!key) throw new Error("EMPTY_ALIAS");
    const existing = this.db
      .prepare("SELECT tag_id FROM tag_aliases WHERE alias_key=?")
      .get(key) as any;
    if (existing && existing.tag_id !== tagId)
      throw new Error("ALIAS_CONFLICT");
    this.db
      .prepare("INSERT OR IGNORE INTO tag_aliases VALUES(?,?,?)")
      .run(key, alias.trim(), tagId);
  }
  updateTag(tagId: string, changes: { name?: string; category?: TagCategory }) {
    this.db.transaction(() => {
      if (changes.name) {
        this.addAlias(tagId, changes.name);
        this.db
          .prepare("UPDATE tags SET name=? WHERE id=?")
          .run(changes.name.trim(), tagId);
      }
      if (changes.category)
        this.db
          .prepare("UPDATE tags SET category=? WHERE id=?")
          .run(changes.category, tagId);
    })();
  }
  overrideTags(
    fileIds: string[],
    tagIds: string[],
    action: "add" | "exclude" | "clear",
  ) {
    return this.db.transaction(() => {
      for (const fileId of fileIds) {
        this.getFile(fileId);
        for (const tagId of tagIds) {
          if (action === "clear")
            this.db
              .prepare(
                "DELETE FROM file_tag_overrides WHERE file_id=? AND tag_id=?",
              )
              .run(fileId, tagId);
          else
            this.db
              .prepare(
                "INSERT INTO file_tag_overrides VALUES(?,?,?) ON CONFLICT(file_id,tag_id) DO UPDATE SET action=excluded.action",
              )
              .run(fileId, tagId, action);
        }
      }
      return fileIds.length;
    })();
  }
  mergePreview(fromId: string, toId: string) {
    if (fromId === toId) throw new Error("SAME_TAG");
    for (const tagId of [fromId, toId])
      if (!this.db.prepare("SELECT 1 FROM tags WHERE id=?").get(tagId))
        throw new Error("TAG_NOT_FOUND");
    return {
      fromId,
      toId,
      files: this.query({ filter: { tags: [{ ids: [fromId] }] }, limit: 1 })
        .total,
      aliases: this.db
        .prepare("SELECT alias FROM tag_aliases WHERE tag_id=?")
        .all(fromId),
      overrideConflicts: this.db
        .prepare(
          "SELECT COUNT(*) n FROM file_tag_overrides a JOIN file_tag_overrides b ON a.file_id=b.file_id WHERE a.tag_id=? AND b.tag_id=? AND a.action!=b.action",
        )
        .get(fromId, toId),
    };
  }
  private organizationSnapshot(scope: {
    fileIds: string[];
    favorite: boolean;
    rating: boolean;
    tagIds: string[];
    createdTagIds: string[];
    collectionId?: string;
  }) {
    return {
      files: scope.fileIds.map((fileId) => {
        const file = this.getFile(fileId);
        return {
          id: fileId,
          ...(scope.favorite ? { favorite: file.favorite } : {}),
          ...(scope.rating ? { rating: file.rating } : {}),
        };
      }),
      overrides: scope.fileIds.flatMap((fileId) =>
        scope.tagIds.map((tagId) => ({
          fileId,
          tagId,
          action:
            (
              this.db
                .prepare(
                  "SELECT action FROM file_tag_overrides WHERE file_id=? AND tag_id=?",
                )
                .get(fileId, tagId) as any
            )?.action ?? null,
        })),
      ),
      ...(scope.collectionId
        ? {
            collection:
              this.db
                .prepare(
                  "SELECT id,kind,created_at FROM collections WHERE id=?",
                )
                .get(scope.collectionId) ?? null,
            members: scope.fileIds.map((fileId) => ({
              fileId,
              member: !!this.db
                .prepare(
                  "SELECT 1 FROM collection_items WHERE collection_id=? AND file_id=?",
                )
                .get(scope.collectionId!, fileId),
            })),
          }
        : {}),
      created: scope.createdTagIds.length
        ? this.tagSnapshot({
            tagIds: scope.createdTagIds,
            collectionIds: [],
            relations: true,
          })
        : null,
    };
  }
  applyOrganization(
    request: import("../api.js").MethodMap["organization.apply"]["request"],
  ) {
    return this.db.transaction(() => {
      const fileIds = [...new Set(request.fileIds)];
      for (const fileId of fileIds) this.getFile(fileId);
      if (
        request.collection &&
        (
          this.db
            .prepare("SELECT kind FROM collections WHERE id=?")
            .get(request.collection.collectionId) as any
        )?.kind !== "normal"
      )
        throw new Error("NORMAL_COLLECTION_REQUIRED");
      const createdTagIds: string[] = [];
      const tags = (request.tags ?? []).map((change) => {
        let tagId = change.tagId;
        if (change.name !== undefined) {
          tagId = (
            this.db
              .prepare("SELECT tag_id FROM tag_aliases WHERE alias_key=?")
              .get(normalize(change.name)) as any
          )?.tag_id;
          if (!tagId) {
            tagId = this.createTag(change.name);
            createdTagIds.push(tagId);
          }
        }
        if (
          !tagId ||
          !this.db.prepare("SELECT 1 FROM tags WHERE id=?").get(tagId)
        )
          throw new Error("TAG_NOT_FOUND");
        return { tagId, mode: change.mode };
      });
      const scope = {
        fileIds,
        ...(request.collection
          ? { collectionId: request.collection.collectionId }
          : {}),
        favorite: request.favorite !== undefined,
        rating: request.rating !== undefined,
        tagIds: [...new Set(tags.map((t) => t.tagId))],
        createdTagIds,
      };
      const before = this.organizationSnapshot(scope);
      if (request.favorite !== undefined)
        this.setFavorite(fileIds, request.favorite);
      if (request.rating !== undefined) this.setRating(fileIds, request.rating);
      for (const change of tags)
        this.overrideTags(
          fileIds,
          [change.tagId],
          change.mode === "inherit" ? "clear" : change.mode,
        );
      if (request.collection)
        this.collectionItems(
          request.collection.collectionId,
          fileIds,
          request.collection.mode === "remove",
        );
      const undoId = id();
      this.db
        .prepare("INSERT INTO organization_undo VALUES(?,?,?,?)")
        .run(
          undoId,
          JSON.stringify(scope),
          JSON.stringify(before),
          JSON.stringify(this.organizationSnapshot(scope)),
        );
      return { undoId };
    })();
  }
  undoOrganization(undoId: string) {
    this.db.transaction(() => {
      const record = this.db
        .prepare("SELECT * FROM organization_undo WHERE id=?")
        .get(undoId) as any;
      if (!record) throw new Error("UNDO_NOT_FOUND");
      const scope = JSON.parse(record.scope_json);
      let current: unknown;
      try {
        current = this.organizationSnapshot(scope);
      } catch {
        throw new Error("UNDO_CONFLICT");
      }
      if (JSON.stringify(current) !== record.after_json)
        throw new Error("UNDO_CONFLICT");
      // New smart rules referencing a newly created tag must not become dangling.
      for (const row of this.db
        .prepare("SELECT filter_json FROM collections WHERE kind='smart'")
        .all() as any[]) {
        const filter = JSON.parse(row.filter_json);
        if (
          scope.createdTagIds.some(
            (tagId: string) =>
              (filter.excludeTagIds ?? []).includes(tagId) ||
              (filter.tags ?? []).some((g: any) => g.ids.includes(tagId)),
          )
        )
          throw new Error("UNDO_CONFLICT");
      }
      const before = JSON.parse(record.before_json);
      if (scope.collectionId) {
        for (const row of before.members)
          this.collectionItems(scope.collectionId, [row.fileId], !row.member);
      }
      for (const file of before.files) {
        if (scope.favorite) this.setFavorite([file.id], file.favorite);
        if (scope.rating) this.setRating([file.id], file.rating);
      }
      for (const row of before.overrides) {
        this.db
          .prepare(
            "DELETE FROM file_tag_overrides WHERE file_id=? AND tag_id=?",
          )
          .run(row.fileId, row.tagId);
        if (row.action)
          this.db
            .prepare("INSERT INTO file_tag_overrides VALUES(?,?,?)")
            .run(row.fileId, row.tagId, row.action);
      }
      for (const tagId of scope.createdTagIds)
        this.db.prepare("DELETE FROM tags WHERE id=?").run(tagId);
      this.db.prepare("DELETE FROM organization_undo WHERE id=?").run(undoId);
    })();
  }
  private tagSnapshot(scope: {
    tagIds: string[];
    collectionIds: string[];
    relations: boolean;
  }) {
    const q = scope.tagIds.map(() => "?").join(",");
    const snapshot: Record<string, any[]> = {
      tags: this.db
        .prepare(`SELECT * FROM tags WHERE id IN (${q}) ORDER BY id`)
        .all(...scope.tagIds),
    };
    if (scope.relations) {
      for (const table of [
        "tag_aliases",
        "artwork_tags",
        "file_tag_overrides",
        "ai_reviews",
        "ai_tag_keys",
        "ai_automatic_tags",
        "danbooru_tags",
      ])
        snapshot[table] = this.db
          .prepare(
            `SELECT * FROM ${table} WHERE tag_id IN (${q}) ORDER BY rowid`,
          )
          .all(...scope.tagIds)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      snapshot.collections = scope.collectionIds.map(
        (id) =>
          this.db
            .prepare("SELECT id,filter_json FROM collections WHERE id=?")
            .get(id) ?? null,
      );
    }
    return snapshot;
  }
  private recordTagUndo(
    scope: { tagIds: string[]; collectionIds: string[]; relations: boolean },
    before: unknown,
  ) {
    const undoId = id();
    this.db
      .prepare("INSERT INTO tag_undo VALUES(?,?,?,?)")
      .run(
        undoId,
        JSON.stringify(scope),
        JSON.stringify(before),
        JSON.stringify(this.tagSnapshot(scope)),
      );
    return { undoId };
  }
  classifyTags(tagIds: string[], category: TagCategory) {
    return this.db.transaction(() => {
      const scope = {
        tagIds: [...new Set(tagIds)],
        collectionIds: [],
        relations: false,
      };
      const before = this.tagSnapshot(scope);
      if (!scope.tagIds.length || before.tags.length !== scope.tagIds.length)
        throw new Error("TAG_NOT_FOUND");
      for (const tagId of scope.tagIds) this.updateTag(tagId, { category });
      return this.recordTagUndo(scope, before);
    })();
  }
  undoTags(undoId: string) {
    this.db.transaction(() => {
      const record = this.db
        .prepare("SELECT * FROM tag_undo WHERE id=?")
        .get(undoId) as any;
      if (!record) throw new Error("UNDO_NOT_FOUND");
      const scope = JSON.parse(record.scope_json);
      const current = this.tagSnapshot(scope);
      if (
        !Object.hasOwn(JSON.parse(record.after_json), "ai_automatic_tags") &&
        !current.ai_automatic_tags?.length
      )
        delete current.ai_automatic_tags;
      if (
        !Object.hasOwn(JSON.parse(record.after_json), "ai_tag_keys") &&
        !current.ai_tag_keys?.length
      )
        delete current.ai_tag_keys;
      if (
        !Object.hasOwn(JSON.parse(record.after_json), "danbooru_tags") &&
        !current.danbooru_tags?.length
      )
        delete current.danbooru_tags;
      if (
        !Object.hasOwn(JSON.parse(record.after_json), "ai_reviews") &&
        !current.ai_reviews?.length
      )
        delete current.ai_reviews;
      if (JSON.stringify(current) !== record.after_json)
        throw new Error("UNDO_CONFLICT");
      const before = JSON.parse(record.before_json);
      const q = scope.tagIds.map(() => "?").join(",");
      if (scope.relations) {
        for (const table of [
          "tag_aliases",
          "artwork_tags",
          "file_tag_overrides",
          "ai_reviews",
          "ai_tag_keys",
          "ai_automatic_tags",
          "danbooru_tags",
        ])
          this.db
            .prepare(`DELETE FROM ${table} WHERE tag_id IN (${q})`)
            .run(...scope.tagIds);
      }
      for (const row of before.tags)
        this.db
          .prepare(
            "INSERT INTO tags VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category",
          )
          .run(row.id, row.name, row.category);
      if (scope.relations) {
        for (const table of [
          "tag_aliases",
          "artwork_tags",
          "file_tag_overrides",
          "ai_reviews",
          "ai_tag_keys",
          "ai_automatic_tags",
          "danbooru_tags",
        ]) {
          for (const row of before[table] ?? []) {
            const columns = Object.keys(row);
            this.db
              .prepare(
                `INSERT INTO ${table} (${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
              )
              .run(...Object.values(row));
          }
        }
        for (const row of before.collections)
          this.db
            .prepare("UPDATE collections SET filter_json=? WHERE id=?")
            .run(row.filter_json, row.id);
      }
      this.db.prepare("DELETE FROM tag_undo WHERE id=?").run(undoId);
    })();
  }
  mergeTags(fromId: string, toId: string) {
    const preview = this.mergePreview(fromId, toId);
    return this.db.transaction(() => {
      const collectionIds = (
        this.db
          .prepare("SELECT id,filter_json FROM collections WHERE kind='smart'")
          .all() as any[]
      )
        .filter((row) => {
          const rule = JSON.parse(row.filter_json);
          return (
            (rule.tags ?? []).some((g: any) => g.ids.includes(fromId)) ||
            (rule.excludeTagIds ?? []).includes(fromId)
          );
        })
        .map((row) => row.id);
      const scope = { tagIds: [fromId, toId], collectionIds, relations: true };
      const before = this.tagSnapshot(scope);
      this.db
        .prepare("UPDATE tag_aliases SET tag_id=? WHERE tag_id=?")
        .run(toId, fromId);
      this.db
        .prepare("UPDATE artwork_tags SET tag_id=? WHERE tag_id=?")
        .run(toId, fromId);
      this.db
        .prepare("UPDATE danbooru_tags SET tag_id=? WHERE tag_id=?")
        .run(toId, fromId);
      this.db
        .prepare("UPDATE ai_automatic_tags SET tag_id=? WHERE tag_id=?")
        .run(toId, fromId);
      this.db
        .prepare("UPDATE ai_tag_keys SET tag_id=? WHERE tag_id=?")
        .run(toId, fromId);
      this.db
        .prepare("UPDATE ai_reviews SET tag_id=? WHERE tag_id=?")
        .run(toId, fromId);
      this.db
        .prepare(
          `INSERT INTO file_tag_overrides SELECT file_id,?,action FROM file_tag_overrides WHERE tag_id=? ON CONFLICT(file_id,tag_id) DO UPDATE SET action=CASE WHEN action='exclude' OR excluded.action='exclude' THEN 'exclude' ELSE 'add' END`,
        )
        .run(toId, fromId);
      this.db
        .prepare("DELETE FROM file_tag_overrides WHERE tag_id=?")
        .run(fromId);
      for (const collection of this.db
        .prepare("SELECT id,filter_json FROM collections WHERE kind='smart'")
        .all() as any[]) {
        if (!collectionIds.includes(collection.id)) continue;
        const rule = JSON.parse(collection.filter_json);
        for (const group of rule.tags ?? [])
          group.ids = [
            ...new Set(group.ids.map((x: string) => (x === fromId ? toId : x))),
          ];
        if (rule.excludeTagIds)
          rule.excludeTagIds = [
            ...new Set(
              rule.excludeTagIds.map((x: string) => (x === fromId ? toId : x)),
            ),
          ];
        this.db
          .prepare("UPDATE collections SET filter_json=? WHERE id=?")
          .run(JSON.stringify(rule), collection.id);
      }
      this.db.prepare("DELETE FROM tags WHERE id=?").run(fromId);
      return { ...preview, ...this.recordTagUndo(scope, before) };
    })();
  }
  applyArtwork(payload: ArtworkPayload) {
    if (
      !/^\d{5,12}$/.test(payload.id) ||
      !Number.isInteger(payload.pageCount) ||
      payload.pageCount < 1 ||
      payload.pageCount > 10000 ||
      !payload.creator.id ||
      !payload.title ||
      !Array.isArray(payload.tags)
    )
      throw new Error("INVALID_ARTWORK");
    if (
      this.db
        .prepare("SELECT 1 FROM files WHERE artwork_id=? AND page>=?")
        .get(payload.id, payload.pageCount)
    )
      throw new Error("PAGE_OUT_OF_RANGE");
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO creators VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
        )
        .run(payload.creator.id, payload.creator.name);
      this.db
        .prepare(
          "INSERT INTO artworks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,creator_id=excluded.creator_id,page_count=excluded.page_count,published_at=excluded.published_at,fetched_at=excluded.fetched_at",
        )
        .run(
          payload.id,
          payload.title,
          payload.creator.id,
          payload.pageCount,
          payload.publishedAt,
          Date.now(),
        );
      this.db
        .prepare("DELETE FROM artwork_tags WHERE artwork_id=?")
        .run(payload.id);
      for (const tag of payload.tags) {
        const existing = this.db
          .prepare("SELECT tag_id FROM tag_aliases WHERE alias_key=?")
          .get(normalize(tag.name)) as any;
        const tagId = existing?.tag_id ?? this.createTag(tag.name);
        this.db
          .prepare("INSERT OR REPLACE INTO artwork_tags VALUES(?,?,?,?)")
          .run(payload.id, tagId, tag.name, tag.translation ?? null);
      }
      this.db
        .prepare("INSERT INTO source_snapshots VALUES(?,?,?,?)")
        .run(id(), payload.id, Date.now(), JSON.stringify(payload.raw));
    })();
  }
  collections() {
    return this.db
      .prepare(
        "SELECT id,name,kind,filter_json filterJson,created_at createdAt FROM collections ORDER BY created_at",
      )
      .all()
      .map((r: any) => {
        const { filterJson, ...rest } = r;
        return { ...rest, filter: filterJson ? JSON.parse(filterJson) : null };
      });
  }
  createCollection(name: string, kind: "normal" | "smart", filter?: Filter) {
    const collectionId = id();
    if (kind === "smart" && !filter) throw new Error("SMART_FILTER_REQUIRED");
    this.db
      .prepare("INSERT INTO collections VALUES(?,?,?,?,?)")
      .run(
        collectionId,
        name,
        kind,
        filter ? JSON.stringify(filter) : null,
        Date.now(),
      );
    return collectionId;
  }
  updateCollection(
    collectionId: string,
    changes: { name?: string; filter?: Filter },
  ) {
    if (changes.filter?.collectionId === collectionId)
      throw new Error("COLLECTION_CYCLE");
    if (changes.name)
      this.db
        .prepare("UPDATE collections SET name=? WHERE id=?")
        .run(changes.name, collectionId);
    if (changes.filter)
      this.db
        .prepare(
          "UPDATE collections SET filter_json=? WHERE id=? AND kind='smart'",
        )
        .run(JSON.stringify(changes.filter), collectionId);
  }
  collectionItems(collectionId: string, fileIds: string[], remove = false) {
    const row = this.db
      .prepare("SELECT kind FROM collections WHERE id=?")
      .get(collectionId) as any;
    if (row?.kind !== "normal") throw new Error("NORMAL_COLLECTION_REQUIRED");
    this.db.transaction(() => {
      for (const fileId of fileIds)
        this.db
          .prepare(
            remove
              ? "DELETE FROM collection_items WHERE collection_id=? AND file_id=?"
              : "INSERT OR IGNORE INTO collection_items VALUES(?,?)",
          )
          .run(collectionId, fileId);
    })();
  }
  private async safeOutput(destination: string) {
    if (!path.isAbsolute(destination))
      throw new Error("ABSOLUTE_OUTPUT_REQUIRED");
    const parent = await realpath(path.dirname(destination));
    const target = path.join(parent, path.basename(destination));
    const inside = (base: string) => {
      const rel = path.relative(base, target);
      return (
        rel === "" ||
        (!rel.startsWith(".." + path.sep) &&
          rel !== ".." &&
          !path.isAbsolute(rel))
      );
    };
    for (const root of this.roots()) {
      let actual = root.path;
      try {
        actual = await realpath(root.path);
      } catch {}
      if (inside(actual)) throw new Error("SOURCE_OUTPUT_FORBIDDEN");
    }
    if (
      inside(path.join(this.dataDir, "thumbnails")) ||
      ["catalog.sqlite", "catalog.sqlite-wal", "catalog.sqlite-shm"].some(
        (name) =>
          target.toLowerCase() === path.join(this.dataDir, name).toLowerCase(),
      )
    )
      throw new Error("CATALOG_OUTPUT_FORBIDDEN");
    try {
      await lstat(target);
      throw new Error("OUTPUT_EXISTS");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    return target;
  }
  async backup(destination: string) {
    const target = await this.safeOutput(destination);
    await this.db.backup(target);
    return target;
  }
  async restore(source: string) {
    const incoming = new Database(source, {
      readonly: true,
      fileMustExist: true,
    });
    const tables = [
      "roots",
      "files",
      "creators",
      "artworks",
      "tags",
      "tag_aliases",
      "artwork_tags",
      "file_tag_overrides",
      "collections",
      "collection_items",
      "features",
      "jobs",
      "source_snapshots",
      "source_state",
    ];
    const temp = path.join(this.dataDir, "restore-" + id() + ".sqlite");
    const aiTables = (
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'ai_*' OR name GLOB 'danbooru_*' OR name GLOB 'local_cancelled_*')",
        )
        .all() as any[]
    )
      .map((row) => String(row.name))
      .filter((name) => (/^(ai|danbooru)_[a-z_]+$/.test(name)||['local_cancelled_images','local_cancelled_roots'].includes(name)));
    try {
      if (
        incoming.pragma("integrity_check", { simple: true }) !== "ok" ||
        incoming.pragma("user_version", { simple: true }) !== 1
      )
        throw new Error("INVALID_BACKUP");
      for (const table of tables)
        incoming.prepare("SELECT * FROM " + table + " LIMIT 0").all();
      await incoming.backup(temp);
      this.db.prepare("ATTACH DATABASE ? AS incoming").run(temp);
      try {
        this.db.transaction(() => {
          this.db.exec("DELETE FROM tag_undo;DELETE FROM organization_undo");
          for (const table of aiTables) this.db.exec("DELETE FROM " + table);
          for (const table of [...tables].reverse())
            this.db.exec("DELETE FROM " + table);
          for (const table of tables)
            this.db.exec(
              "INSERT INTO " + table + " SELECT * FROM incoming." + table,
            );
          for (const table of aiTables)
            if (
              incoming
                .prepare(
                  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                )
                .get(table)
            )
              this.db.exec(
                "INSERT INTO " + table + " SELECT * FROM incoming." + table,
              );
          if (aiTables.includes("ai_jobs"))
            this.db.exec(
              "UPDATE ai_jobs SET status='waiting' WHERE status='running'",
            );
          this.db.exec(
            "UPDATE jobs SET status='waiting' WHERE status='running';UPDATE files SET thumbnail_key=NULL,cache_evicted=0",
          );
        })();
      } finally {
        this.db.exec("DETACH DATABASE incoming");
      }
      return this.stats();
    } finally {
      incoming.close();
      await rm(temp, { force: true });
    }
  }

  async export(destination: string) {
    const target = await this.safeOutput(destination);
    const tables = [
      "roots",
      "files",
      "creators",
      "artworks",
      "tags",
      "tag_aliases",
      "artwork_tags",
      "file_tag_overrides",
      "collections",
      "collection_items",
      "features",
      "jobs",
      "source_snapshots",
    ];
    for (const row of this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'ai_*' OR name GLOB 'danbooru_*' OR name GLOB 'local_cancelled_*')",
      )
      .all() as any[])
      if ((/^(ai|danbooru)_[a-z_]+$/.test(row.name)||['local_cancelled_images','local_cancelled_roots'].includes(row.name))) tables.push(row.name);
    const snapshot = this.db.transaction(() =>
      Object.fromEntries(
        tables.map((t) => [t, this.db.prepare("SELECT * FROM " + t).all()]),
      ),
    )();
    await writeFile(
      target,
      JSON.stringify(
        {
          format: "image-finder-export",
          version: 1,
          exportedAt: new Date().toISOString(),
          ...snapshot,
        },
        null,
        2,
      ),
      { encoding: "utf8", flag: "wx" },
    );
    return target;
  }
  stats() {
    return {
      files: (this.db.prepare("SELECT COUNT(*) n FROM files").get() as any).n,
      roots: this.roots(),
      jobs: this.db
        .prepare("SELECT status,COUNT(*) count FROM jobs GROUP BY status")
        .all(),
      features: (
        this.db.prepare("SELECT COUNT(*) n FROM features").get() as any
      ).n,
    };
  }
}
