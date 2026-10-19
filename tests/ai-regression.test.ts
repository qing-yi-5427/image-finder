import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Catalog } from "../src/core/catalog.js";
import { LocalAi, AI_MODELS, aiFingerprint } from "../src/core/ai.js";
import type { AiKind } from "../src/core/ai-contracts.js";
import { ImageFinderService } from "../src/core/service.js";

// These injected runtimes exercise persistence, filtering and race boundaries.
// They are deliberately not evidence for model accuracy or inference capability.
const vector = (score = 1) => {
  const result = Array<number>(512).fill(0);
  result[0] = score;
  result[1] = Math.sqrt(1 - score * score);
  return result;
};
type Runtime = NonNullable<ConstructorParameters<typeof LocalAi>[1]>["runtime"];
const scores: Record<string, number> = {
  a: 0.7,
  b: 0.8,
  c: 0.99,
  d: 0.6,
  e: 0.5,
  f: 0.4,
};
function runtime(): NonNullable<Runtime> {
  return {
    async run(kind, payload) {
      return {
        elapsedMs: 1,
        providers: ["injected-logic-fixture"],
        ...(kind === "wd"
          ? {
              candidates: [
                { tag: "blue_hair", category: "content", score: 0.9 },
              ],
            }
          : {
              vector: vector(
                payload.text ? 1 : scores[path.basename(payload.path!, ".png")],
              ),
            }),
      };
    },
    close() {},
  };
}
async function fixture(
  options: { runtime?: Runtime; service?: boolean; ready?: boolean } = {},
) {
  const base = await mkdtemp(path.join(tmpdir(), "finder-ai-regression-"));
  const source = path.join(base, "原目录"),
    home = path.join(base, "runtime");
  await mkdir(source);
  await mkdir(home);
  if (options.ready !== false) {
    await mkdir(path.join(home, "python"));
    await writeFile(path.join(home, "python", "python.exe"), "fake");
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
    await writeFile(
      path.join(home, "models-ready.json"),
      JSON.stringify(marker),
    );
  }
  await writeFile(
    path.join(home, "wd-translations.json"),
    JSON.stringify({ tags: { blue_hair: "蓝色头发" } }),
  );
  let service: ImageFinderService | undefined;
  if (options.service) {
    const previous = process.env.IMAGE_FINDER_AI_HOME;
    process.env.IMAGE_FINDER_AI_HOME = home;
    try {
      service = new ImageFinderService(path.join(base, "catalog"));
    } finally {
      if (previous === undefined) delete process.env.IMAGE_FINDER_AI_HOME;
      else process.env.IMAGE_FINDER_AI_HOME = previous;
    }
    await service.invoke("local.pause", { kind: "scan" });
    await service.ai.close();
  }
  const catalog = service?.catalog ?? new Catalog(path.join(base, "catalog"));
  const root = catalog.addRoot(source);
  for (const [index, id] of Object.keys(scores).entries()) {
    const relative =
      id === "c" ? "123/c.png" : id === "d" ? "12/deep/d.png" : `12/${id}.png`;
    const original = path.join(source, relative);
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(original, `fixture-${id}`);
    const info = await stat(original);
    catalog.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,width,height,format,artwork_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        root.id,
        relative,
        info.size,
        info.mtimeMs,
        index + 1,
        100,
        300,
        "png",
        id === "a" || id === "b" ? "81470181" : null,
      );
  }
  const ai = new LocalAi(catalog, {
    home,
    runtime: options.runtime ?? runtime(),
  });
  if (service) service.ai = ai;
  return {
    base,
    source,
    home,
    catalog,
    root,
    ai,
    service,
    close: async () => {
      if (service) await service.close();
      else {
        await ai.close();
        catalog.close();
      }
    },
  };
}
async function waitIdle(ai: LocalAi, kind: AiKind) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const queue = ai.status().queues.find((queue) => queue.kind === kind)!;
    if (!queue.counts.waiting && !queue.counts.running && !queue.activeFileId)
      return queue;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`AI ${kind} fixture queue did not become idle`);
}

