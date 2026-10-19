import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, stat, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Catalog } from "../src/core/catalog.js";
import { AI_MODELS, LocalAi } from "../src/core/ai.js";
import { validateInvocation } from "../src/bridge.js";

type Runtime = NonNullable<
  NonNullable<ConstructorParameters<typeof LocalAi>[1]>["runtime"]
>;
const inference = () => ({
  candidates: [
    { tag: "blue_hair", category: "content", score: 0.9 },
    { tag: "old_tag", category: "content", score: 0.7 },
  ],
  elapsedMs: 1,
  providers: ["injected-fixture"],
});
async function fixture(
  runtime: Runtime = { run: async () => inference(), close() {} },
) {
  const base = await mkdtemp(path.join(tmpdir(), "ai-current-"));
  const home = path.join(base, "runtime"),
    original = path.join(base, "source");
  await mkdir(original);
  await mkdir(path.join(home, "python"), { recursive: true });
  await writeFile(path.join(home, "python/python.exe"), "fake");
  const marker: any = {
    format: 1,
    preprocess: "clip-rgba-white-bicubic-square224-meanstd-v2",
    files: {},
  };
  for (const kind of ["wd", "semantic"] as const) {
    marker.files[kind] = {};
    await mkdir(path.join(home, "models", kind), { recursive: true });
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
  const root = catalog.addRoot(original);
  for (const id of ["a", "b", "c"]) {
    await writeFile(path.join(original, `${id}.png`), "fixture");
    const s = await stat(path.join(original, `${id}.png`));
    catalog.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at) VALUES(?,?,?,?,?,1)",
      )
      .run(id, root.id, `${id}.png`, s.size, s.mtimeMs);
  }
  const ai = new LocalAi(catalog, { home, runtime });
  return {
    ai,
    catalog,
    home,
    original,
    close: async () => {
      await ai.close();
      catalog.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
const untouched = (f: Awaited<ReturnType<typeof fixture>>) => ({
  state: f.catalog.db.prepare("SELECT * FROM ai_state ORDER BY kind").all(),
  jobs: f.catalog.db
    .prepare("SELECT * FROM ai_jobs WHERE file_id!='a' ORDER BY kind,file_id")
    .all(),
});

test("runCurrent completes exactly one WD job and preserves both paused queues and all other waiting rows", async () => {
  const calls: string[] = [];
  const f = await fixture({
    run: async (kind, input) => {
      calls.push(`${kind}:${path.basename(input.path!)}`);
      return inference();
    },
    close() {},
  });
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["b", "c"] });
    f.ai.enqueue({ kind: "semantic", fileIds: ["a", "b", "c"] });
    const before = untouched(f);
    const result = await f.ai.runCurrent("a");
    assert.equal(result.status, "done");
    assert.equal(result.candidates.fileId, "a");
    assert.equal(result.candidates.job?.status, "done");
    assert.equal(result.candidates.candidates.length, 2);
    assert.deepEqual(calls, ["wd:a.png"]);
    assert.deepEqual(untouched(f), before);
    assert.ok(f.ai.status().queues.every((q) => q.paused && !q.activeFileId));
  } finally {
    await f.close();
  }
});

test("same-file concurrent clicks deduplicate; another current image is rejected without changing either job", async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const f = await fixture({
    run: async () => {
      calls++;
      started();
      await gate;
      return inference();
    },
    close() {
      release();
    },
  });
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["b"] });
    const first = f.ai.runCurrent("a"),
      duplicate = f.ai.runCurrent("a");
    assert.equal(first, duplicate);
    await began;
    const before = untouched(f);
    assert.throws(() => f.ai.runCurrent("b"), /AI_WD_BUSY/);
    assert.deepEqual(untouched(f), before);
    release();
    assert.equal((await first).status, "done");
    assert.equal((await duplicate).status, "done");
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("current-file request joins the same background WD flight and does not resume a paused queue", async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const f = await fixture({
    run: async () => {
      calls++;
      started();
      await gate;
      return inference();
    },
    close() {
      release();
    },
  });
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["a", "b"] });
    f.ai.resume("wd");
    await began;
    f.ai.pause("wd");
    const before = untouched(f);
    const current = f.ai.runCurrent("a");
    release();
    assert.equal((await current).status, "done");
    assert.equal(calls, 1);
    assert.deepEqual(untouched(f), before);
  } finally {
    await f.close();
  }
});

