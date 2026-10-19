import test from "node:test";
import assert from "node:assert/strict";
import { validateInvocation, boundSourceUrl } from "../src/bridge.js";
test("UI routes accept only constrained identifiers, paging and window actions", () => {
  for (const [method, payload] of [
    ["authors.list", { offset: 0, limit: 500 }],
    ["collections.delete", { collectionId: "x" }],
    ["files.reveal", { fileId: "x" }],
    ["files.openSource", { fileId: "x" }],
    ["window.control", { action: "maximize" }],
    ["files.query", { filter: { color: { hex: "#ffffff", restrict: false } } }],
  ] as const)
    validateInvocation(method, payload);
  for (const [method, payload] of [
    ["authors.list", { limit: 501 }],
    ["authors.list", { offset: -1 }],
    ["collections.delete", {}],
    ["files.reveal", { path: "E:/images" }],
    ["files.openSource", { fileId: "x", url: "https://evil.test" }],
    ["window.control", { action: "destroy" }],
    [
      "files.query",
      { filter: { color: { hex: "#ffffff", restrict: "false" } } },
    ],
  ] as const)
    assert.throws(() => validateInvocation(method, payload));
});
test("source URL accepts bound Pixiv IDs only and never candidate or caller URLs", () => {
  assert.equal(
    boundSourceUrl("81470181"),
    "https://www.pixiv.net/artworks/81470181",
  );
  for (const value of [
    null,
    undefined,
    "",
    "https://evil.test",
    "123/../../evil",
    "012345",
    "1234",
    "1".repeat(13),
    81470181,
  ])
    assert.throws(() => boundSourceUrl(value));
});
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImageFinderService } from "../src/core/service.js";
test("service dispatches UI metadata routes and keeps native host operations out of worker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "finder-ui-routes-"));
  const service = new ImageFinderService(dir);
  try {
    assert.deepEqual(await service.invoke("authors.list", {}), []);
    const collectionId = await service.invoke("collections.create", {
      name: "test",
      kind: "normal",
    });
    await service.invoke("collections.delete", { collectionId });
    assert.deepEqual(await service.invoke("collections.list"), []);
    const tag = await service.invoke("tags.create", {
      name: "test",
      category: "content",
    });
    const { undoId } = await service.invoke("tags.classify", {
      tagIds: [tag],
      category: "style",
    });
    await service.invoke("tags.undo", { undoId });
    assert.equal(
      (await service.invoke("tags.list", {}))[0].category,
      "content",
    );
    for (const [method, payload] of [
      ["files.reveal", { fileId: "x" }],
      ["files.openSource", { fileId: "x" }],
      ["window.control", { action: "close" }],
    ] as const)
      await assert.rejects(
        service.invoke(method, payload),
        /HOST_OPERATION_REQUIRED/,
      );
  } finally {
    await service.close();
  }
});

test("organization whitelist requires a change and validates every tag before execution", () => {
  validateInvocation("organization.apply", {
    fileIds: ["a"],
    favorite: false,
    rating: 0,
    tags: [
      { name: "new", mode: "add" },
      { tagId: "existing", mode: "inherit" },
    ],
  });
  for (const payload of [
    { fileIds: ["a"] },
    { fileIds: [], favorite: true },
    { fileIds: ["a"], rating: 6 },
    { fileIds: ["a"], tags: [] },
    { fileIds: ["a"], tags: [{ name: "x", tagId: "y", mode: "add" }] },
    { fileIds: ["a"], tags: [{ mode: "add" }] },
    { fileIds: ["a"], tags: [{ name: "x", mode: "delete" }] },
    {
      fileIds: ["a"],
      tags: Array.from({ length: 31 }, () => ({ name: "x", mode: "add" })),
    },
  ])
    assert.throws(() => validateInvocation("organization.apply", payload));
});

test("organization collection membership schema is constrained", () => {
  validateInvocation("organization.apply", {
    fileIds: ["a"],
    collection: { collectionId: "x", mode: "add" },
  });
  for (const collection of [
    { collectionId: "x", mode: "delete" },
    { collectionId: "x" },
    { mode: "add" },
    { collectionId: "x", mode: "add", sql: "x" },
  ])
    assert.throws(() =>
      validateInvocation("organization.apply", { fileIds: ["a"], collection }),
    );
});