for (const kind of ["wd", "semantic"] as const)
  test(`host recycle while ${kind} is in flight rejects publication and cannot become a semantic hit`, async () => {
    let release!: () => void, started!: () => void;
    const began = new Promise<void>((resolve) => (started = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    const fake = runtime();
    const run = fake.run.bind(fake);
    fake.run = async (current, payload, provider) => {
      if (payload.path) {
        started();
        await gate;
      }
      return run(current, payload, provider);
    };
    const f = await fixture({ runtime: fake, service: true });
    try {
      f.ai.enqueue({ kind, fileIds: ["a"] });
      f.ai.resume(kind);
      await began;
      await rm(path.join(f.source, "12/a.png")); // Disposable original only: represents completed OS recycle.
      await f.service!.invoke("files.trashCommitted", { fileIds: ["a"] });
      release();
      const queue = await waitIdle(f.ai, kind);
      assert.equal(queue.counts.failed, 1);
      assert.equal(
        (
          f.catalog.db
            .prepare("SELECT count(*) n FROM ai_runs WHERE file_id='a'")
            .get() as any
        ).n,
        0,
      );
      assert.equal(
        (
          f.catalog.db
            .prepare("SELECT count(*) n FROM ai_candidates WHERE file_id='a'")
            .get() as any
        ).n,
        0,
      );
      assert.equal(
        (
          f.catalog.db
            .prepare("SELECT count(*) n FROM ai_vectors WHERE file_id='a'")
            .get() as any
        ).n,
        0,
      );
      assert.equal(f.catalog.getFile("a").missing, true);
      const result = await f.ai.search({ semantic: { query: "中文画面描述" } });
      assert.equal(
        result.items.some((item) => item.id === "a"),
        false,
      );
    } finally {
      release();
      await f.close();
    }
  });

test("batch review rolls back newly created tags and prior reviews if a later file has no candidate", async () => {
  const f = await fixture();
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["a"] });
    f.ai.resume("wd");
    await waitIdle(f.ai, "wd");
    f.ai.pause("wd");
    const before = f.catalog.tags().map((tag: any) => tag.id);
    assert.throws(
      () =>
        f.ai.review({
          fileIds: ["a", "b"],
          tag: "blue_hair",
          action: "accept",
        }),
      /AI_CANDIDATE_NOT_FOUND/,
    );
    assert.equal(
      (f.catalog.db.prepare("SELECT count(*) n FROM ai_reviews").get() as any)
        .n,
      0,
    );
    assert.deepEqual(
      f.catalog.tags().map((tag: any) => tag.id),
      before,
    );
    assert.equal(f.ai.candidates("a").candidates[0].review, "pending");
  } finally {
    await f.close();
  }
});