test("rerunning current file retains accept/exclude reviews and manual metadata", async () => {
  let round = 0;
  const f = await fixture({
    run: async () =>
      ++round === 1
        ? inference()
        : {
            ...inference(),
            candidates: [{ tag: "new_tag", category: "content", score: 0.8 }],
          },
    close() {},
  });
  try {
    await f.ai.runCurrent("a");
    f.ai.review({ fileIds: ["a"], tag: "blue_hair", action: "accept" });
    f.ai.review({ fileIds: ["a"], tag: "old_tag", action: "exclude" });
    const manual = f.catalog.createTag("my_tag", "style");
    f.catalog.overrideTags(["a"], [manual], "add");
    f.catalog.setFavorite(["a"], true);
    f.catalog.setRating(["a"], 4);
    const before = f.catalog.db
      .prepare("SELECT * FROM file_tag_overrides")
      .all();
    const result = await f.ai.runCurrent("a");
    assert.equal(
      result.candidates.candidates.find((x) => x.tag === "blue_hair")?.review,
      "accepted",
    );
    assert.equal(
      result.candidates.candidates.find((x) => x.tag === "old_tag")?.review,
      "excluded",
    );
    assert.equal(
      result.candidates.candidates.find((x) => x.tag === "new_tag")?.review,
      "pending",
    );
    assert.deepEqual(
      f.catalog.db.prepare("SELECT * FROM file_tag_overrides").all(),
      before,
    );
    assert.equal(
      f.catalog.query({
        filter: { tags: [{ ids: [manual] }], favorite: true, ratingMin: 4 },
      }).items[0].id,
      "a",
    );
  } finally {
    await f.close();
  }
});

