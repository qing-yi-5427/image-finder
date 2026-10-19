import path from "node:path";
import { createHash } from "node:crypto";
import type { Catalog } from "./catalog.js";
import { directoryPath } from "../directory-path.js";
import { isDataPath, canonicalPath, pathWithin } from "./data-path.js";
import type {
  PixivBatchScope,
  PixivBatchPreview,
} from "./pixiv-batch-contracts.js";
type Candidate = {
  id: string;
  relativePath: string;
  artworkId: string | null;
  jobId: string | null;
  status: string | null;
  hasSource: number;
};
export function pixivBatchSelection(
  catalog: Catalog,
  input: PixivBatchScope,
): {
  preview: PixivBatchPreview;
  artworks: Array<{
    artworkId: string;
    jobId: string | null;
    fileCount: number;
  }>;
} {
  const root = catalog.getRoot(input.rootId);
  const scope = { ...input, relativePath: directoryPath(input.relativePath) };
  const target = path.resolve(root.path, ...scope.relativePath.split("/"));
  if (catalog.isManagedPath(target))
    throw new Error("图库数据目录不会参与 Pixiv 补全。");
  const prefix = scope.relativePath ? scope.relativePath + "/" : "";
  const where = ["f.root_id=?", "f.missing=0"];
  const args: any[] = [scope.rootId];
  const normalized = "replace(f.relative_path,char(92),'/')";
  if (prefix) {
    where.push(`${normalized} LIKE ? ESCAPE '\\'`);
    args.push(prefix.replace(/[\\%_]/g, "\\$&") + "%");
  }
  if (!scope.recursive) {
    where.push(`instr(substr(${normalized},?),'/')=0`);
    args.push(prefix.length + 1);
  }
  // Resolve only the root/data locations. Scanning never descends through links,
  // so row filtering can stay lexical without synchronous per-image disk I/O.
  const actualRoot = canonicalPath(root.path);
  const actualData = canonicalPath(catalog.dataDir);
  const exclusions = new Set<string>();
  for (const [source, data] of [
    [path.resolve(root.path), path.resolve(catalog.dataDir)],
    [actualRoot, actualData],
  ])
    if (pathWithin(source, data)) {
      const relative = path.relative(source, data).replace(/\\/g, "/");
      if (relative) exclusions.add(relative);
    }
  for (const excluded of exclusions) {
    where.push(`${normalized} NOT LIKE ? ESCAPE '\\'`);
    args.push(excluded.replace(/[\\%_]/g, "\\$&") + "/%");
  }
  const rows = (
    catalog.db
      .prepare(
        `SELECT f.id,f.relative_path relativePath,f.artwork_id artworkId,j.id jobId,j.status,a.id IS NOT NULL hasSource FROM files_visible f LEFT JOIN jobs j ON j.artwork_id=f.artwork_id LEFT JOIN artworks a ON a.id=f.artwork_id WHERE ${where.join(" AND ")} ORDER BY f.id`,
      )
      .all(...args) as Candidate[]
  ).filter(
    (file) =>
      !pathWithin(
        catalog.dataDir,
        path.resolve(root.path, file.relativePath),
      ) && !pathWithin(actualData, path.resolve(actualRoot, file.relativePath)),
  );
  const groups = new Map<
    string,
    {
      artworkId: string;
      jobId: string | null;
      fileCount: number;
      status: string | null;
      hasSource: boolean;
    }
  >();
  let boundFileCount = 0;
  for (const row of rows) {
    if (!row.artworkId || !/^[1-9]\d{4,11}$/.test(row.artworkId)) continue;
    boundFileCount++;
    const existing = groups.get(row.artworkId);
    if (existing) existing.fileCount++;
    else
      groups.set(row.artworkId, {
        artworkId: row.artworkId,
        jobId: row.jobId,
        fileCount: 1,
        status: row.status,
        hasSource: !!row.hasSource,
      });
  }
  let queuedArtworkCount = 0,
    runningArtworkCount = 0,
    completedArtworkCount = 0,
    unavailableArtworkCount = 0;
  const artworks: Array<{
    artworkId: string;
    jobId: string | null;
    fileCount: number;
  }> = [];
  for (const row of groups.values()) {
    if (row.status === "running") {
      runningArtworkCount++;
      continue;
    }
    if (row.status === "waiting" || row.status === "retry_wait") {
      queuedArtworkCount++;
      continue;
    }
    if (row.status === "unavailable") {
      unavailableArtworkCount++;
      continue;
    }
    if (
      scope.mode === "missing_or_failed" &&
      row.hasSource &&
      !["failed", "needs_login"].includes(row.status ?? "")
    ) {
      completedArtworkCount++;
      continue;
    }
    artworks.push({
      artworkId: row.artworkId,
      jobId: row.jobId,
      fileCount: row.fileCount,
    });
  }
  artworks.sort((a, b) => a.artworkId.localeCompare(b.artworkId));
  const previewToken = createHash("sha256")
    .update(
      JSON.stringify({
        scope,
        rootPath: root.path,
        dataDir: catalog.dataDir,
        rows,
      }),
    )
    .digest("hex");
  return {
    preview: {
      scope,
      rootPath: root.path,
      fileCount: rows.length,
      boundFileCount,
      unboundFileCount: rows.length - boundFileCount,
      artworkCount: groups.size,
      eligibleArtworkCount: artworks.length,
      eligibleFileCount: artworks.reduce(
        (count, item) => count + item.fileCount,
        0,
      ),
      queuedArtworkCount,
      runningArtworkCount,
      completedArtworkCount,
      unavailableArtworkCount,
      previewToken,
    },
    artworks,
  };
}
