import {hasDotDirectory} from "./directory-policy.js";
import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Catalog } from "./catalog.js";
import type { LibraryRoot, ScanResult } from "../contracts.js";
import { userError } from "../user-errors.js";
import { isDataPath, dataPathExclusion } from "./data-path.js";

const supported = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".gif",
  ".tif",
  ".tiff",
]);
export function identifyArtwork(filename: string): {
  artworkId: string | null;
  page: number | null;
  candidateArtworkId: string | null;
} {
  const name = path.posix.parse(filename.replace(/\\/g, "/")).name;
  const match = /^([0-9]{5,12})_p([0-9]+)(?: \([1-9][0-9]*\))?$/.exec(name);
  if (match && Number.isSafeInteger(Number(match[2])))
    return {
      artworkId: match[1],
      page: Number(match[2]),
      candidateArtworkId: null,
    };
  return {
    artworkId: null,
    page: null,
    candidateArtworkId: /^[0-9]{5,12}$/.test(name) ? name : null,
  };
}
function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
/** Resolves only an indexed, regular original inside its real library root. */
export async function safeResolve(
  catalog: Catalog,
  fileId: string,
): Promise<string> {
  const file = catalog.getFile(fileId);
  const root = catalog.getRoot(file.rootId);
  if (
    path.isAbsolute(file.relativePath) ||
    !contained(
      path.resolve(root.path),
      path.resolve(root.path, file.relativePath),
    )
  )
    throw new Error("Unsafe original path");
  let actualRoot: string;
  try {
    actualRoot = await realpath(root.path);
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw new Error("原目录已离线，请检查磁盘连接，或在原目录页重新定位。");
    throw error;
  }
  let actualFile: string;
  try {
    actualFile = await realpath(path.resolve(root.path, file.relativePath));
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw new Error(
        "这张原图已不存在或已移动，请重新扫描目录确认；收藏、标签等整理信息仍保留。",
      );
    throw error;
  }
  if (!contained(actualRoot, actualFile))
    throw new Error("Original escapes library root");
  if (catalog.isManagedPath(actualFile))
    throw new Error("Data files are not originals");
  const info = await stat(actualFile);
  if (!info.isFile()) throw new Error("Original is not a regular file");
  const indexed = catalog.db
    .prepare("SELECT identity FROM files_visible WHERE id=?")
    .get(fileId) as { identity: string | null };
  if (
    info.size !== file.bytes ||
    info.mtimeMs !== file.mtimeMs ||
    (indexed.identity && indexed.identity !== `${info.dev}:${info.ino}`)
  )
    throw new Error("Original no longer matches indexed file; rescan required");
  return actualFile;
}