test("WD review/rerun and translated search preserve source inheritance and manual overrides as independent layers", async () => {
  const fake = runtime();
  const f = await fixture({ runtime: fake });
  try {
    const source = {
      id: "81470181",
      title: "来源标题",
      creator: { id: "12345", name: "来源作者" },
      pageCount: 2,
      publishedAt: null,
      tags: [{ name: "blue_hair" }],
      raw: { fixture: true },
    };
    f.catalog.applyArtwork(source);
    const manual = f.catalog.createTag("手工标签", "content");
    f.catalog.overrideTags(["a"], [manual], "add");
    const snapshot = () => ({
      source: f.catalog.db
        .prepare("SELECT * FROM artwork_tags ORDER BY artwork_id,raw_name")
        .all(),
      manual: f.catalog.db
        .prepare("SELECT * FROM file_tag_overrides ORDER BY file_id,tag_id")
        .all(),
    });
    const before = snapshot();
    f.ai.enqueue({ kind: "wd", fileIds: ["a"] });
    f.ai.resume("wd");
    await waitIdle(f.ai, "wd");
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "accept" });
    const candidate = f.ai
      .candidates("a")
      .candidates.find((item) => item.tag === "blue_hair")!;
    assert.equal(
      f.catalog.query({ filter: { tags: [{ ids: [candidate.tagId!] }] } })
        .total,
      2,
      "accepting AI must not remove an independent inherited source tag",
    );
    f.ai.translate("blue_hair", "校正后的蓝发");
    assert.equal(
      f.catalog.query({ filter: { text: "校正后的蓝发" } }).total,
      1,
    );
    assert.equal(f.catalog.query({ filter: { text: "蓝色头发" } }).total, 0);
    f.catalog.overrideTags(["a"], [candidate.tagId!], "exclude");
    assert.equal(
      f.catalog.query({ filter: { text: "校正后的蓝发" } }).total,
      0,
      "manual exclusion overrides accepted AI and source inheritance",
    );
    f.catalog.overrideTags(["a"], [candidate.tagId!], "clear");
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "exclude" });
    fake.run = async () => ({
      elapsedMs: 1,
      providers: ["injected-logic-fixture"],
      candidates: [],
    });
    f.ai.enqueue({ kind: "wd", fileIds: ["a"], scope: "all" });
    await waitIdle(f.ai, "wd");
    assert.equal(
      f.ai.candidates("a").candidates.find((item) => item.tag === "blue_hair")
        ?.review,
      "excluded",
    );
    assert.equal(
      f.catalog.query({ filter: { tags: [{ ids: [candidate.tagId!] }] } })
        .total,
      2,
      "excluding AI must not erase the source layer",
    );
    f.catalog.applyArtwork(source);
    assert.equal(
      f.ai.candidates("a").candidates.find((item) => item.tag === "blue_hair")
        ?.review,
      "excluded",
    );
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "restore" });
    assert.equal(
      f.ai.candidates("a").candidates.find((item) => item.tag === "blue_hair")
        ?.review,
      "pending",
    );
    assert.deepEqual(snapshot(), before);
  } finally {
    await f.close();
  }
});

test("semantic applies directory, normal collection, manual tag and favorite intersections before ranking/paging/stacking", async () => {
  const f = await fixture();
  try {
    const tag = f.catalog.createTag("人工筛选", "content");
    f.catalog.overrideTags(["a", "b", "c", "d"], [tag], "add");
    f.catalog.setFavorite(["a", "b", "c", "d"], true);
    const collectionId = f.catalog.createCollection("目录交集", "normal");
    f.catalog.collectionItems(collectionId, ["a", "b", "c", "d"]);
    f.ai.enqueue({ kind: "semantic", fileIds: Object.keys(scores) });
    f.ai.resume("semantic");
    await waitIdle(f.ai, "semantic");
    const filter = {
      directory: { rootId: f.root.id, relativePath: "12" },
      collectionId,
      tags: [{ ids: [tag] }],
      favorite: true,
      heightMin: 200,
    };
    const first = await f.ai.search({
      semantic: { query: "海边的女孩" },
      filter,
      limit: 1,
      offset: 0,
    });
    assert.equal(first.total, 3);
    assert.equal(first.items[0].id, "b");
    assert.equal(first.semantic?.indexed, 3);
    const second = await f.ai.search({
      semantic: { query: "海边的女孩" },
      filter,
      limit: 1,
      offset: 1,
    });
    assert.equal(second.total, 3);
    assert.equal(second.items[0].id, "a");
    const grouped = await f.ai.search({
      semantic: { query: "海边的女孩" },
      filter,
      stackArtworks: true,
      limit: 1,
    });
    assert.equal(grouped.total, 2);
    assert.equal(grouped.items[0].id, "b");
    assert.equal(grouped.items[0].matchedCount, 2);
    const next = await f.ai.search({
      semantic: { query: "海边的女孩" },
      filter,
      stackArtworks: true,
      limit: 1,
      offset: 1,
    });
    assert.equal(next.items[0].id, "d");
    assert.equal(next.total, 2);
    assert.equal(
      f.catalog.query({ filter }).total,
      3,
      "rankedQuery must clear temporary similarity state before plain queries",
    );
  } finally {
    await f.close();
  }
});

