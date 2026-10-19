import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Catalog } from "./catalog.js";
import type { DirectoryItem } from "../contracts.js";
import { directoryPath } from "../directory-path.js";
import { isDataPath } from "./data-path.js";

/** Aggregate in SQLite; only immediate children cross IPC, including offline folders. */
export async function directories(
  catalog: Catalog,
  rootId: string,
  relative = "",
  offset = 0,
  limit = 200,
) {
  const root = catalog.getRoot(rootId);
  const relativePath = directoryPath(relative);
  if (isDataPath(catalog.dataDir, path.join(root.path, ...relativePath.split("/"))))
    throw new Error("INVALID_DIRECTORY_SCOPE");
  const prefix = relativePath ? relativePath + "/" : "";
  // Each prefix range uses the existing (root_id,relative_path) unique index.
  // Deep expansion reads that subtree, rather than rescanning every file in its root.
  const windowsPrefix = prefix.replace(/\//g, "\\");
  const source = prefix
    ? `
    SELECT relative_path,missing FROM files WHERE root_id=? AND relative_path>=? AND relative_path<?
    UNION ALL
    SELECT relative_path,missing FROM files WHERE root_id=? AND relative_path>=? AND relative_path<?
  `
    : "SELECT relative_path,missing FROM files WHERE root_id=?";
  const sourceArgs = prefix
    ? [
        rootId,
        prefix,
        prefix.slice(0, -1) + "0",
        rootId,
        windowsPrefix,
        windowsPrefix.slice(0, -1) + "]",
      ]
    : [rootId];
  const indexed = catalog.db
    .prepare(
      `
    WITH descendants AS (
      SELECT substr(replace(relative_path, char(92), '/'), ?) AS tail, missing
      FROM (${source})
    ), children AS (
      SELECT substr(tail,1,instr(tail,'/')-1) AS name, missing,
        CASE WHEN instr(substr(tail,instr(tail,'/')+1),'/')>0 THEN 1 ELSE 0 END AS nested
      FROM descendants WHERE instr(tail,'/')>0
    ) SELECT name,sum(CASE WHEN missing=0 THEN 1 ELSE 0 END) AS imageCount,max(nested) AS hasChildren FROM children GROUP BY name
  `,
    )
    .all(prefix.length + 1, ...sourceArgs) as Array<{
    name: string;
    imageCount: number;
    hasChildren: number;
  }>;
  const rows = new Map(
    indexed.filter((row) => !isDataPath(catalog.dataDir, path.join(root.path, ...relativePath.split("/"), row.name))).map((row) => [
      row.name,
      { ...row, hasChildren: !!row.hasChildren },
    ]),
  );
  // Empty folders are browsable too. Resolve the real path before reading so a
  // junction within the source cannot expose an unrelated disk directory.
  try {
    const actualRoot = await realpath(root.path);
    const target = await realpath(
      path.join(root.path, ...relativePath.split("/")),
    );
    const within = path.relative(actualRoot, target);
    if (
      within === ".." ||
      within.startsWith(".." + path.sep) ||
      path.isAbsolute(within)
    )
      throw new Error("INVALID_DIRECTORY_SCOPE");
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !isDataPath(catalog.dataDir, path.join(target, entry.name)) &&
        !entry.isSymbolicLink() &&
        !rows.has(entry.name)
      )
        rows.set(entry.name, {
          name: entry.name,
          imageCount: 0,
          hasChildren: true,
        });
    }
  } catch (error) {
    if ((error as Error).message === "INVALID_DIRECTORY_SCOPE") throw error;
    // Offline/inaccessible originals retain their indexed tree.
  }
  const all: DirectoryItem[] = [...rows.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
    .map((row) => ({
      ...row,
      rootId,
      relativePath: prefix + row.name,
      path: path.join(root.path, ...prefix.split("/"), row.name),
    }));
  return {
    items: all.slice(offset, offset + limit),
    total: all.length,
    offset,
    limit,
  };
}
