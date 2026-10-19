import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInvocation } from "../src/bridge.js";
test("IPC whitelist rejects filesystem escapes, unknown routes and malformed data", () => {
  for (const [method, payload] of [
    ["system.exec", {}],
    ["files.query", { path: "C:\\" }],
    ["library.add", { directory: "C:\\" }],
    ["images.resolve", { fileId: "x" }],
    ["files.rate", { fileIds: ["x"], rating: 99 }],
    ["files.query", { filter: { sql: "DROP TABLE files" } }],
    ["jobs.enqueue", { artworkIds: ["abc"] }],
    ["files.favorite", { fileIds: "x", favorite: true }],
  ] as const)
    assert.throws(() => validateInvocation(method, payload));
  validateInvocation("files.query", {
    filter: { widthMin: 100, tags: [{ ids: ["x"], mode: "all" }] },
    limit: 50,
  });
  validateInvocation(
    "library.add",
    { directory: "C:\\" },
    { privileged: true },
  );
});
test("required fields and nested filter schemas reject before dispatch", () => {
  for (const payload of [
    { filter: { tags: [{ ids: "wrong" }] } },
    { filter: { color: { hex: "blue" } } },
    { filter: { tone: { warmth: "hot" } } },
    { offset: 1.5 },
    { filter: { widthMin: "100" } },
    { filter: { favorite: 1 } },
    { filter: { tags: [{ ids: ["tag"], mode: "bogus" }] } },
  ])
    assert.throws(() => validateInvocation("files.query", payload));
  for (const [method, payload] of [
    ["files.rate", { rating: 2 }],
    ["tags.override", { fileIds: ["x"], tagId: "t", mode: "bad" }],
    ["collections.create", { name: "x", kind: "bogus" }],
    ["images.resolve", { fileId: "x", variant: "path" }],
  ])
    assert.throws(() =>
      validateInvocation(method, payload, { privileged: true }),
    );
  validateInvocation("tags.override", {
    fileIds: ["x"],
    tagId: "t",
    mode: "inherit",
  });
});
