import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Catalog } from "../src/core/catalog.js";
import { LocalAi, AI_MODELS, validVector } from "../src/core/ai.js";
const vector = (score = 1) => {
  const value = Array(512).fill(0);
  value[0] = score;
  value[1] = Math.sqrt(1 - score * score);
  return value;
};
async function fixture(runtime?: any) {
  const base = await mkdtemp(path.join(tmpdir(), "finder-ai-"));
  const source = path.join(base, "source");
  const home = path.join(base, "runtime");
  await mkdir(source);
  await mkdir(path.join(home, "python"), { recursive: true });
  await writeFile(path.join(home, "python", "python.exe"), "fake");
  await writeFile(
    path.join(home, "wd-translations.json"),
    JSON.stringify({ tags: { blue_hair: "蓝色头发", old_tag: "旧标签" } }),
  );
  const marker: any = {
    format: 1,
    preprocess: "clip-rgba-white-bicubic-square224-meanstd-v2",
    files: {},
  };
  for (const kind of ["wd", "semantic"] as const) {
    await mkdir(path.join(home, "models", kind), { recursive: true });
    marker.files[kind] = {};
    for (const name of AI_MODELS[kind].files) {
      await writeFile(path.join(home, "models", kind, name), "fake");
      marker.files[kind][name] = {
        bytes: 4,
        sha256: createHash("sha256").update("fake").digest("hex"),
      };
    }
  }
  await writeFile(path.join(home, "models-ready.json"), JSON.stringify(marker));
  const catalog = new Catalog(path.join(base, "data"));
  const root = catalog.addRoot(source);
  const ids = ["a", "b", "c", "d"];
  for (let i = 0; i < ids.length; i++) {
    const file = path.join(source, ids[i] + ".png");
    await writeFile(file, "fixture");
    const info = await stat(file);
    catalog.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,width,height,format,artwork_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ids[i],
        root.id,
        ids[i] + ".png",
        info.size,
        info.mtimeMs,
        i + 1,
        100,
        i === 3 ? 3000 : 200,
        "png",
        i < 2 ? "100000" : null,
      );
  }
  const fake = runtime ?? {
    run: async (kind: string, payload: any) => ({
      elapsedMs: 1,
      providers: ["fixture"],
      ...(kind === "wd"
        ? {
            candidates: [
              { tag: "blue_hair", category: "content", score: 0.9 },
              { tag: "old_tag", category: "content", score: 0.7 },
            ],
          }
        : {
            vector: vector(
              payload.text
                ? 1
                : path.basename(payload.path).startsWith("d")
                  ? 0.1
                  : 0.9,
            ),
          }),
    }),
    close() {},
  };
  const ai = new LocalAi(catalog, { home, runtime: fake });
  return { base, source, home, catalog, root, ai, fake, ids };
}
async function done(ai: LocalAi, kind: "wd" | "semantic") {
  for (let i = 0; i < 200; i++) {
    const queue = ai.status().queues.find((queue) => queue.kind === kind)!;
    if (!queue.counts.waiting && !queue.counts.running) return queue;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("test queue timeout");
}
test("AI defaults paused, keeps independent queue state and recovers interrupted work", async () => {
  const f = await fixture();
  let ai = f.ai;
  try {
    ai.enqueue({ kind: "wd", fileIds: ["a"] });
    ai.enqueue({ kind: "semantic", fileIds: ["b"] });
    assert.ok(ai.status().queues.every((queue) => queue.paused));
    ai.resume("wd");
    await done(ai, "wd");
    assert.equal(ai.status().queues[1].counts.waiting, 1);
    assert.equal(ai.status().queues[1].paused, true);
    await ai.close();
    f.catalog.db
      .prepare("UPDATE ai_jobs SET status='running' WHERE kind='semantic'")
      .run();
    ai = new LocalAi(f.catalog, { home: f.home, runtime: f.fake });
    assert.equal(ai.status().queues[1].counts.waiting, 1);
    assert.equal(ai.status().queues[1].paused, true);
    ai.resume("semantic");
    await done(ai, "semantic");
    assert.equal(ai.status().queues[1].indexed, 1);
  } finally {
    await ai.close();
    f.catalog.close();
  }
});
test("AI review is independent of manual tags, survives reruns, respects excludes and uses corrected Chinese name", async () => {
  const f = await fixture();
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["a"] });
    f.ai.resume("wd");
    await done(f.ai, "wd");
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "accept" });
    let result = f.ai.candidates("a");
    const tag = result.candidates.find(
      (candidate) => candidate.tag === "blue_hair",
    )!.tagId!;
    assert.equal(
      (f.catalog.db
        .prepare("SELECT COUNT(*) n FROM file_tag_overrides")
        .get() as any)
        ? (
            f.catalog.db
              .prepare("SELECT COUNT(*) n FROM file_tag_overrides")
              .get() as any
          ).n
        : 1,
      0,
    );
    assert.equal(f.catalog.query({ filter: { text: "蓝色头发" } }).total, 1);
    f.catalog.overrideTags(["a"], [tag], "exclude");
    assert.equal(f.catalog.query({ filter: { text: "蓝色头发" } }).total, 0);
    f.catalog.overrideTags(["a"], [tag], "clear");
    f.ai.translate("blue_hair", "蓝发");
    assert.equal(f.catalog.query({ filter: { text: "蓝发" } }).total, 1);
    assert.equal(f.catalog.query({ filter: { text: "蓝色头发" } }).total, 0);
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "exclude" });
    f.fake.run = async () => ({
      elapsedMs: 1,
      providers: ["fixture"],
      candidates: [],
    });
    f.ai.enqueue({ kind: "wd", fileIds: ["a"], scope: "all" });
    await done(f.ai, "wd");
    result = f.ai.candidates("a");
    assert.equal(
      result.candidates.find((candidate) => candidate.tag === "blue_hair")!
        .review,
      "excluded",
    );
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "restore" });
    assert.equal(
      f.ai
        .candidates("a")
        .candidates.find((candidate) => candidate.tag === "blue_hair")!.review,
      "pending",
    );
    assert.equal(
      f.catalog.query({ filter: { tags: [{ ids: [tag] }] } }).total,
      0,
    );
  } finally {
    await f.ai.close();
    f.catalog.close();
  }
});
test("semantic ranking applies full structured scope then correct paging and artwork stacking", async () => {
  const f = await fixture();
  try {
    f.ai.enqueue({ kind: "semantic", fileIds: f.ids });
    f.ai.resume("semantic");
    await done(f.ai, "semantic");
    const strict = await f.ai.search({
      semantic: { query: "任意中文描述" },
      filter: { heightMin: 2560 },
      limit: 1,
    });
    assert.equal(strict.total, 1);
    assert.equal(strict.items[0].id, "d");
    assert.ok(strict.items[0].semanticScore! < 0.2);
    const stack = await f.ai.search({
      semantic: { query: "描述" },
      stackArtworks: true,
      limit: 1,
      offset: 1,
    });
    assert.equal(stack.total, 3);
    assert.equal(stack.items.length, 1);
    assert.equal(stack.semantic!.indexed, 4);
    const first = await f.ai.search({
      semantic: { query: "描述" },
      stackArtworks: true,
      limit: 1,
    });
    assert.equal(first.items[0].matchedCount, 2);
    f.catalog.db
      .prepare("UPDATE files SET mtime_ms=mtime_ms+1 WHERE id=?")
      .run("a");
    const stale = await f.ai.search({ semantic: { query: "描述" } });
    assert.equal(stale.semantic!.indexed, 3);
    assert.equal(stale.semantic!.unindexed, 1);
    f.catalog.db
      .prepare(
        "UPDATE ai_vectors SET model_version='different-model' WHERE file_id='b'",
      )
      .run();
    const other = await f.ai.search({ semantic: { query: "描述" } });
    assert.equal(other.semantic!.indexed, 2);
  } finally {
    await f.ai.close();
    f.catalog.close();
  }
});
test("inference rejects real disk changes before stale derived data can be saved", async () => {
  let original = "";
  const f = await fixture({
    run: async () => {
      await writeFile(original, "changed source bytes");
      return { elapsedMs: 1, providers: ["fixture"], vector: vector() };
    },
    close() {},
  });
  original = path.join(f.source, "a.png");
  try {
    f.ai.enqueue({ kind: "semantic", fileIds: ["a"] });
    f.ai.resume("semantic");
    const queue = await done(f.ai, "semantic");
    assert.equal(queue.counts.failed, 1);
    assert.match(queue.lastError ?? "", /AI_INPUT_CHANGED|rescan required/);
    assert.equal(
      (f.catalog.db.prepare("SELECT COUNT(*) n FROM ai_vectors").get() as any)
        .n,
      0,
    );
    f.ai.retry("semantic");
    assert.equal(f.ai.status().queues[1].counts.waiting, 1);
  } finally {
    await f.ai.close();
    f.catalog.close();
  }
});
test("AI backup and export retain reviews, vectors and queue states, restore clears newer AI changes", async () => {
  const f = await fixture();
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["a"] });
    f.ai.resume("wd");
    await done(f.ai, "wd");
    f.ai.pause("wd");
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "accept" });
    const backup = path.join(f.base, "backup.sqlite");
    await f.catalog.backup(backup);
    await f.catalog.export(path.join(f.base, "export.json"));
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "exclude" });
    await f.catalog.restore(backup);
    assert.equal(
      f.ai
        .candidates("a")
        .candidates.find((candidate) => candidate.tag === "blue_hair")!.review,
      "accepted",
    );
  } finally {
    await f.ai.close();
    f.catalog.close();
  }
});
test("embedding boundary rejects mixed dimensions and unnormalized values", () => {
  assert.throws(() => validVector([1, 0]), /DIMENSION/);
  assert.throws(() => validVector(Array(512).fill(1)), /NORMALIZED/);
  assert.throws(
    () => validVector([...vector().slice(0, 511), NaN]),
    /DIMENSION/,
  );
  assert.equal(validVector(vector()).length, 512);
});
test("merging an accepted AI tag and undo preserve the independent review association", async () => {
  const f = await fixture();
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["a"] });
    f.ai.resume("wd");
    await done(f.ai, "wd");
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "accept" });
    const original = f.ai
      .candidates("a")
      .candidates.find((item) => item.tag === "blue_hair")!.tagId!;
    const target = f.catalog.createTag("蓝发规范标签", "content");
    const merge = f.catalog.mergeTags(original, target);
    assert.equal(
      f.ai.candidates("a").candidates.find((item) => item.tag === "blue_hair")!
        .tagId,
      target,
    );
    assert.equal(
      f.catalog.query({ filter: { tags: [{ ids: [target] }] } }).total,
      1,
    );
    f.catalog.undoTags(merge.undoId);
    assert.equal(
      f.ai.candidates("a").candidates.find((item) => item.tag === "blue_hair")!
        .tagId,
      original,
    );
    assert.equal(
      f.catalog.query({ filter: { tags: [{ ids: [original] }] } }).total,
      1,
    );
  } finally {
    await f.ai.close();
    f.catalog.close();
  }
});
