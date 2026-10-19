import path from "node:path";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";

const ownership = '{"appId":"local.imagefinder.app","schema":1}\n';
const marker = ".image-finder-managed.json";
const removable = ["python", "models", "python-embed.zip", "python-embed.zip.part", "pip.whl", "pip.whl.part", "models-ready.json", "install-status.json"];
const same = (a: string, b: string) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
const overlaps = (a: string, b: string) => {
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  return inside(a, b) || inside(b, a);
};
async function info(file: string) {
  try { return await lstat(file); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}
async function size(file: string): Promise<number> {
  const entry = await info(file);
  if (!entry) return 0;
  if (entry.isSymbolicLink()) throw new Error("环境中含链接，不能安全清理");
  if (!entry.isDirectory()) return entry.size;
  const sizes = await Promise.all((await readdir(file)).map((name) => size(path.join(file, name))));
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}

/** Only the dedicated application profile directory can be marked as managed. */
export async function markManagedAiHome(home: string, expected: string) {
  if (!same(home, expected)) throw new Error("非应用管理的 AI 目录");
  await mkdir(home, { recursive: true });
  if ((await lstat(home)).isSymbolicLink()) throw new Error("AI 目录不能是链接");
  try { await writeFile(path.join(home, marker), ownership, { flag: "wx" }); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
}

export class AiEnvironment {
  constructor(readonly home: string, private expected: string, private catalog: string) {}
  async inspect(protectedPaths: string[] = []) {
    let managed = false;
    let bytes = 0;
    let error: string | null = null;
    try {
      for (const name of removable) bytes += await size(path.join(this.home, name));
      if (!same(this.home, this.expected))
        return { home: this.home, managed: false, cleanupSupported: false, bytes, error: null };
      const entry = await info(this.home);
      if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error("AI 目录不可用或包含链接");
      const expectedLocation = path.join(await realpath(path.dirname(this.expected)), path.basename(this.expected));
      if (!same(await realpath(this.home), expectedLocation)) throw new Error("AI 目录归属不匹配");
      if ((await lstat(path.join(this.home, marker))).isSymbolicLink() || await readFile(path.join(this.home, marker), "utf8") !== ownership)
        throw new Error("AI 目录缺少有效的应用管理标记");
      const actualHome = await realpath(this.home);
      for (const protectedPath of [this.catalog, ...protectedPaths]) {
        const actualProtected = await realpath(protectedPath).catch(() => path.resolve(protectedPath));
        if (overlaps(actualHome, actualProtected)) throw new Error("AI 目录与图库或原图目录重叠，不能清理");
      }
      managed = true;
    } catch (cause) { error = cause instanceof Error ? cause.message : "无法检查 AI 环境"; }
    return { home: this.home, managed, cleanupSupported: managed && !error, bytes, error };
  }
  async clear(protectedPaths: string[] = []) {
    const status = await this.inspect(protectedPaths);
    if (!status.cleanupSupported) throw new Error(status.error ?? "随程序自带或外部配置的 AI 环境不能在此清理");
    const actualHome = await realpath(this.home);
    for (const name of removable) {
      if ((await lstat(this.home)).isSymbolicLink() || !same(await realpath(this.home), actualHome))
        throw new Error("AI 目录在清理期间发生变化，已停止");
      const target = path.join(this.home, name);
      const entry = await info(target);
      if (!entry) continue;
      if (entry.isSymbolicLink()) throw new Error("环境中含链接，不能安全清理");
      const relative = path.relative(actualHome, await realpath(target));
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error("清理目标超出 AI 环境，已停止");
      await rm(target, { recursive: true, force: true });
    }
    return { clearedBytes: status.bytes };
  }
}
