import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  utimes,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { Catalog } from "../src/core/catalog.js";
import { Scanner } from "../src/core/filesystem.js";
import {
  ImageProcessor,
  analyzePixels,
  deltaE,
  paletteSimilarity,
} from "../src/core/images.js";

test("visible palette ignores transparent pixels and preserves white and weight", () => {
  const result = analyzePixels(
    Uint8Array.from([0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255]),
    4,
  );
  assert.equal(result.palette.length, 2);
  assert.ok(
    result.palette.some((x) => x.hex === "#ffffff" && x.weight === 0.5),
  );
  assert.equal(deltaE("#ff0000", "#ff0000"), 0);
  assert.ok(deltaE("#ff0000", "#0000ff") > 50);
  assert.ok(
    paletteSimilarity([{ hex: "#0000ff", weight: 1 }], "#0000ff") >
      paletteSimilarity([{ hex: "#ff0000", weight: 1 }], "#0000ff"),
  );
  assert.equal(
    analyzePixels(Uint8Array.from([120, 120, 120, 255]), 4).warmth,
    "neutral",
  );
});
test("processing creates read-only oriented thumbnails and isolates failures from pending queue", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-image-"));
  const source = path.join(dir, "source");
  await mkdir(source);
  const catalog = new Catalog(path.join(dir, "data"));
  try {
    const original = path.join(source, "81470181_p0.jpg");
    await sharp({
      create: { width: 20, height: 10, channels: 3, background: "#ff0000" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(original);
    const age = new Date(Date.now() - 2000);
    await utimes(original, age, age);
    await writeFile(path.join(source, "bad.png"), "invalid image");
    await utimes(path.join(source, "bad.png"), age, age);
    const bytes = await readFile(original);
    const root = catalog.addRoot(source);
    await new Scanner(catalog).scan(root.id);
    const processor = new ImageProcessor(catalog, path.join(dir, "data"));
    const first = await processor.processPending({ limit: 1 });
    const next = await processor.processPending({ limit: 1 });
    assert.equal(first.processed + next.processed, 1);
    assert.equal(first.failed + next.failed, 1);
    assert.deepEqual(await processor.processPending(), {
      processed: 0,
      failed: 0,
    });
    const file = catalog.query().items.find((x) => x.artworkId === "81470181")!;
    assert.equal(file.width, 10);
    assert.equal(file.height, 20);
    assert.ok(file.palette![0].weight > 0.99);
    assert.deepEqual(await readFile(original), bytes);
    const thumb = await sharp(
      path.join(dir, "data", "thumbnails", file.thumbnailKey!),
    ).metadata();
    assert.equal(thumb.width, 10);
    assert.equal(thumb.height, 20);
    assert.equal(processor.retryFailed(), 1);
  } finally {
    catalog.close();
    sharp.cache(false);
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
test("changed image invalidates derived data and an active write is deferred", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-change-"));
  const source = path.join(dir, "source");
  await mkdir(source);
  const catalog = new Catalog(path.join(dir, "data"));
  try {
    const original = path.join(source, "81470181_p0.png");
    await sharp({
      create: { width: 8, height: 4, channels: 3, background: "#00ff00" },
    })
      .png()
      .toFile(original);
    const age = new Date(Date.now() - 2000);
    await utimes(original, age, age);
    const root = catalog.addRoot(source),
      scanner = new Scanner(catalog),
      processor = new ImageProcessor(catalog, path.join(dir, "data"));
    await scanner.scan(root.id);
    const id = catalog.query().items[0].id;
    await processor.process(id);
    assert.ok(catalog.getFile(id).thumbnailKey);
    sharp.cache(false);
    await sharp({
      create: { width: 12, height: 6, channels: 3, background: "#0000ff" },
    })
      .png()
      .toFile(original);
    await scanner.scan(root.id);
    assert.equal(catalog.getFile(id).thumbnailKey, null);
    assert.equal(catalog.getFile(id).width, null);
    assert.equal(
      catalog.db.prepare("SELECT COUNT(*) n FROM features").get() &&
        (
          catalog.db.prepare("SELECT COUNT(*) n FROM features").get() as {
            n: number;
          }
        ).n,
      0,
    );
    await assert.rejects(processor.process(id), /not stable/);
    await utimes(original, age, age);
    await scanner.scan(root.id);
    await processor.process(id);
    assert.equal(catalog.getFile(id).width, 12);
  } finally {
    catalog.close();
    sharp.cache(false);
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
