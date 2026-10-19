import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { canonicalPath, pathWithin } from "./data-path.js";
import { hideManagedDataDirectory } from "./managed-data.js";
export const AI_HOME_MARKER = ".image-finder-managed.json";
export const AI_HOME_OWNERSHIP =
  '{"appId":"local.imagefinder.app","schema":1}\n';
const resources = [
  "python",
  "models",
  "licenses",
  "ai-worker.py",
  "ai-export.py",
  "ai-verify.py",
  "ai-translation.py",
  "ai-install.mjs",
  "ai-download.mjs",
  "ai-manifest.json",
  "wd-translations.json",
  "models-ready.json",
  "install-status.json",
  "python-embed.zip",
  "pip.whl",
];
const hash = async (file: string) => {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
};
async function exists(file: string) {
  try {
    return await lstat(file);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
/** Copies only AI-owned resources; never deletes the source environment. */
export async function migrateAiHome(
  source: string,
  directory: string,
  preferenceFile: string,
  protectedPaths: string[] = [],
) {
  if (
    !path.isAbsolute(directory) ||
    path.basename(directory).toLowerCase() !== ".image-finder-ai"
  )
    throw new Error("AI环境必须使用专用的 .image-finder-ai 子目录");
  const from = canonicalPath(source),
    to = canonicalPath(directory);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error("原AI环境不能是链接或普通文件");
  if (from !== to && (pathWithin(from, to) || pathWithin(to, from)))
    throw new Error("新旧AI环境目录不能互相包含");
  for (const [index, item] of protectedPaths.entries())
    if (
      pathWithin(to, canonicalPath(item)) ||
      (index === 0 && pathWithin(canonicalPath(item), to))
    )
      throw new Error("AI环境目录不能包含图库数据库或原图根目录");
  const parent = await lstat(path.dirname(directory));
  if (!parent.isDirectory()) throw new Error("目标父目录不可用");
  const existing = await exists(directory);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error("目标AI环境不能是链接或普通文件");
    const contents = await readdir(directory);
    if (contents.length) {
      const marker = await exists(path.join(directory, AI_HOME_MARKER));
      if (
        !marker?.isFile() ||
        marker.isSymbolicLink() ||
        (await readFile(path.join(directory, AI_HOME_MARKER), "utf8")) !==
          AI_HOME_OWNERSHIP
      )
        throw new Error("目标目录已有非本程序管理的内容，请选择其他位置");
    }
  } else await mkdir(directory);
  const created: Array<{ file: string; hash: string }> = [];
  const dirs: string[] = [];
  let copiedBytes = 0,
    reusedBytes = 0;
  const stable = async () => {
    for (const [dir, expected] of [
      [source, from],
      [directory, to],
    ]) {
      const entry = await lstat(dir);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        canonicalPath(dir) !== expected
      )
        throw new Error("迁移期间AI目录发生变化，已停止");
    }
  };
  try {
    await stable();
    const transfer = async (relative: string): Promise<void> => {
      await stable();
      const input = path.join(source, relative),
        output = path.join(directory, relative),
        entry = await lstat(input);
      if (entry.isSymbolicLink())
        throw new Error("AI环境包含链接，不能安全迁移");
      if (entry.isDirectory()) {
        const dest = await exists(output);
        if (dest && (!dest.isDirectory() || dest.isSymbolicLink()))
          throw new Error("目标AI资源类型冲突");
        if (!dest) {
          await mkdir(output);
          dirs.push(output);
        }
        for (const name of await readdir(input))
          await transfer(path.join(relative, name));
        return;
      }
      if (!entry.isFile()) throw new Error("AI环境包含不支持的资源类型");
      const digest = await hash(input),
        dest = await exists(output);
      if (dest) {
        if (
          !dest.isFile() ||
          dest.isSymbolicLink() ||
          (await hash(output)) !== digest
        )
          throw new Error(`目标AI环境存在不同版本文件：${relative}`);
        reusedBytes += entry.size;
      } else {
        await copyFile(input, output, 1);
        created.push({ file: output, hash: digest });
        if ((await hash(output)) !== digest)
          throw new Error("AI环境复制校验失败");
        copiedBytes += entry.size;
      }
    };
    if (from !== to)
      for (const name of resources)
        if (await exists(path.join(source, name))) await transfer(name);
    await stable();
    const marker = path.join(directory, AI_HOME_MARKER);
    if (!(await exists(marker))) {
      await writeFile(marker, AI_HOME_OWNERSHIP, { flag: "wx" });
      created.push({ file: marker, hash: await hash(marker) });
    }
    await mkdir(path.dirname(preferenceFile), { recursive: true });
    const temporary = preferenceFile + `.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ schema: 1, directory: to }, null, 2),
      );
      await rename(temporary, preferenceFile);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return {
      directory: to,
      previousDirectory: source,
      sourceRetained: true,
      copiedBytes,
      reusedBytes,
      warning: hideManagedDataDirectory(to),
    };
  } catch (error) {
    for (const item of created.reverse())
      try {
        await stable();
        const entry = await lstat(item.file);
        if (
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          (await hash(item.file)) === item.hash
        )
          await rm(item.file);
      } catch {}
    for (const dir of dirs.reverse())
      try {
        if (!(await readdir(dir)).length) await rmdir(dir);
      } catch {}
    throw error;
  }
}
