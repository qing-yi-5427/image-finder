import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "../src/core/catalog.js";
import { LocalAi, aiFingerprint, AI_MODELS } from "../src/core/ai.js";
import { taskOverview } from "../src/core/task-overview.js";
import { validateInvocation } from "../src/bridge.js";
import { ALGORITHM_VERSION } from "../src/core/images.js";
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "automatic-wd-"));
  const source = path.join(dir, "source");
  await mkdir(source);
  const c = new Catalog(path.join(dir, "data"));
  const root = c.addRoot(source);
  for (const [id, name] of [
    ["a", "12/a.png"],
    ["b", "12/sub/b.png"],
    ["c", "120/c.png"],
  ])
    c.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at) VALUES(?,?,?,?,?,1)",
      )
      .run(id, root.id, name, 10, 1);
  let calls = 0;
  const ai = new LocalAi(c, {
    home: path.join(dir, "no-models"),
    runtime: {
      run: async () => {
        calls++;
        throw new Error("Must not infer");
      },
      close() {},
    },
  } as any);
  const seed = (
    id: string,
    kind: "wd" | "semantic" = "wd",
    version = AI_MODELS[kind].version,
  ) => {
    c.db
      .prepare("INSERT OR REPLACE INTO ai_runs VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        kind,
        AI_MODELS[kind].id,
        version,
        aiFingerprint(c.getFile(id)),
        1,
        '{"general":0.35,"character":0.85}',
        1,
        "[]",
      );
    c.db
      .prepare("INSERT OR REPLACE INTO ai_inputs VALUES(?,?,?,?)")
      .run(id, kind, 10, 1);
    c.db
      .prepare("INSERT OR REPLACE INTO ai_jobs VALUES(?,?,'done',1,NULL,1)")
      .run(kind, id);
  };
  return {
    dir,
    c,
    root,
    ai,
    seed,
    calls: () => calls,
    scope: { rootId: root.id, relativePath: "12", recursive: true },
    async close() {
      await ai.close();
      c.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("existing valid WD candidates become effective only in enabled directory; stable English identity, scores and reviews preserved", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b", "c"]) {
      f.seed(id);
      for (const [tag, cat, score] of [
        ["blue_hair", "content", 0.8],
        ["person_a", "character", 0.86],
        ["person_b", "character", 0.84],
        ["borderline", "content", 0.54],
        ["safe", "rating", 0.99],
      ] as const)
        f.c.db
          .prepare("INSERT INTO ai_candidates VALUES(?,?,?,?)")
          .run(id, tag, cat, score);
    }
    const shared = f.c.createTag("blue_hair");
    f.c.db
      .prepare("INSERT OR REPLACE INTO ai_lexicon VALUES('blue_hair','蓝发')")
      .run();
    const before = f.c.db.prepare("SELECT * FROM ai_reviews").all();
    assert.equal(f.c.query({ filter: { tags: [{ ids: [shared] }] } }).total, 0);
    const result = f.c.enableAutomaticTags(f.scope);
    assert.equal(result.generalThreshold, 0.55);
    assert.equal(result.characterThreshold, 0.85);
    assert.equal(f.calls(), 0);
    assert.equal(f.c.query({ filter: { text: "蓝发" } }).total, 2);
    assert.equal(f.c.query({ filter: { tags: [{ ids: [shared] }] } }).total, 2);
    assert.equal(f.c.query({ filter: { excludeTagIds: [shared] } }).total, 1);
    assert.equal(f.c.tags("蓝发")[0].id, shared);
    assert.equal(f.c.tags("blue_hair")[0].usageCount, 2);
    assert.equal(
      f.c.db
        .prepare(
          "SELECT 1 FROM ai_tag_keys WHERE tag IN ('borderline','person_b','safe')",
        )
        .get(),
      undefined,
    );
    assert.deepEqual(f.c.db.prepare("SELECT * FROM ai_reviews").all(), before);
    const candidate = f.ai
      .candidates("a")
      .candidates.find((x) => x.tag === "blue_hair")!;
    assert.equal(candidate.review, "pending");
    assert.equal(candidate.automatic, true);
    assert.equal(candidate.effective, true);
    assert.equal(candidate.score, 0.8);
    assert.equal(
      f.ai.candidates("c").candidates.find((x) => x.tag === "blue_hair")!
        .automatic,
      false,
    );
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "exclude" });
    assert.equal(f.c.query({ filter: { text: "blue_hair" } }).total, 1);
    f.c.overrideTags(["b"], [shared], "exclude");
    assert.equal(f.c.query({ filter: { tags: [{ ids: [shared] }] } }).total, 0);
    assert.equal(f.c.tags("blue_hair")[0].usageCount, 0);
    assert.equal(
      f.ai.candidates("b").candidates.find((x) => x.tag === "blue_hair")!
        .effective,
      false,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});