test("semantic excludes stale fingerprint, wrong dimension, obsolete version and missing files together", async () => {
  const f = await fixture();
  try {
    f.ai.enqueue({ kind: "semantic", fileIds: Object.keys(scores) });
    f.ai.resume("semantic");
    await waitIdle(f.ai, "semantic");
    f.catalog.db
      .prepare("UPDATE ai_runs SET input_fingerprint='stale' WHERE file_id='b'")
      .run();
    f.catalog.db
      .prepare("UPDATE ai_vectors SET dimension=511 WHERE file_id='c'")
      .run();
    f.catalog.db
      .prepare(
        "UPDATE ai_vectors SET model_version='obsolete' WHERE file_id='d'",
      )
      .run();
    f.catalog.db.prepare("UPDATE files SET missing=1 WHERE id='e'").run();
    f.catalog.db.prepare("UPDATE files SET bytes=bytes+1 WHERE id='f'").run();
    const result = await f.ai.search({
      semantic: { query: "蓝色头发" },
      filter: { missing: false },
    });
    assert.deepEqual(
      result.items.map((item) => item.id),
      ["a"],
    );
    assert.equal(result.total, 1);
    assert.equal(result.semantic?.indexed, 1);
    assert.equal(result.semantic?.unindexed, 4);
    assert.equal(
      (
        f.catalog.db
          .prepare("SELECT input_fingerprint FROM ai_runs WHERE file_id='a'")
          .get() as any
      ).input_fingerprint,
      aiFingerprint(f.catalog.getFile("a")),
    );
  } finally {
    await f.close();
  }
});

test("retry only requeues failed requested kind/IDs and preserves another paused queue", async () => {
  const fake = runtime(),
    run = fake.run.bind(fake);
  let fail = true;
  fake.run = async (kind, payload, provider) => {
    if (fail && kind === "wd") throw new Error("injected inference failure");
    return run(kind, payload, provider);
  };
  const f = await fixture({ runtime: fake });
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["a", "b"] });
    f.ai.enqueue({ kind: "semantic", fileIds: ["c"] });
    f.ai.resume("wd");
    assert.equal((await waitIdle(f.ai, "wd")).counts.failed, 2);
    f.ai.pause("wd");
    fail = false;
    const retried = f.ai.retry("wd", ["a"]);
    assert.equal(retried.retried, 1);
    const semantic = f.ai
      .status()
      .queues.find((queue) => queue.kind === "semantic")!;
    assert.equal(semantic.paused, true);
    assert.equal(semantic.counts.waiting, 1);
    f.ai.resume("wd");
    const wd = await waitIdle(f.ai, "wd");
    assert.equal(wd.counts.done, 1);
    assert.equal(wd.counts.failed, 1);
    assert.equal(
      (
        f.catalog.db
          .prepare(
            "SELECT attempts FROM ai_jobs WHERE kind='wd' AND file_id='a'",
          )
          .get() as any
      ).attempts,
      2,
    );
    assert.equal(
      (
        f.catalog.db
          .prepare(
            "SELECT attempts FROM ai_jobs WHERE kind='semantic' AND file_id='c'",
          )
          .get() as any
      ).attempts,
      0,
    );
  } finally {
    await f.close();
  }
});

test("missing models reject AI resume/search while service basic browsing and organization remain available", async () => {
  const f = await fixture({
    ready: false,
    service: true,
    runtime: {
      async run() {
        throw new Error("missing models must never invoke runtime");
      },
      close() {},
    },
  });
  try {
    assert.equal(
      f.ai.status().models.every((model) => !model.ready),
      true,
    );
    await assert.rejects(
      f.service!.invoke("ai.resume", { kind: "semantic" }),
      /AI_MODEL_MISSING/,
    );
    await assert.rejects(
      f.service!.invoke("files.query", { semantic: { query: "中文描述" } }),
      /AI_MODEL_MISSING/,
    );
    const browse = await f.service!.invoke("files.query", {
      filter: { directory: { rootId: f.root.id, relativePath: "12" } },
    });
    assert.equal(browse.total, 5);
    await f.service!.invoke("files.favorite", {
      fileIds: ["a"],
      favorite: true,
    });
    assert.equal(
      (await f.service!.invoke("files.detail", { fileId: "a" })).favorite,
      true,
    );
  } finally {
    await f.close();
  }
});
