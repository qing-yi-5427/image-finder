/** Format conversion only: preserves the approved PNG and its original alpha. */
import assert from "node:assert/strict";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createHash } from "node:crypto";
const output = resolve("resources/branding"),
  evidence = resolve("artifacts/branding");
await mkdir(output, { recursive: true });
await mkdir(evidence, { recursive: true });
const png = join(output, "image-finder.png");
if (process.argv[2]) await copyFile(resolve(process.argv[2]), png);
const source = await readFile(png),
  metadata = await sharp(source).metadata();
assert.ok(metadata.hasAlpha, "approved icon alpha must be preserved");
const sizes = [16, 24, 32, 48, 64, 128, 256],
  frames = [];
for (const size of sizes)
  frames.push(
    await sharp(source)
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer(),
  );
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frames[index].length;
}
const ico = Buffer.concat([header, ...frames]);
await writeFile(join(output, "image-finder.ico"), ico);
const composites = [];
for (const [index, size] of [32, 48, 256].entries()) {
  composites.push({
    input: frames[sizes.indexOf(size)],
    left: index * 300 + Math.floor((300 - size) / 2),
    top: 40 + Math.floor((280 - size) / 2),
  });
  composites.push({
    input: Buffer.from(
      `<svg width="300" height="28"><text x="150" y="20" fill="#d8d9e2" font-family="sans-serif" font-size="14" text-anchor="middle">${size} × ${size} · native pixels</text></svg>`,
    ),
    left: index * 300,
    top: 6,
  });
}
await sharp({
  create: { width: 900, height: 340, channels: 4, background: "#222429" },
})
  .composite(composites)
  .png()
  .toFile(join(evidence, "icon-32-48-256.png"));
const alpha = await sharp(source).ensureAlpha().extractChannel("alpha").stats();
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
const report = {
  source: png,
  pngSha256: digest(source),
  icoSha256: digest(ico),
  width: metadata.width,
  height: metadata.height,
  alpha: { min: alpha.channels[0].min, max: alpha.channels[0].max },
  sizes,
  contactSheet: join(evidence, "icon-32-48-256.png"),
};
await writeFile(
  join(evidence, "branding.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
