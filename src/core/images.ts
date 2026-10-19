import { createHash } from "node:crypto";
import { mkdir, stat, rename, rm, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Catalog } from "./catalog.js";
import type { ImageFeature } from "../contracts.js";

export const ALGORITHM_VERSION = "srgb-lab-1";
export function hexToLab(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("Invalid color");
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const f = (n: number) =>
    n > 216 / 24389 ? Math.cbrt(n) : (n * 24389) / 27 / 116 + 16 / 116;
  const x = f((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047),
    y = f(r * 0.2126729 + g * 0.7151522 + b * 0.072175),
    z = f((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function deltaE(a: string, b: string): number {
  const x = hexToLab(a),
    y = hexToLab(b);
  return Math.hypot(...x.map((v, i) => v - y[i]));
}
export function paletteSimilarity(
  palette: Array<{ hex: string; weight: number }>,
  hex: string,
): number {
  return palette.reduce(
    (sum, color) => sum + color.weight * Math.exp(-deltaE(color.hex, hex) / 20),
    0,
  );
}

/** Deterministic weighted RGB clustering of visible sRGB pixels. */
export function analyzePixels(
  data: Uint8Array,
  channels: number,
): Pick<ImageFeature, "palette" | "brightness" | "saturation" | "warmth"> {
  const bins = new Map<
    number,
    { r: number; g: number; b: number; weight: number }
  >();
  let weight = 0,
    brightness = 0,
    saturation = 0,
    warmth = 0;
  for (let i = 0; i < data.length; i += channels) {
    const alpha = channels === 4 ? data[i + 3] / 255 : 1;
    if (alpha < 0.1) continue;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { r: 0, g: 0, b: 0, weight: 0 };
    bin.r += r * alpha;
    bin.g += g * alpha;
    bin.b += b * alpha;
    bin.weight += alpha;
    bins.set(key, bin);
    weight += alpha;
    brightness += ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * alpha;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      sat = max === 0 ? 0 : (max - min) / max;
    saturation += sat * alpha;
    warmth += ((r - b) / 255) * sat * alpha;
  }
  if (!weight)
    return { palette: [], brightness: 0, saturation: 0, warmth: "neutral" };
  const points = [...bins.values()]
    .map((p) => ({
      ...p,
      r: p.r / p.weight,
      g: p.g / p.weight,
      b: p.b / p.weight,
    }))
    .sort((a, b) => b.weight - a.weight);
  const centers = [points[0]].map((p) => [p.r, p.g, p.b]);
  while (centers.length < Math.min(5, points.length)) {
    let best = points[0],
      score = -1;
    for (const p of points) {
      const d =
        Math.min(
          ...centers.map(
            (c) => (p.r - c[0]) ** 2 + (p.g - c[1]) ** 2 + (p.b - c[2]) ** 2,
          ),
        ) * Math.sqrt(p.weight);
      if (d > score) {
        score = d;
        best = p;
      }
    }
    centers.push([best.r, best.g, best.b]);
  }
  let masses: number[] = [];
  for (let iteration = 0; iteration < 8; iteration++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of points) {
      let best = 0,
        d = Infinity;
      centers.forEach((c, j) => {
        const v = (p.r - c[0]) ** 2 + (p.g - c[1]) ** 2 + (p.b - c[2]) ** 2;
        if (v < d) {
          d = v;
          best = j;
        }
      });
      const sum = sums[best];
      sum[0] += p.r * p.weight;
      sum[1] += p.g * p.weight;
      sum[2] += p.b * p.weight;
      sum[3] += p.weight;
    }
    masses = sums.map((s) => s[3]);
    sums.forEach((s, j) => {
      if (s[3]) centers[j] = s.slice(0, 3).map((v) => v / s[3]);
    });
  }
  const palette = centers
    .map((c, i) => ({
      hex:
        "#" +
        c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""),
      weight: masses[i] / weight,
    }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const sat = saturation / weight,
    tone = warmth / weight;
  return {
    palette,
    brightness: brightness / weight,
    saturation: sat,
    warmth:
      sat < 0.12 || Math.abs(tone) < 0.06
        ? "neutral"
        : tone > 0
          ? "warm"
          : "cool",
  };
}

export class ImageProcessor {
  private cacheSizeBytes: number | null = null;
  invalidateCacheSize() {
    this.cacheSizeBytes = null;
  }
  private active = new Set<string>();
  constructor(
    private catalog: Catalog,
    private dataDir: string,
  ) {}
  async process(fileId: string, signal?:AbortSignal): Promise<ImageFeature> {
    if (this.active.has(fileId)) throw new Error("Image is already processing");
    this.active.add(fileId);
    try {
      return await this.processImage(fileId,signal);
    } finally {
      this.active.delete(fileId);
    }
  }
  private async processImage(fileId: string,signal?:AbortSignal): Promise<ImageFeature> {
    const file = this.catalog.getFile(fileId);
    const original = await this.catalog.resolveOriginal(fileId);
    const before = await stat(original);
    // Recently written and index-stale files must be rescanned or retried after settling.
    if (
      before.size !== file.bytes ||
      before.mtimeMs !== file.mtimeMs ||
      Date.now() - before.mtimeMs < 250
    )
      throw new Error("Original is not stable yet");
    const key =
      createHash("sha256")
        .update(`${file.id}:${file.bytes}:${file.mtimeMs}:${ALGORITHM_VERSION}`)
        .digest("hex") + ".webp";
    const cache = this.catalog.cacheDirectory;
    await mkdir(cache, { recursive: true });
    const temp = path.join(cache, `${key}.${process.pid}.tmp`);
    try {
      const image = sharp(original, {
        limitInputPixels: 268402689,
        sequentialRead: true,
      })
        .rotate()
        .toColourspace("srgb");
      const metadata = await image.metadata();
      const { data, info } = await image
        .clone()
        .resize(128, 128, { fit: "inside", withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const analysis = analyzePixels(data, info.channels);
      await image
        .clone()
        .resize(480, 480, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(temp);
      const after = await stat(original);
      const current = this.catalog.getFile(fileId);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino ||
        current.bytes !== file.bytes ||
        current.mtimeMs !== file.mtimeMs
      )
        throw new Error("Original changed while processing");
      const swap =
        metadata.orientation !== undefined && metadata.orientation >= 5;
      const feature: ImageFeature = {
        width: (swap ? metadata.height : metadata.width)!,
        height: (swap ? metadata.width : metadata.height)!,
        format: metadata.format ?? path.extname(original).slice(1),
        thumbnailKey: key,
        ...analysis,
        algorithmVersion: ALGORITHM_VERSION,
      };
      if (!feature.width || !feature.height)
        throw new Error("Image dimensions unavailable");
      if(signal?.aborted)throw new Error('LOCAL_TASK_CANCELLED');
      let replacedBytes = 0;
      try {
        replacedBytes = (await stat(path.join(cache, key))).size;
      } catch {}
      await rename(temp, path.join(cache, key));
      if (this.cacheSizeBytes !== null)
        this.cacheSizeBytes +=
          (await stat(path.join(cache, key))).size - replacedBytes;
      if(signal?.aborted)throw new Error('LOCAL_TASK_CANCELLED');
      this.catalog.db.transaction(() => {
        this.catalog.db
          .prepare(
            "UPDATE files SET cache_evicted=0,width=?,height=?,format=?,thumbnail_key=?,feature_version=?,processing_error=NULL WHERE id=?",
          )
          .run(
            feature.width,
            feature.height,
            feature.format,
            key,
            ALGORITHM_VERSION,
            fileId,
          );
        this.catalog.db
          .prepare(
            `INSERT INTO features(file_id,palette_json,brightness,saturation,warmth,algorithm_version) VALUES(?,?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET palette_json=excluded.palette_json,brightness=excluded.brightness,saturation=excluded.saturation,warmth=excluded.warmth,algorithm_version=excluded.algorithm_version`,
          )
          .run(
            fileId,
            JSON.stringify(feature.palette),
            feature.brightness,
            feature.saturation,
            feature.warmth,
            ALGORITHM_VERSION,
          );
      })();
      return feature;
    } finally {
      await rm(temp, { force: true });
    }
  }
  async processPending(
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ processed: number; failed: number }> {
    const pending = this.catalog.db
      .prepare(
        `SELECT f.id FROM files_visible f JOIN roots r ON r.id=f.root_id WHERE f.missing=0 AND f.processing_error IS NULL AND NOT EXISTS(SELECT 1 FROM local_cancelled_images x WHERE x.file_id=f.id AND x.bytes=f.bytes AND x.mtime_ms=f.mtime_ms) AND f.mtime_ms<=? AND r.status<>'offline' AND ((f.thumbnail_key IS NULL AND f.cache_evicted=0) OR f.feature_version IS NULL OR f.feature_version<>?) LIMIT ?`,
      )
      .all(
        Date.now() - 250,
        ALGORITHM_VERSION,
        Math.max(0, options.limit ?? 100),
      ) as Array<{ id: string }>;
    let processed = 0,
      failed = 0;
    for (const file of pending) {
      if (options.signal?.aborted) break;
      try {
        await this.process(file.id,options.signal);
        processed++;
      } catch (error) {
        if(options.signal?.aborted)break;
        failed++;
        this.catalog.db
          .prepare("UPDATE files SET processing_error=? WHERE id=?")
          .run(String(error), file.id);
      }
    }
    return { processed, failed };
  }
  retryFailed(fileIds?: string[]): number {
    if (fileIds)
      return this.catalog.db.transaction(() =>
        fileIds.reduce(
          (count, id) =>
            count +
            this.catalog.db
              .prepare(
                "UPDATE files SET processing_error=NULL,cache_evicted=0 WHERE id=? AND (processing_error IS NOT NULL OR cache_evicted=1)",
              )
              .run(id).changes,
          0,
        ),
      )();
    return this.catalog.db
      .prepare(
        "UPDATE files SET processing_error=NULL,cache_evicted=0 WHERE processing_error IS NOT NULL OR cache_evicted=1",
      )
      .run().changes;
  }
  async trimCache(
    maxBytes: number,
  ): Promise<{ removed: number; bytes: number; remainingBytes: number }> {
    if (!Number.isFinite(maxBytes) || maxBytes < 0)
      throw new Error("Invalid cache capacity");
    if (this.cacheSizeBytes !== null && this.cacheSizeBytes <= maxBytes)
      return { removed: 0, bytes: 0, remainingBytes: this.cacheSizeBytes };
    const directory = this.catalog.cacheDirectory;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { removed: 0, bytes: 0, remainingBytes: 0 };
      throw error;
    }
    const entries: Array<{ key: string; bytes: number; mtime: number }> = [];
    for (const key of names) {
      if (!/^[a-f0-9]{64}\.webp$/.test(key)) continue;
      const info = await stat(path.join(directory, key));
      if (info.isFile())
        entries.push({ key, bytes: info.size, mtime: info.mtimeMs });
    }
    let remainingBytes = entries.reduce((sum, e) => sum + e.bytes, 0),
      removed = 0,
      bytes = 0;
    for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) {
      if (remainingBytes <= maxBytes) break;
      const files = this.catalog.db
        .prepare("SELECT id FROM files_visible WHERE thumbnail_key=?")
        .all(entry.key) as Array<{ id: string }>;
      if (files.some((file) => this.active.has(file.id))) continue;
      await rm(path.join(directory, entry.key), { force: true });
      this.catalog.db
        .prepare(
          "UPDATE files SET thumbnail_key=NULL,cache_evicted=1 WHERE thumbnail_key=?",
        )
        .run(entry.key);
      removed++;
      bytes += entry.bytes;
      remainingBytes -= entry.bytes;
    }
    this.cacheSizeBytes = remainingBytes;
    return { removed, bytes, remainingBytes };
  }
}
