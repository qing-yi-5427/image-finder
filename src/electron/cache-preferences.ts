import path from "node:path";
import { readFile } from "node:fs/promises";

/** Profile-owned configuration; only the host chooses this file and its default. */
export async function readCachePreferences(file: string, defaultDirectory: string) {
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved?.schema !== 1 || typeof saved.directory !== "string" ||
      !path.isAbsolute(saved.directory) || path.basename(saved.directory) !== ".image-finder-cache")
      throw new Error("INVALID_CACHE_PREFERENCES");
    return { directory: path.resolve(saved.directory), configurationError: undefined };
  } catch (cause: any) {
    if (cause?.code === "ENOENT") return { directory: defaultDirectory, configurationError: undefined };
    return {
      directory: defaultDirectory,
      configurationError: "缓存位置配置无法读取或格式无效，已尝试使用默认位置；请在设置中重新选择缓存位置。",
    };
  }
}
