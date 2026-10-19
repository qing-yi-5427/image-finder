import path from "node:path";
import { readFile } from "node:fs/promises";

export async function readAiHomePreferences(file: string) {
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved?.schema !== 1 || typeof saved.directory !== "string" ||
      !path.isAbsolute(saved.directory) || path.basename(saved.directory).toLowerCase() !== ".image-finder-ai")
      throw new Error("INVALID_AI_HOME_PREFERENCES");
    return { directory: path.resolve(saved.directory), configurationError: null };
  } catch (cause: any) {
    return {
      directory: undefined,
      configurationError: cause?.code === "ENOENT" ? null : "AI 环境位置配置无法读取或格式无效，当前保持默认位置；请在设置中重新选择。",
    };
  }
}
