import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Catalog } from "../src/core/catalog.js";
import { Scanner, identifyArtwork } from "../src/core/filesystem.js";

test("filename source binding requires exact standard format", () => {
  assert.equal(identifyArtwork("81470181_p0.jpg").artworkId, "81470181");
  assert.deepEqual(identifyArtwork("81470181_p2 (1).jpg"), {
    artworkId: "81470181",
    page: 2,
    candidateArtworkId: null,
  });
  assert.equal(identifyArtwork("title-81470181.jpg").artworkId, null);
  assert.equal(identifyArtwork("a81470181_p2.jpg").artworkId, null);
  assert.equal(identifyArtwork("81470181.jpg").artworkId, null);
  assert.equal(identifyArtwork("81470181.jpg").candidateArtworkId, "81470181");
  assert.equal(identifyArtwork("title_81470181_p0.jpg").artworkId, null);
  assert.deepEqual(identifyArtwork("12\\8\\123456_p0 (2).jpg"), {
    artworkId: "123456", page: 0, candidateArtworkId: null,
  });
  for (const name of ["123456_p0 (0).jpg", "123456_p0 (2) extra.jpg", "author-123456 (2).jpg", "123456-author-654321.jpg"])
    assert.equal(identifyArtwork(name).artworkId, null);
});
test("incremental scan preserves IDs and annotations, guards replacements, offline and partial scans", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-fs-"));
  const source = path.join(dir, "source");
  await mkdir(source);
  const catalog = new Catalog(path.join(dir, "data"));
  const scanner = new Scanner(catalog);
  try {
    const first = path.join(source, "81470181_p0.png");
    await writeFile(first, "sample");
    await writeFile(path.join(source, "123456.png"), "other");
    const root = catalog.addRoot(source);
    assert.equal((await scanner.scan(root.id)).added, 2);
    const original = catalog
      .query()
      .items.find((x) => x.artworkId === "81470181")!;
    catalog.setFavorite([original.id], true);
    assert.equal(
      await catalog.resolveOriginal(original.id),
      await import("node:fs/promises").then((fs) => fs.realpath(first)),
    );
    await rename(first, path.join(source, "81470181_p1.png"));
    await scanner.scan(root.id);
    assert.equal(catalog.getFile(original.id).relativePath, "81470181_p1.png");
    assert.equal(catalog.getFile(original.id).favorite, true);
    await writeFile(path.join(source, "81470181_p1.png"), "replacement longer");
    await assert.rejects(
      catalog.resolveOriginal(original.id),
      /no longer matches/,
    );
    assert.equal((await scanner.scan(root.id)).changed, 1);
    await rm(path.join(source, "123456.png"));
    const partial = await scanner.scan(root.id, { limit: 0 });
    assert.equal(partial.complete, false);
    assert.equal(catalog.query({ filter: { missing: true } }).total, 0);
    assert.equal((await scanner.scan(root.id)).missing, 1);
    await rename(source, source + "-offline");
    assert.equal((await scanner.scan(root.id)).complete, false);
    assert.equal(catalog.getRoot(root.id).status, "offline");
    assert.equal(catalog.query().total, 2);
    await scanner.relocateRoot(root.id, source + "-offline");
    assert.equal(catalog.getFile(original.id).favorite, true);
    assert.equal((await scanner.scan(root.id)).complete, true);
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("junction escape cannot resolve original or enter scan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-junction-"));
  const source = path.join(dir, "source"),
    outside = path.join(dir, "outside");
  await mkdir(source);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.png"), "x");
  const catalog = new Catalog(path.join(dir, "data"));
  try {
    const root = catalog.addRoot(source);
    await symlink(outside, path.join(source, "link"), "junction");
    await new Scanner(catalog).scan(root.id);
    assert.equal(catalog.query().total, 0);
    catalog.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        "escape",
        root.id,
        path.join("link", "secret.png"),
        1,
        0,
        Date.now(),
      );
    await assert.rejects(catalog.resolveOriginal("escape"), /escapes/);
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconnect accepts a canonical same root with stale missing files and preserves annotations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-reconnect-"));
  const source = path.join(dir, "source");
  await mkdir(source);
  const catalog = new Catalog(path.join(dir, "data"));
  const scanner = new Scanner(catalog);
  try {
    await writeFile(path.join(source, "100938675_p0.jpg"), "fixture");
    const root = catalog.addRoot(source);
    await scanner.scan(root.id);
    const file = catalog.query().items[0];
    catalog.setFavorite([file.id], true);
    await rm(path.join(source, file.relativePath));
    const child = path.join(source, "12");
    await mkdir(child);
    await assert.rejects(
      scanner.relocateRoot(root.id, child),
      /是它的子文件夹.*原目录根文件夹/,
    );
    assert.equal(catalog.getRoot(root.id).path, source);
    await assert.rejects(catalog.resolveOriginal(file.id), /这张原图已不存在/);
    const same = process.platform === "win32" ? source.toUpperCase() : source;
    await scanner.relocateRoot(root.id, path.join(same, "."));
    assert.equal(catalog.getFile(file.id).missing, false);
    assert.equal(catalog.getFile(file.id).favorite, true);
    assert.equal((await scanner.scan(root.id)).missing, 1);
    assert.equal(catalog.getRoot(root.id).status, "online");
    await rename(source, source + "-offline");
    await assert.rejects(catalog.resolveOriginal(file.id), /原目录已离线/);
    const scan = await scanner.scan(root.id);
    assert.equal(scan.complete, false);
    assert.equal(catalog.getRoot(root.id).status, "offline");
    assert.match(scan.errors[0], /原目录无法访问/);
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("relocation skips stale missing samples beyond twenty but rejects insufficient, mismatched and unsafe evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-relocation-"));
  const source = path.join(dir, "source"),
    moved = path.join(dir, "moved"),
    empty = path.join(dir, "empty"),
    outside = path.join(dir, "outside");
  for (const folder of [source, empty, outside]) await mkdir(folder);
  const catalog = new Catalog(path.join(dir, "data"));
  const scanner = new Scanner(catalog);
  try {
    for (let i = 0; i < 27; i++)
      await writeFile(
        path.join(source, `${String(i).padStart(3, "0")}.png`),
        `fixture ${i}`,
      );
    const root = catalog.addRoot(source);
    await scanner.scan(root.id);
    const file = catalog.query().items[0];
    catalog.setFavorite([file.id], true);
    for (let i = 0; i < 24; i++)
      await rm(path.join(source, `${String(i).padStart(3, "0")}.png`));
    await rename(source, moved);
    await assert.rejects(
      scanner.relocateRoot(root.id, empty),
      /找到 0 张匹配图片，至少需要 3 张/,
    );
    assert.equal(catalog.getRoot(root.id).path, source);
    await scanner.relocateRoot(root.id, moved);
    assert.equal(catalog.getFile(file.id).favorite, true);
    assert.equal(
      catalog.getFile(file.id).missing,
      false,
      "relocation never marks missing without a complete scan",
    );
    const second = path.join(dir, "second");
    await rename(moved, second);
    const last = path.join(second, "026.png");
    await rename(last, path.join(outside, "026.png"));
    await assert.rejects(
      scanner.relocateRoot(root.id, second),
      /找到 2 张匹配图片，至少需要 3 张/,
    );
    await rename(path.join(outside, "026.png"), last);
    await writeFile(last, "different longer replacement");
    await assert.rejects(scanner.relocateRoot(root.id, second), /不匹配/);
    assert.equal(catalog.getRoot(root.id).path, moved);
    await symlink(outside, path.join(second, "000-escape"), "junction");
    catalog.db
      .prepare("UPDATE files SET relative_path=? WHERE relative_path='000.png'")
      .run(path.join("000-escape", "secret.png"));
    await writeFile(path.join(outside, "secret.png"), "fixture");
    await assert.rejects(
      scanner.relocateRoot(root.id, second),
      /链接指向目录外/,
    );
    catalog.db
      .prepare("UPDATE files SET relative_path=? WHERE relative_path=?")
      .run("../outside/secret.png", path.join("000-escape", "secret.png"));
    await assert.rejects(
      scanner.relocateRoot(root.id, second),
      /路径超出原目录/,
    );
    assert.equal(catalog.getRoot(root.id).path, moved);
    await assert.rejects(
      scanner.relocateRoot(root.id, path.join(dir, "absent")),
      /所选目录当前不可用/,
    );
    await assert.rejects(
      scanner.relocateRoot(root.id, path.join(second, "024.png")),
      /不是文件夹/,
    );
    await assert.rejects(
      scanner.relocateRoot(root.id, path.join(dir, "data")),
      /SOURCE_DATA_OVERLAP/,
    );
    const blank = catalog.addRoot(empty);
    await assert.rejects(
      scanner.relocateRoot(blank.id, outside),
      /无法确认这是原目录/,
    );
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