test("failure remains visible in durable current-file status; missing model rejects before enqueue", async () => {
  const f = await fixture({
    run: async () => {
      throw new Error("fixture inference failed");
    },
    close() {},
  });
  try {
    f.ai.enqueue({ kind: "wd", fileIds: ["b"] });
    const before = untouched(f);
    const failed = await f.ai.runCurrent("a");
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /fixture inference failed/);
    assert.match(
      f.ai.candidates("a").job!.lastError!,
      /fixture inference failed/,
    );
    assert.deepEqual(untouched(f), before);
    await unlink(path.join(f.home, "models/wd/model.onnx"));
    assert.throws(() => f.ai.runCurrent("c"), /AI_MODEL_MISSING/);
    assert.equal(
      f.catalog.db.prepare("SELECT 1 FROM ai_jobs WHERE file_id='c'").get(),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("changed or removed originals never publish a current-file result and shutdown cannot publish late inference", async () => {
  let calls = 0;
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (release = r));
  const f = await fixture({
    run: async () => {
      calls++;
      started();
      await gate;
      return inference();
    },
    close() {
      release();
    },
  });
  try {
    const pending = f.ai.runCurrent("a");
    await began;
    await writeFile(path.join(f.original, "a.png"), "replaced original");
    release();
    assert.equal((await pending).status, "failed");
    assert.equal(f.ai.candidates("a").run, null);
    const next = f.ai.runCurrent("b");
    const rejected = assert.rejects(next, /SERVICE_CLOSING/);
    await f.ai.close();
    await rejected;
    assert.equal(f.ai.candidates("b").run, null);
    assert.equal(calls, 1, "closing during path/stat checks must not open a new model worker");
  } finally {
    await f.close();
  }
});

test("runCurrent bridge accepts only one registered file identifier", () => {
  validateInvocation("ai.runCurrent", { fileId: "a" });
  for (const payload of [
    {},
    { fileId: "" },
    { fileId: "a", fileIds: ["b"] },
    { fileId: "a", resume: true },
  ])
    assert.throws(() => validateInvocation("ai.runCurrent", payload));
});

test('WD and semantic cancellation discard their own late inference without touching another provider or manual reviews',async()=>{
 for(const kind of ['wd','semantic'] as const){let release!:()=>void,started!:()=>void;const began=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);const f=await fixture({run:async()=>{started();await gate;return {...inference(),vector:Array(512).fill(1)};},close(){release();}});
 try{const other=kind==='wd'?'semantic':'wd';f.ai.enqueue({kind,fileIds:['a','b']});f.ai.enqueue({kind:other,fileIds:['c']});f.catalog.db.prepare("INSERT INTO ai_candidates VALUES('a','preserved','content',0.9)").run();f.ai.review({fileIds:['a'],tag:'preserved',action:'exclude'});const reviews=f.catalog.db.prepare('SELECT * FROM ai_reviews').all();f.ai.resume(kind);await began;assert.throws(()=>f.ai.prepareCleanup(),/AI_ENVIRONMENT_BUSY/);const cancelling=f.ai.cancel(kind);release();assert.equal((await cancelling).cancelled,2);assert.equal((f.catalog.db.prepare('SELECT count(*) n FROM ai_runs WHERE kind=?').get(kind)as any).n,0);assert.deepEqual(f.catalog.db.prepare('SELECT * FROM ai_reviews').all(),reviews);assert.equal((f.catalog.db.prepare('SELECT status FROM ai_jobs WHERE kind=?').get(other)as any).status,'waiting');assert.ok(f.catalog.db.prepare("SELECT * FROM ai_candidates WHERE tag='preserved'").get());assert.equal(f.ai.enqueue({kind,fileIds:['a'],scope:'all'}).enqueued,1);}finally{await f.close();}}
});

test('AI cleanup maintenance rejects active searches and runnable queues, blocks new work and releases after refusal or finish',async()=>{
 let release!:()=>void,started!:()=>void;const began=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);const f=await fixture({run:async()=>{started();await gate;return {vector:Array.from({length:512},(_,i)=>i===0?1:0),elapsedMs:1,providers:[]};},close(){}});
 try{const searching=f.ai.search({semantic:{query:'blue'}});await began;assert.throws(()=>f.ai.prepareCleanup(),/AI_ENVIRONMENT_BUSY/);assert.equal(f.ai.status().maintenance,false);release();await searching;f.ai.enqueue({kind:'wd',fileIds:['a']});f.catalog.db.prepare("UPDATE ai_state SET paused=0 WHERE kind='wd'").run();assert.throws(()=>f.ai.prepareCleanup(),/AI_ENVIRONMENT_BUSY/);f.ai.pause('wd');assert.deepEqual(f.ai.prepareCleanup(),{ready:true});assert.equal(f.ai.status().maintenance,true);assert.throws(()=>f.ai.install(),/MAINTENANCE/);assert.throws(()=>f.ai.runCurrent('a'),/MAINTENANCE/);assert.throws(()=>f.ai.enqueue({kind:'wd',fileIds:['b']}),/MAINTENANCE/);assert.throws(()=>f.ai.resume('wd'),/MAINTENANCE/);await assert.rejects(f.ai.search({semantic:{query:'blue'}}),/MAINTENANCE/);f.ai.finishCleanup();assert.equal(f.ai.status().maintenance,false);await rm(path.join(f.home,'models','semantic'),{recursive:true,force:true});await assert.rejects(f.ai.search({semantic:{query:'blue'}}),/AI_MODEL_MISSING/);assert.equal(f.ai.status().maintenance,false);}finally{release?.();f.ai.finishCleanup();await f.close();}
});

test('runtime Python location follows managed nested-to-embed cleanup and reinstall without restarting the service',async()=>{
 const f=await fixture();try{const nested=path.join(f.home,'python','cpython-3.12.13-windows-x86_64-none');await mkdir(nested,{recursive:true});await writeFile(path.join(nested,'python.exe'),'nested');assert.equal(f.ai.python,path.join(nested,'python.exe'));f.ai.prepareCleanup();await rm(nested,{recursive:true,force:true});f.ai.finishCleanup();assert.equal(f.ai.python,path.join(f.home,'python','python.exe'));assert.equal(f.ai.status().python,path.join(f.home,'python','python.exe'));}finally{await f.close();}
});

test('AI cleanup keeps maintenance lock until idle workers exit and releases it when shutdown fails',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);const f=await fixture({run:async()=>inference(),close(){},closeForMaintenance:()=>wait});try{const ready=f.ai.prepareCleanup();assert.equal(f.ai.status().maintenance,true);assert.throws(()=>f.ai.install(),/MAINTENANCE/);release();await ready;f.ai.finishCleanup();assert.equal(f.ai.status().maintenance,false);(f.ai as any).runtime.closeForMaintenance=async()=>{throw Error('close failed');};await assert.rejects(Promise.resolve(f.ai.prepareCleanup()),/close failed/);assert.equal(f.ai.status().maintenance,false);}finally{release?.();f.ai.finishCleanup();await f.close();}
});
