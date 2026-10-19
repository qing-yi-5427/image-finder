import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { FileActions } from "../src/electron/file-actions.js";
import { validateInvocation } from "../src/bridge.js";
import { ImageFinderService } from "../src/core/service.js";

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const actions = new FileActions({
    invoke: async (method, payload: any) => {
      calls.push([method, payload]);
      if (method === "images.resolve")
        return { path: `E:\\原目录\\${payload.fileId}.png` };
    },
    copyFiles: async (paths) => {
      calls.push(["copyFiles", paths]);
    },
    copyText: (text) => {
      calls.push(["copyText", text]);
    },
    openPath: async (p) => {
      calls.push(["openPath", p]);
      return "";
    },
    reveal: (p) => {
      calls.push(["reveal", p]);
    },
    trash: async (p) => {
      calls.push(["trash", p]);
    },
    confirmTrash: async (count, failed) => {
      calls.push(["confirm", { count, failed }]);
      return true;
    },
    ...overrides,
  });
  return { actions, calls };
}

test("file copy uses deduplicated explicit IDs, real paths and file-drop rather than text", async () => {
  const { actions, calls } = fixture();
  const result = await actions.run("files.copy", {
    fileIds: ["中文 空格", "b", "b"],
    format: "files",
  });
  assert.deepEqual(result, {
    successIds: ["中文 空格", "b"],
    failures: [],
    canceled: false,
  });
  assert.deepEqual(calls.at(-1), [
    "copyFiles",
    ["E:\\原目录\\中文 空格.png", "E:\\原目录\\b.png"],
  ]);
  assert.equal(
    calls.some((x) => x[0] === "copyText"),
    false,
  );
  await actions.run("files.copy", { fileIds: ["a", "b"], format: "paths" });
  assert.deepEqual(calls.at(-1), [
    "copyText",
    "E:\\原目录\\a.png\r\nE:\\原目录\\b.png",
  ]);
});

test("trash confirms only resolved actual files and cancellation never invokes trash", async () => {
  const { actions, calls } = fixture({
    invoke: async (_method: string, p: any) => {
      if (p.fileId === "missing") throw new Error("ENOENT");
      return { path: p.fileId };
    },
    confirmTrash: async (count: number, failed: number) => {
      calls.push(["confirm", { count, failed }]);
      return false;
    },
  });
  const result = await actions.run("files.trash", {
    fileIds: ["a", "a", "missing"],
  });
  assert.equal(result?.canceled, true);
  assert.equal(result?.failures.length, 1);
  assert.deepEqual(calls, [["confirm", { count: 1, failed: 1 }]]);
});

test("trash rechecks fingerprint after confirm, reports partial failures and only commits successful recycle", async () => {
  let confirmed = false;
  const { actions, calls } = fixture({
    invoke: async (method: string, p: any) => {
      calls.push([method, p]);
      if (method === "images.resolve") {
        if (confirmed && p.fileId === "replaced")
          throw new Error("Original no longer matches indexed file");
        return { path: p.fileId };
      }
    },
    confirmTrash: async () => {
      confirmed = true;
      return true;
    },
    trash: async (p: string) => {
      calls.push(["trash", p]);
      if (p === "locked") throw new Error("EPERM");
    },
  });
  const result = await actions.run("files.trash", {
    fileIds: ["good", "locked", "replaced"],
  });
  assert.deepEqual(result?.successIds, ["good"]);
  assert.equal(result?.failures.length, 2);
  assert.deepEqual(
    calls.filter((x) => x[0] === "files.trashCommitted"),
    [["files.trashCommitted", { fileIds: ["good"] }]],
  );
  assert.equal(
    calls.some((x) => x[0] === "trash" && x[1] === "replaced"),
    false,
  );
});

test("recycled files remain successful with explicit index-refresh error if durable commit fails", async () => {
  const { actions } = fixture({
    invoke: async (method: string) => {
      if (method === "files.trashCommitted") throw new Error("database locked");
      return { path: "good" };
    },
  });
  const result = await actions.run("files.trash", { fileIds: ["a"] });
  assert.deepEqual(result?.successIds, ["a"]);
  assert.match(result!.failures[0].message, /已移到回收站，索引待刷新/);
});

test("native open surfaces association failure and reveal resolves safe original", async () => {
  const { actions, calls } = fixture({
    openPath: async () => "No associated application",
  });
  await assert.rejects(actions.run("files.open", { fileId: "a" }), /默认程序/);
  await actions.run("files.reveal", { fileId: "b" });
  assert.deepEqual(calls.at(-1), ["reveal", "E:\\原目录\\b.png"]);
});

test("file host operations reject caller paths, empty lists and renderer index mutation", () => {
  for (const [method, payload] of [
    ["files.copy", { fileIds: ["a"], format: "files" }],
    ["files.open", { fileId: "a" }],
    ["files.trash", { fileIds: ["a"] }],
  ])
    validateInvocation(method, payload);
  for (const [method, payload] of [
    ["files.copy", { fileIds: [], format: "files" }],
    ["files.copy", { fileIds: ["a"], format: "move" }],
    ["files.open", { path: "E:/a.png" }],
    ["files.trash", { fileIds: ["a"], permanent: true }],
    ["files.trashCommitted", { fileIds: ["a"] }],
  ])
    assert.throws(() => validateInvocation(method, payload));
  validateInvocation(
    "files.trashCommitted",
    { fileIds: ["a"] },
    { privileged: true },
  );
});

test("successful recycle commits missing without removing favorites, rating or tags", async () => {
  const run = await mkdtemp(path.join(tmpdir(), "finder-file-actions-"));
  const original = path.join(run, "original");
  await mkdir(original);
  const originalFile = path.join(original, "one.png");
  await writeFile(originalFile, "original fingerprint");
  const info = await stat(originalFile);
  const service = new ImageFinderService(path.join(run, "catalog"));
  try {
    await service.invoke("local.pause", { kind: "scan" });
    const root = service.catalog.addRoot(original);
    service.catalog.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,favorite,rating) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run("a", root.id, "one.png", info.size, info.mtimeMs, 1, 1, 5);
    const tag = service.catalog.createTag("保留标签", "content");
    service.catalog.overrideTags(["a"], [tag], "add");
    await service.invoke("files.trashCommitted", { fileIds: ["a"] });
    const item = service.catalog.detail("a");
    assert.equal(item.missing, true);
    assert.equal(item.favorite, true);
    assert.equal(item.rating, 5);
    assert.equal(item.tags[0].effective, true);
    assert.equal(
      service.catalog.query({ filter: { missing: false } }).total,
      0,
    );
  } finally {
    await service.close();
  }
});
