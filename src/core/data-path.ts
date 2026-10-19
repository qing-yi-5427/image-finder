import { realpathSync } from "node:fs";
import path from "node:path";

/** Resolve existing ancestors too, so missing watch targets retain junction identity. */
export function canonicalPath(value: string): string {
  let current = path.resolve(value);
  const tail: string[] = [];
  while (true) {
    try { return path.join(realpathSync(current), ...tail); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function pathWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

/** Data may live beneath an original root, but is never an original directory. */
export function isDataPath(dataDir: string, target: string): boolean {
  return dataPathExclusion(dataDir)(target);
}

/** Cache the stable data directory once per traversal, never once per image. */
export function dataPathExclusion(dataDir: string): (target: string) => boolean {
  const lexical = path.resolve(dataDir);
  const actual = canonicalPath(dataDir);
  return target => pathWithin(lexical,path.resolve(target)) || pathWithin(actual,canonicalPath(target));
}
