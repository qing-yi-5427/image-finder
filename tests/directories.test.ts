import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Catalog } from "../src/core/catalog.js";
import { directories } from "../src/core/directories.js";
import { validateInvocation } from "../src/bridge.js";
import { composeQuery } from "../src/ui-model.js";

async function fixture() {
  const run = await mkdtemp(path.join(tmpdir(), "finder-directories-"));
  const original = path.join(run, "原目录");
  await mkdir(original);
  const c = new Catalog(path.join(run, "catalog"));
  const root = c.addRoot(original);
  const other = c.addRoot(path.join(run, "other"));
  const add = c.db.prepare(
    "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,favorite) VALUES(?,?,?,?,?,?,?)",
  );
  for (const [id, relative] of [
    ["root", "root.png"],
    ["a", "12/a.png"],
    ["nested", "12/角色 空格/b.png"],
    ["backslash", "12\\深层\\c.png"],
    ["sibling", "123/a.png"],
    ["literal", "12/100%_中文/a.png"],
    ["wildcard", "12/100XX中文/a.png"],
  ])
    add.run(id, root.id, relative, 12, 1, 1, id === "a" ? 1 : 0);
  add.run("other", other.id, "12/a.png", 12, 1, 1, 0);
  return { c, root, original, run };
}

test("directory query scopes include recursive descendants, constrain root and treat wildcard names literally", async () => {
  const { c, root } = await fixture();
  try {
    assert.equal(
      c.query({ filter: { directory: { rootId: root.id, relativePath: "" } } })
        .total,
      7,
    );
    const scope = { directory: { rootId: root.id, relativePath: "12" } };
    assert.deepEqual(
      c
        .query({ filter: scope })
        .items.map((x) => x.id)
        .sort(),
      ["a", "backslash", "literal", "nested", "wildcard"],
    );
    assert.equal(
      c.query({
        filter: {
          directory: { rootId: root.id, relativePath: "12/100%_中文" },
        },
      }).items[0].id,
      "literal",
    );
    assert.equal(
      c.query(composeQuery({ favorite: true }, "", scope, "name", false))
        .items[0].id,
      "a",
    );
    const collectionId = c.createCollection("目录规则", "smart", scope);
    assert.equal(c.query({ filter: { collectionId } }).total, 5);
    c.db
      .prepare("UPDATE roots SET path=? WHERE id=?")
      .run("Z:\\已移动目录", root.id);
    assert.equal(c.query({ filter: { collectionId } }).total, 5);
    assert.equal(c.getFile("a").favorite, true);
  } finally {
    c.close();
  }
});

test("directory children are direct, paged, preserve offline index and include disk-only folders", async () => {
  const { c, root, original, run } = await fixture();
  try {
    await mkdir(path.join(original, "空文件夹"));
    const first = await directories(c, root.id, "", 0, 2);
    assert.equal(first.total, 3);
    assert.equal(first.items.length, 2);
    assert.deepEqual(
      (await directories(c, root.id, "", 2, 2)).items.map((x) => x.name),
      ["空文件夹"],
    );
    const row = first.items.find((x) => x.name === "12")!;
    assert.equal(row.imageCount, 5);
    assert.equal(row.hasChildren, true);
    const nested = await directories(c, root.id, "12");
    assert.equal(nested.total, 4);
    assert.equal(
      nested.items.find((x) => x.name === "100%_中文")?.imageCount,
      1,
    );
    assert.equal((await directories(c, root.id, "12/100%_中文")).total, 0);
    await rename(original, path.join(run, "离线原目录"));
    assert.deepEqual(
      (await directories(c, root.id)).items.map((x) => x.name),
      ["12", "123"],
    );
    assert.equal(c.getRoot(root.id).path, original);
    assert.equal(c.roots().length, 2);
  } finally {
    c.close();
  }
});

test("directory IPC rejects traversal, absolute paths, extra fields, and unbounded pagination", () => {
  for (const value of ["", "12", "12\\角色 空格", "12/100%_中文"])
    validateInvocation("library.directories", {
      rootId: "root",
      relativePath: value,
      offset: 0,
      limit: 100,
    });
  for (const value of [
    "..",
    "12/../123",
    "../foo",
    "/tmp",
    "C:\\Users",
    "\\\\server\\share",
    "12\0bad",
  ])
    for (const [method, payload] of [
      ["library.directories", { rootId: "root", relativePath: value }],
      [
        "files.query",
        { filter: { directory: { rootId: "root", relativePath: value } } },
      ],
    ])
      assert.throws(() => validateInvocation(method, payload));
  for (const payload of [
    { rootId: "root", limit: 501 },
    { rootId: "root", offset: -1 },
    { rootId: "root", path: "C:/" },
  ])
    assert.throws(() => validateInvocation("library.directories", payload));
});

test("directory reader refuses junction paths that escape the original root", async () => {
  const { c, root, original, run } = await fixture();
  try {
    const outside = path.join(run, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      path.join(original, "junction"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      (await directories(c, root.id)).items.some((x) => x.name === "junction"),
      false,
    );
    await assert.rejects(
      directories(c, root.id, "junction"),
      /INVALID_DIRECTORY_SCOPE/,
    );
  } finally {
    c.close();
  }
});