export class Scanner {
  constructor(private catalog: Catalog, private hooks: {observed?:(rootId:string,fileId:string,isNew:boolean,bytes:number,mtimeMs:number)=>void;scanned?:(rootId:string,result:ScanResult)=>void} = {}) {}
  async scan(
    rootId: string,
    options: {
      limit?: number;
      signal?: AbortSignal;
      onProgress?: (result: ScanResult) => void;
    } = {},
  ): Promise<ScanResult> {
    const started = Date.now();
    const result: ScanResult = {
      discovered: 0,
      added: 0,
      changed: 0,
      missing: 0,
      errors: [],
      complete: true,
      elapsedMs: 0,
    };
    const root = this.catalog.getRoot(rootId);
    const excluded = this.catalog.managedPathExclusion();
    if(hasDotDirectory(root.path))throw new Error("EXCLUDED_DIRECTORY");
    if (excluded(root.path))
      throw new Error("SOURCE_DATA_OVERLAP");
    const scanId = randomUUID();
    try {
      if (!(await stat(root.path)).isDirectory())
        throw new Error("原目录不是文件夹，请重新定位。");
    } catch (error) {
      this.catalog.db
        .prepare("UPDATE roots SET status='offline' WHERE id=?")
        .run(rootId);
      return {
        ...result,
        complete: false,
        errors: [
          `原目录无法访问，请检查磁盘连接或重新定位。${userError(error)}`,
        ],
        elapsedMs: Date.now() - started,
      };
    }
    const existing = this.catalog.db.prepare(
      "SELECT * FROM files_visible WHERE root_id=? AND relative_path=?",
    );
    const insert = this.catalog.db.prepare(
      `INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,identity,added_at,last_seen_scan,missing,artwork_id,page,candidate_artwork_id,format) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)`,
    );
    const update = this.catalog.db.prepare(
      `UPDATE files SET bytes=?,mtime_ms=?,identity=?,last_seen_scan=?,missing=0,width=CASE WHEN ? THEN NULL ELSE width END,height=CASE WHEN ? THEN NULL ELSE height END,thumbnail_key=CASE WHEN ? THEN NULL ELSE thumbnail_key END,feature_version=CASE WHEN ? THEN NULL ELSE feature_version END,processing_error=CASE WHEN ? THEN NULL ELSE processing_error END WHERE id=?`,
    );
    const queue = [root.path];
    const limit =
      options.limit === undefined ? Infinity : Math.max(0, options.limit);
    outer: while (queue.length) {
      if (options.signal?.aborted) {
        result.complete = false;
        break;
      }
      const directory = queue.pop()!;
      if (excluded(directory)) continue;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        result.errors.push(`无法读取子目录 ${directory}：${userError(error)}`);
        result.complete = false;
        continue;
      }
      for (const entry of entries) {
        if (options.signal?.aborted) {
          result.complete = false;
          break outer;
        }
        const absolute = path.join(directory, entry.name);
        // Never follow junctions or symbolic links into another tree.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if(entry.name.startsWith("."))continue;
          queue.push(absolute);
          continue;
        }
        if (
          !entry.isFile() ||
          !supported.has(path.extname(entry.name).toLowerCase())
        )
          continue;
        if (result.discovered >= limit) {
          result.complete = false;
          break outer;
        }
        try {
          const info = await stat(absolute);
          const relative = path.relative(root.path, absolute);
          const identity = `${info.dev}:${info.ino}`;
          let old = existing.get(rootId, relative) as
            | { id: string; bytes: number; mtime_ms: number; identity: string }
            | undefined;
          if (!old && info.nlink === 1 && info.ino !== 0) {
            const candidates = this.catalog.db
              .prepare(
                "SELECT id,relative_path,bytes,mtime_ms,identity FROM files_visible WHERE root_id=? AND identity=? AND bytes=? AND mtime_ms=?",
              )
              .all(rootId, identity, info.size, info.mtimeMs) as Array<{
              id: string;
              relative_path: string;
              bytes: number;
              mtime_ms: number;
              identity: string;
            }>;
            if (candidates.length === 1) {
              let priorExists = true;
              try {
                await stat(path.join(root.path, candidates[0].relative_path));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                  priorExists = false;
              }
              if (!priorExists) {
                old = candidates[0];
                const source = identifyArtwork(entry.name);
                this.catalog.db
                  .prepare(
                    "UPDATE files SET relative_path=?,artwork_id=?,page=?,candidate_artwork_id=? WHERE id=?",
                  )
                  .run(
                    relative,
                    source.artworkId,
                    source.page,
                    source.candidateArtworkId,
                    old.id,
                  );
              }
            }
          }
          result.discovered++;
          if (result.discovered % 128 === 0)
            options.onProgress?.({
              ...result,
              errors: [...result.errors],
              elapsedMs: Date.now() - started,
            });
          if (!old) {
            const source = identifyArtwork(entry.name);
            const fileId=randomUUID();
            insert.run(
              fileId,
              rootId,
              relative,
              info.size,
              info.mtimeMs,
              identity,
              Date.now(),
              scanId,
              source.artworkId,
              source.page,
              source.candidateArtworkId,
              ["jpg", "jpeg"].includes(
                path.extname(entry.name).slice(1).toLowerCase(),
              )
                ? "jpeg"
                : path.extname(entry.name).slice(1).toLowerCase(),
            );
            result.added++;
            this.hooks.observed?.(rootId,fileId,true,info.size,info.mtimeMs);
          } else {
            const changed =
              old.bytes !== info.size ||
              old.mtime_ms !== info.mtimeMs ||
              old.identity !== identity;
            update.run(
              info.size,
              info.mtimeMs,
              identity,
              scanId,
              ...Array(5).fill(changed ? 1 : 0),
              old.id,
            );
            if (changed) {
              this.catalog.db
                .prepare("UPDATE files SET cache_evicted=0 WHERE id=?")
                .run(old.id);
              this.catalog.db
                .prepare("DELETE FROM features WHERE file_id=?")
                .run(old.id);
              result.changed++;
              this.hooks.observed?.(rootId,old.id,false,info.size,info.mtimeMs);
            }
          }
        } catch (error) {
          result.errors.push(`无法读取图片 ${absolute}：${userError(error)}`);
          result.complete = false;
        }
      }
    }
    if (result.complete)
      result.missing = this.catalog.db
        .prepare(
          "UPDATE files SET missing=1 WHERE root_id=? AND (last_seen_scan IS NULL OR last_seen_scan<>?) AND missing=0",
        )
        .run(rootId, scanId).changes;
    this.catalog.db
      .prepare("UPDATE roots SET status=?,last_scan_at=? WHERE id=?")
      .run(result.complete ? "online" : "partial", Date.now(), rootId);
    result.elapsedMs = Date.now() - started;
    this.hooks.scanned?.(rootId,result);
    return result;
  }
  async relocateRoot(rootId: string, newPath: string): Promise<LibraryRoot> {
    const root = this.catalog.getRoot(rootId);
    let target: string;
    try {
      target = await realpath(newPath);
      if (!(await stat(target)).isDirectory())
        throw new Error("所选位置不是文件夹，请重新选择原目录。");
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw new Error(
          "所选目录当前不可用，请检查磁盘连接或文件夹位置后重试。",
        );
      throw error;
    }
    this.catalog.validateRoot(target, rootId);
    const duplicate = this.catalog.db
      .prepare("SELECT id FROM roots WHERE path=? AND id<>?")
      .get(target, rootId);
    if (duplicate) throw new Error("Directory is already indexed");
    // Re-selecting the same canonical directory is a reconnect, not a migration.
    // A stale missing=0 row must not block reconciliation of that directory.
    let previous = path.resolve(root.path);
    try {
      previous = await realpath(root.path);
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
    const sameRoot = path.relative(previous, target) === "";
    if (!sameRoot && contained(previous, target))
      throw new Error(
        `当前关联的是 ${root.path}；所选 ${target} 是它的子文件夹。请选原目录根文件夹，重新定位用于关联整个原目录移动后的新位置。原有索引已保留。`,
      );
    for(const row of this.catalog.db.prepare("SELECT relative_path FROM files WHERE root_id=?").all(rootId) as any[])if(String(row.relative_path).replace(/\\/g,"/").split("/").some(p=>p===".."))throw new Error("路径超出原目录");
    // Require three matches (or every not-yet-missing row in a smaller library).
    // Read bounded batches before awaiting filesystem I/O; never retain an active
    // SQLite cursor while another service operation can use the connection.
    const count = this.catalog.db
      .prepare("SELECT COUNT(*) n FROM files_visible WHERE root_id=? AND missing=0")
      .get(rootId) as { n: number };
    const required = Math.min(3, count.n);
    const batch = this.catalog.db.prepare(
      "SELECT relative_path,bytes,mtime_ms FROM files_visible WHERE root_id=? AND missing=0 AND (? IS NULL OR relative_path>?) ORDER BY relative_path LIMIT 128",
    );
    let after: string | null = null;
    let matched = 0;
    while (!sameRoot && matched < 20) {
      const samples = batch.all(rootId, after, after) as Array<{
        relative_path: string;
        bytes: number;
        mtime_ms: number;
      }>;
      if (!samples.length) break;
      after = samples.at(-1)!.relative_path;
      for (const sample of samples) {
        const candidate = path.resolve(target, sample.relative_path);
        if (
          path.isAbsolute(sample.relative_path) ||
          !contained(target, candidate)
        )
          throw new Error(
            "索引中的图片路径超出原目录，无法安全关联。原有索引已保留。",
          );
        let actual: string;
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          actual = await realpath(candidate);
          if (!contained(target, actual))
            throw new Error(
              "所选目录中的图片链接指向目录外，无法安全关联。原有索引已保留。",
            );
          info = await stat(actual);
        } catch (error) {
          if (
            ["ENOENT", "ENOTDIR"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            continue;
          throw error;
        }
        if (
          !info.isFile() ||
          info.size !== sample.bytes ||
          info.mtimeMs !== sample.mtime_ms
        )
          throw new Error(
            `所选目录与原索引不匹配（${sample.relative_path}）。请确认选择了原目录；原有索引已保留。`,
          );
        matched++;
        if (matched === 20) break;
      }
    }
    if (!sameRoot && (required === 0 || matched < required))
      throw new Error(
        `无法确认这是原目录：找到 ${matched} 张匹配图片，至少需要 ${required || 1} 张。请检查所选目录及原文件；原有索引已保留。`,
      );
    this.catalog.db
      .prepare("UPDATE roots SET path=?,status='partial' WHERE id=?")
      .run(target, rootId);
    return this.catalog.getRoot(rootId);
  }
}