test("stale input or obsolete run cannot supply automatic tags; future files in enabled scope register without changing other directories", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b", "c"]) {
      f.seed(id);
      f.c.db
        .prepare("INSERT INTO ai_candidates VALUES(?,'same','content',0.9)")
        .run(id);
    }
    f.c.enableAutomaticTags(f.scope);
    const id = f.c.tags("same")[0].id;
    assert.equal(f.c.query({ filter: { tags: [{ ids: [id] }] } }).total, 2);
    f.c.db.prepare("UPDATE files SET bytes=11 WHERE id='a'").run();
    assert.equal(f.c.query({ filter: { tags: [{ ids: [id] }] } }).total, 1);
    f.c.db
      .prepare("UPDATE ai_runs SET model_version='obsolete' WHERE file_id='b'")
      .run();
    assert.equal(f.c.query({ filter: { tags: [{ ids: [id] }] } }).total, 0);
    f.c.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at) VALUES('d',?,'12/new.png',10,1,2)",
      )
      .run(f.root.id);
    f.seed("d");
    f.c.db
      .prepare("INSERT INTO ai_candidates VALUES('d','new_key','content',0.9)")
      .run();
    f.c.registerAutomaticTags("d");
    assert.equal(f.c.query({ filter: { text: "new_key" } }).total, 1);
    assert.equal(
      f.c.query({
        filter: {
          directory: { rootId: f.root.id, relativePath: "120" },
          text: "same",
        },
      }).total,
      0,
    );
    const backup = path.join(f.dir, "backup.sqlite");
    await f.c.backup(backup);
    await f.c.restore(backup);
    assert.equal(f.c.query({ filter: { text: "new_key" } }).total, 1);
    const merge = f.c.mergeTags(f.c.tags("new_key")[0].id, id);
    assert.equal(f.c.query({ filter: { tags: [{ ids: [id] }] } }).total, 1);
    f.c.undoTags(merge.undoId);
    assert.equal(f.c.query({ filter: { text: "new_key" } }).total, 1);
  } finally {
    await f.close();
  }
});
test("Chinese translation collisions never merge English identities and 12 does not enable 120", async () => {
  const f = await fixture();
  try {
    f.seed("a");
    for (const tag of ["first", "second"]) {
      f.c.db
        .prepare("INSERT INTO ai_candidates VALUES(?,?,?,?)")
        .run("a", tag, "content", 0.9);
      f.c.db.prepare("INSERT INTO ai_lexicon VALUES(?,?)").run(tag, "同译名");
    }
    f.c.enableAutomaticTags(f.scope);
    assert.equal(
      f.c.db.prepare("SELECT DISTINCT tag_id FROM ai_tag_keys").all().length,
      2,
    );
    assert.equal(f.c.query({ filter: { text: "同译名" } }).total, 1);
    assert.equal(
      f.c.db.prepare("SELECT count(*) n FROM ai_auto_scopes").get() &&
        f.c.query({
          filter: {
            directory: { rootId: f.root.id, relativePath: "120" },
            text: "first",
          },
        }).total,
      0,
    );
  } finally {
    await f.close();
  }
});
test("preexisting WD exclusions can be restored without inference and refreshed low scores remove automatic tags", async () => {
  const f = await fixture();
  try {
    f.seed("a");
    f.c.db.prepare("INSERT INTO ai_candidates VALUES('a','restorable','content',0.9)").run();
    f.ai.review({ fileIds: ["a"], tag: "restorable", action: "exclude" });
    f.c.enableAutomaticTags(f.scope);
    assert.equal(f.c.query({ filter: { text: "restorable" } }).total, 0);
    f.ai.review({ fileIds: ["a"], tag: "restorable", action: "restore" });
    assert.equal(f.c.query({ filter: { text: "restorable" } }).total, 1);
    f.c.db.prepare("UPDATE ai_candidates SET score=0.54 WHERE file_id='a'").run();
    f.c.registerAutomaticTags("a");
    assert.equal(f.c.query({ filter: { text: "restorable" } }).total, 0);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
test("scope overview separates image coverage, WD analysis and tagged images, unique Pixiv work progress and terminal categories", async () => {
  const f = await fixture();
  try {
    f.seed("a");
    f.seed("b");
    f.seed("c");
    f.c.db
      .prepare("INSERT INTO ai_candidates VALUES('a','tag','content',0.9)")
      .run();
    f.c.enableAutomaticTags(f.scope);
    f.c.db.prepare("INSERT INTO creators VALUES('creator','Creator')").run();
    f.c.db
      .prepare("INSERT INTO artworks VALUES('100','Title','creator',2,NULL,1)")
      .run();
    f.c.db
      .prepare("UPDATE files SET artwork_id='100' WHERE id IN ('a','b')")
      .run();
    f.c.db
      .prepare(
        "INSERT INTO jobs(id,artwork_id,status,updated_at) VALUES('j','100','done',1)",
      )
      .run();
    f.c.db.exec(
      "CREATE TABLE IF NOT EXISTS danbooru_jobs(file_id TEXT PRIMARY KEY,status TEXT,bytes INTEGER,mtime_ms REAL);CREATE TABLE IF NOT EXISTS sauce_jobs(file_id TEXT PRIMARY KEY,status TEXT);",
    );
    f.c.db
      .prepare(
        "INSERT INTO danbooru_jobs VALUES('a','unavailable',10,1),('b','no_match',10,1),('c','error',10,1)",
      )
      .run();
    const state = {
      pixiv: { paused: 1, reason: "user" },
      ai: {
        queues: [
          { kind: "wd", paused: true },
          { kind: "semantic", paused: true },
        ],
      },
      danbooru: { paused: false, reason: null },
      sauce: { paused: true, reason: "not_started" },
      local: { imagesPaused: true },
    };
    const before = f.c.db.prepare("SELECT * FROM jobs").all();
    const overview = taskOverview(f.c, f.scope, f.scope, state);
    assert.equal(overview.scope.total, 2);
    assert.equal(overview.cards[0].coverage.covered, 2);
    assert.equal(overview.cards[0].progress.total, 1);
    assert.equal(overview.cards[0].progress.unit, "作品");
    const wd = overview.cards.find((c) => c.kind === "wd")!;
    assert.equal(wd.coverage.covered, 2);
    assert.equal(wd.coverage.automaticTagged, 1);
    const dan = overview.cards.find((c) => c.kind === "danbooru")!;
    assert.equal(dan.coverage.covered, 0);
    assert.equal(dan.progress.processed, 2);
    assert.deepEqual(dan.progress.counts, [
      { status: "no_match", count: 1 },
      { status: "unavailable", count: 1 },
    ]);
    assert.equal(taskOverview(f.c, null, f.scope, state).scope.total, 3);
    assert.equal(
      taskOverview(f.c, { ...f.scope, recursive: false }, f.scope, state).scope
        .total,
      1,
    );
    assert.deepEqual(f.c.db.prepare("SELECT * FROM jobs").all(), before);
    assert.deepEqual(overview.executionScope, f.scope);
    f.c.db.prepare("UPDATE files SET feature_version=?,processing_error='decode failed' WHERE id='a'").run(ALGORITHM_VERSION);
    f.c.db.prepare("INSERT INTO features VALUES('a','[]',0,0,'neutral',?)").run(ALGORITHM_VERSION);
    const local = taskOverview(f.c, f.scope, f.scope, state).cards.find(c => c.kind === "local")!;
    assert.equal(local.coverage.covered, 0, "failed image cannot also count ready from retained features");
    assert.equal(local.progress.counts.reduce((n, row) => n + row.count, 0), 2);
    f.c.db.prepare("UPDATE files SET processing_error=NULL WHERE id='a'").run();
    f.c.db.prepare("INSERT INTO local_cancelled_images VALUES('a',10,1)").run();
    const cancelledLocal=taskOverview(f.c,f.scope,f.scope,state).cards.find(c=>c.kind==='local')!;
    assert.equal(cancelledLocal.coverage.covered,1);
    assert.equal(cancelledLocal.progress.counts.reduce((n,row)=>n+row.count,0),2);
    assert.equal(cancelledLocal.progress.counts.find(row=>row.status==='cancelled')?.count,1);
    assert.equal(cancelledLocal.progress.counts.find(row=>row.status==='ready')?.count,0);

  } finally {
    await f.close();
  }
});
test("read-only overview and auto policy IPC reject traversal and extra execution flags", () => {
  validateInvocation("tasks.overview", {});
  validateInvocation("tasks.overview", { scope: null });
  assert.throws(() =>
    validateInvocation("tasks.overview", {
      scope: { rootId: "r", relativePath: "../12", recursive: true },
    }),
  );
  assert.throws(() =>
    validateInvocation("tasks.overview", { scope: null, start: true }),
  );
  validateInvocation("ai.autoEnable", {
    rootId: "r",
    relativePath: "12",
    recursive: true,
  });
  assert.throws(() =>
    validateInvocation("ai.autoEnable", {
      rootId: "r",
      relativePath: "12",
      recursive: true,
      generalThreshold: 0.1,
    }),
  );
});

test('task cancellation IPC is explicit provider-only and cancelled filters remain valid',()=>{
 for(const kind of ['pixiv','wd','semantic','danbooru','sauce','local'])validateInvocation('tasks.cancel',{kind});
 assert.throws(()=>validateInvocation('tasks.cancel',{kind:'all'}));assert.throws(()=>validateInvocation('tasks.cancel',{kind:'wd',scope:null}));
 validateInvocation('files.query',{filter:{enrichmentStatus:['cancelled']}});
});
