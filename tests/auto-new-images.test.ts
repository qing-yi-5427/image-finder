import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  readFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Catalog } from "../src/core/catalog.js";
import { AI_MODELS, aiFingerprint } from "../src/core/ai.js";
import { Scanner } from "../src/core/filesystem.js";
import { AutoNewImages } from "../src/core/auto-new-images.js";
import { ImageProcessor } from "../src/core/images.js";
import { ImageFinderService } from "../src/core/service.js";
import { validateInvocation } from "../src/bridge.js";
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "auto-new-"));
  const source = path.join(base, "source");
  await mkdir(source);
  const c = new Catalog(path.join(base, "data"));
  const root = c.addRoot(source);
  let now = Date.now(),
    canProcess = true;
  const queued: string[] = [];
  const images = new ImageProcessor(c, c.dataDir);
  let prepare = (id: string) => images.process(id).then(() => undefined);
  let flow: AutoNewImages;
  const make = () =>
    new AutoNewImages(c, {
      startTimer: false,
      now: () => now,
      canProcess: () => canProcess,
      prepare: (id) => prepare(id),
      enqueue: (id) => queued.push(id),
      reconcile: () => {},
    });
  flow = make();
  const scanner = new Scanner(c, {
    observed: (...args) => flow.observed(...args),
    scanned: (...args) => flow.scanned(...args),
  });
  const png = await sharp({
    create: { width: 20, height: 30, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
  async function add(name: string, bytes: Buffer = png) {
    const p = path.join(source, name);
    await writeFile(p, bytes);
    await utimes(p, new Date(0), new Date(0));
    return p;
  }
  return {
    base,
    source,
    c,
    root,
    scanner,
    images,
    queued,
    add,
    png,
    get flow() {
      return flow;
    },
    advance: (ms = 2100) => (now += ms),
    setPrepare: (value: typeof prepare) => (prepare = value),
    setCan: (value: boolean) => (canProcess = value),
    restart: async () => {
      await flow.close();
      flow = make();
    },
    close: async () => {
      await flow.close();
      c.close();
    },
  };
}

test("first root scan is baseline; only later inserts enter the stable queue, not rename/change/reappearance", async () => {
  const f = await fixture();
  try {
    await f.add("old.png");
    await f.scanner.scan(f.root.id);
    assert.equal(
      (f.c.db.prepare("SELECT COUNT(*) n FROM auto_new_images").get() as any).n,
      0,
    );
    await f.add("new.png");
    await f.scanner.scan(f.root.id);
    const id = f.c.query({ filter: { text: "new.png" } }).items[0].id;
    await f.flow.tick();
    assert.deepEqual(f.queued, []);
    f.advance();
    await f.flow.tick();
    assert.deepEqual(f.queued, [id]);
    assert.ok(f.c.getFile(id).thumbnailKey);
    assert.ok(f.c.db.prepare("SELECT 1 FROM features WHERE file_id=?").get(id));
    await f.scanner.scan(f.root.id);
    f.advance();
    await f.flow.tick();
    assert.deepEqual(f.queued, [id]);
  } finally {
    await f.close();
  }
});

test("partial first scan remains a baseline across restart and upgrade marks existing partial roots", async () => {
  const f = await fixture();
  try {
    await f.add("a.png");
    await f.add("b.png");
    assert.equal(
      (await f.scanner.scan(f.root.id, { limit: 1 })).complete,
      false,
    );
    await f.restart();
    await f.scanner.scan(f.root.id);
    assert.equal(
      (f.c.db.prepare("SELECT COUNT(*) n FROM auto_new_images").get() as any).n,
      0,
    );
    await f.add("c.png");
    await f.scanner.scan(f.root.id);
    assert.equal(
      (f.c.db.prepare("SELECT COUNT(*) n FROM auto_new_images").get() as any).n,
      1,
    );
    f.c.db.prepare("DELETE FROM auto_new_roots").run();
    f.c.db.prepare("UPDATE roots SET status='partial'").run();
    await f.restart();
    assert.equal(
      (
        f.c.db
          .prepare("SELECT baseline_complete n FROM auto_new_roots")
          .get() as any
      ).n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("off is durable, turning on does not backfill, explicit registration remains exact and idempotent", async () => {
  const f = await fixture();
  try {
    await f.add("old.png");
    await f.scanner.scan(f.root.id);
    f.flow.setEnabled(false);
    await f.add("off.png");
    await f.scanner.scan(f.root.id);
    await f.restart();
    assert.equal(f.flow.enabled(), false);
    f.flow.setEnabled(true);
    await f.scanner.scan(f.root.id);
    assert.equal(
      (f.c.db.prepare("SELECT COUNT(*) n FROM auto_new_images").get() as any).n,
      0,
    );
    const id = f.c.query({ filter: { text: "off.png" } }).items[0].id;
    assert.equal(f.flow.register([id, id]).added, 1);
    assert.equal(f.flow.register([id]).added, 0);
    assert.throws(() => f.flow.register([id, "not registered"]));
    assert.equal(
      (f.c.db.prepare("SELECT COUNT(*) n FROM auto_new_images").get() as any).n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("copy-in-progress skips batch processing then automatically retries after a stable rescan", async () => {
  const f = await fixture();
  try {
    await f.scanner.scan(f.root.id);
    const p = await f.add("copy.png", f.png.subarray(0, 12));
    await f.scanner.scan(f.root.id);
    assert.deepEqual(await f.images.processPending(), {
      processed: 0,
      failed: 0,
    });
    f.advance();
    await f.flow.tick();
    assert.deepEqual(f.queued, []);
    assert.equal(
      (f.c.db.prepare("SELECT attempts FROM auto_new_images").get() as any)
        .attempts,
      1,
    );
    await writeFile(p, f.png);
    await utimes(p, new Date(0), new Date(0));
    await f.scanner.scan(f.root.id);
    f.advance();
    await f.flow.tick();
    assert.equal(f.queued.length, 1);
    assert.equal(
      (f.c.db.prepare("SELECT error FROM auto_new_images").get() as any).error,
      null,
    );
  } finally {
    await f.close();
  }
});

test("pause, disable, deletion and mutation during preparation do not publish follow-up jobs", async () => {
  for (const mode of ["pause", "disable", "delete", "mutate"] as const) {
    const f = await fixture();
    try {
      await f.scanner.scan(f.root.id);
      const p = await f.add("new.png");
      await f.scanner.scan(f.root.id);
      f.advance();
      if (mode === "pause") {
        f.setCan(false);
        await f.flow.tick();
        assert.equal(f.queued.length, 0);
        continue;
      }
      f.setPrepare(async (id) => {
        if (mode === "disable") f.flow.setEnabled(false);
        else if (mode === "delete")
          f.c.db.prepare("DELETE FROM files WHERE id=?").run(id);
        else await writeFile(p, Buffer.concat([f.png, Buffer.from("changed")]));
      });
      await f.flow.tick();
      assert.equal(f.queued.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("service settings and exact new-file enqueue preserve all manual queue pauses and protections", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "auto-new-service-"));
  const source = path.join(base, "source");
  await mkdir(source);
  const s = new ImageFinderService(path.join(base, "data"), {
    startPaused: true,
    cachePreferenceFile: path.join(base, "cache.json"),
  });
  try {
    const root = await s.invoke("library.add", { directory: source });
    await s.invoke("library.scan", { rootId: root.id });
    assert.equal((await s.invoke("settings.get")).autoProcessNewImages, true);
    await s.invoke("settings.setAutoDiscoverNewImages", { enabled: false });
    assert.equal((await s.invoke("settings.get")).autoDiscoverNewImages, false);
    await s.invoke("local.pause", { kind: "images" });
    const png = await sharp({
      create: { width: 20, height: 30, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    for (const name of ["12345678_p0.png", "unknown.png"]) {
      await writeFile(path.join(source, name), png);
      await utimes(path.join(source, name), new Date(0), new Date(0));
    }
    await s.invoke("library.scan", { rootId: root.id });
    const ids = s.catalog.query({}).items.map((i) => i.id);
    const before = {
      ai: s.ai.progress().queues.map((q) => q.paused),
      pixiv: s.queue.sourceState().paused,
      dan: s.danbooru.status().paused,
      sauce: s.sauce.status().paused,
    };
    s.catalog.db
      .prepare("UPDATE auto_new_images SET next_check_at=0,stable_since=0")
      .run();
    await s.invoke("local.resume", { kind: "images" });
    for (let i = 0; i < 100 && !s.local.canProcessNewImages; i++)
      await new Promise((r) => setTimeout(r, 5));
    await s.autoNew.tick();
    assert.equal(
      (s.catalog.db.prepare("SELECT COUNT(*) n FROM ai_jobs").get() as any).n,
      4,
    );
    assert.equal(
      (s.catalog.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n,
      1,
    );
    assert.equal(
      (
        s.catalog.db
          .prepare("SELECT COUNT(*) n FROM danbooru_jobs")
          .get() as any
      ).n,
      2,
    );
    assert.equal(
      (s.catalog.db.prepare("SELECT COUNT(*) n FROM sauce_jobs").get() as any)
        .n,
      1,
    );
    assert.deepEqual(
      {
        ai: s.ai.progress().queues.map((q) => q.paused),
        pixiv: s.queue.sourceState().paused,
        dan: s.danbooru.status().paused,
        sauce: s.sauce.status().paused,
      },
      before,
    );
    assert.equal(s.catalog.query({}).items.length, ids.length);
    await s.invoke("settings.setAutoProcessNewImages", { enabled: false });
    assert.equal((await s.invoke("settings.get")).autoProcessNewImages, false);
    assert.equal(
      (await s.invoke("local.registerNewImages", { fileIds: ids })).added,
      0,
    );
  } finally {
    await s.close();
  }
});

test("new settings and exact registration IPC accept only strict explicit values", () => {
  for (const method of [
    "settings.setAutoDiscoverNewImages",
    "settings.setAutoProcessNewImages",
  ]) {
    validateInvocation(method, { enabled: true });
    assert.throws(() => validateInvocation(method, { enabled: "true" }));
    assert.throws(() =>
      validateInvocation(method, { enabled: true, resume: true }),
    );
  }
  validateInvocation("local.registerNewImages", { fileIds: ["known"] });
  assert.throws(() =>
    validateInvocation("local.registerNewImages", { fileIds: [] }),
  );
  assert.throws(() =>
    validateInvocation("local.registerNewImages", {
      fileIds: ["known"],
      scope: "all",
    }),
  );
});

test("new-file WD policy affects only registered new identities, survives disabling and keeps exclusions first", async () => {
  const f = await fixture();
  try {
    await f.add("old.png");
    await f.scanner.scan(f.root.id);
    const old = f.c.query({}).items[0].id;
    await f.add("new.png");
    await f.scanner.scan(f.root.id);
    const id = f.c.query({ filter: { text: "new.png" } }).items[0].id;
    f.advance();
    await f.flow.tick();
    for (const fileId of [old, id]) {
      const file = f.c.getFile(fileId);
      f.c.db
        .prepare("INSERT INTO ai_runs VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          fileId,
          "wd",
          AI_MODELS.wd.id,
          AI_MODELS.wd.version,
          aiFingerprint(file),
          1,
          "{}",
          1,
          "[]",
        );
      f.c.db
        .prepare("INSERT INTO ai_inputs VALUES(?,?,?,?)")
        .run(fileId, "wd", file.bytes, file.mtimeMs);
      for (const [tag, category, score] of [
        ["accepted", "content", 0.6],
        ["low", "content", 0.54],
        ["character_ok", "character", 0.86],
        ["character_low", "character", 0.84],
      ] as const)
        f.c.db
          .prepare("INSERT INTO ai_candidates VALUES(?,?,?,?)")
          .run(fileId, tag, category, score);
      f.c.registerAutomaticTags(fileId);
    }
    assert.equal(
      (f.c.db.prepare("SELECT COUNT(*) n FROM ai_auto_scopes").get() as any).n,
      0,
    );
    const tags = f.c.db
      .prepare(
        "SELECT tag,tag_id FROM ai_automatic_tags WHERE file_id=? ORDER BY tag",
      )
      .all(id) as any[];
    assert.deepEqual(
      tags.map((t) => t.tag),
      ["accepted", "character_ok"],
    );
    assert.equal(
      (
        f.c.db
          .prepare("SELECT COUNT(*) n FROM ai_automatic_tags WHERE file_id=?")
          .get(old) as any
      ).n,
      0,
    );
    f.flow.setEnabled(false);
    f.c.registerAutomaticTags(id);
    assert.equal(
      (
        f.c.db
          .prepare("SELECT COUNT(*) n FROM ai_auto_effective WHERE file_id=?")
          .get(id) as any
      ).n,
      2,
    );
    f.c.overrideTags([id], [tags[0].tag_id], "exclude");
    assert.equal(
      f.c.query({ filter: { tags: [{ ids: [tags[0].tag_id] }] } }).total,
      0,
    );
    f.c.db
      .prepare("INSERT INTO ai_reviews VALUES(?,'character_ok','exclude',?,1)")
      .run(id, tags[1].tag_id);
    assert.equal(
      (
        f.c.db
          .prepare("SELECT COUNT(*) n FROM ai_auto_effective WHERE file_id=?")
          .get(id) as any
      ).n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("existing renamed, edited and returning identities never enter the automatic queue", async () => {
  const f = await fixture();
  try {
    const original = await f.add("old.png");
    await f.scanner.scan(f.root.id);
    const id = f.c.query({}).items[0].id;
    const moved = path.join(f.source, "renamed.png");
    await rename(original, moved);
    await f.scanner.scan(f.root.id);
    assert.equal(f.c.query({}).items[0].id, id);
    await writeFile(moved, Buffer.concat([f.png, Buffer.from("edit")]));
    await f.scanner.scan(f.root.id);
    f.c.db.prepare("UPDATE files SET missing=1 WHERE id=?").run(id);
    await f.scanner.scan(f.root.id);
    assert.equal(f.c.query({}).items[0].missing, false);
    assert.equal(
      (f.c.db.prepare("SELECT COUNT(*) n FROM auto_new_images").get() as any).n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("permanently broken new files have bounded retries and expose a durable processing error", async () => {
  const f = await fixture();
  try {
    await f.scanner.scan(f.root.id);
    await f.add("broken.png", Buffer.from("broken image"));
    await f.scanner.scan(f.root.id);
    for (let i = 0; i < 5; i++) {
      f.advance(40000);
      await f.flow.tick();
    }
    const row = f.c.db
      .prepare("SELECT status,attempts FROM auto_new_images")
      .get() as any;
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 5);
    assert.match(
      (f.c.db.prepare("SELECT processing_error e FROM files").get() as any).e,
      /自动处理新增图片失败/,
    );
    f.advance(40000);
    await f.flow.tick();
    assert.equal(
      (f.c.db.prepare("SELECT attempts FROM auto_new_images").get() as any)
        .attempts,
      5,
    );
    assert.equal(f.queued.length, 0);
  } finally {
    await f.close();
  }
});

test("new automatic work gets a cooperative slot before an existing local processing backlog finishes", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "auto-new-fair-"));
  const source = path.join(base, "source");
  await mkdir(source);
  const png = await sharp({
    create: { width: 20, height: 30, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  for (let i = 0; i < 50; i++) {
    await writeFile(path.join(source, "old" + i + ".png"), png);
    await utimes(
      path.join(source, "old" + i + ".png"),
      new Date(0),
      new Date(0),
    );
  }
  const s = new ImageFinderService(path.join(base, "data"), {
    startPaused: true,
    cachePreferenceFile: path.join(base, "cache.json"),
  });
  try {
    const root = await s.invoke("library.add", { directory: source });
    await s.invoke("library.scan", { rootId: root.id });
    await writeFile(path.join(source, "new.png"), png);
    await utimes(path.join(source, "new.png"), new Date(0), new Date(0));
    await s.invoke("library.scan", { rootId: root.id });
    const id = s.catalog.query({ filter: { text: "new.png" } }).items[0].id;
    s.catalog.db
      .prepare("UPDATE auto_new_images SET next_check_at=0,stable_since=0")
      .run();
    let backlogAtNew = -1;
    const process = s.images.process.bind(s.images);
    s.images.process = async (fileId, signal) => {
      if (fileId === id) {
        assert.equal(s.local.inAutoNewTurn, true);
        backlogAtNew = (
          s.catalog.db
            .prepare(
              "SELECT COUNT(*) n FROM files WHERE id<>? AND feature_version IS NULL",
            )
            .get(id) as any
        ).n;
      }
      return process(fileId, signal);
    };
    await s.invoke("local.resume", { kind: "images" });
    for (let i = 0; i < 500 && backlogAtNew < 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      backlogAtNew > 0,
      "new image must run between old batches, rather than waiting for all 50",
    );
    for (
      let i = 0;
      i < 200 &&
      (s.catalog.db.prepare("SELECT status FROM auto_new_images").get() as any)
        .status !== "enqueued";
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(
      (s.catalog.db.prepare("SELECT status FROM auto_new_images").get() as any)
        .status,
      "enqueued",
    );
  } finally {
    await s.close();
  }
});

test("real directory watch discovers, stabilizes, prepares and enqueues new images without a manual rescan", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "auto-new-watch-"));
  const source = path.join(base, "source");
  await mkdir(source);
  let requests = 0;
  const s = new ImageFinderService(path.join(base, "data"), {
    cachePreferenceFile: path.join(base, "cache.json"),
    fetcher: async () => {
      requests++;
      throw new Error("network must remain paused");
    },
    danbooruRequest: async () => {
      requests++;
      throw new Error("network must remain paused");
    },
    sauceRequest: async () => {
      requests++;
      throw new Error("network must remain paused");
    },
  });
  try {
    s.queue.pause();
    s.danbooru.pause();
    s.sauce.pause("quota_reserve");
    s.ai.pause("wd");
    s.ai.pause("semantic");
    const root = await s.invoke("library.add", { directory: source });
    for (
      let i = 0;
      i < 200 &&
      !(
        s.catalog.db
          .prepare(
            "SELECT baseline_complete n FROM auto_new_roots WHERE root_id=?",
          )
          .get(root.id) as any
      )?.n;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((await s.invoke("settings.get")).autoDiscoverNewImages, true);
    await s.invoke("local.resume", { kind: "images" });
    const png = await sharp({
      create: { width: 20, height: 30, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    for (const name of ["12345678_p0.png", "unknown.png"]) {
      await writeFile(path.join(source, name), png);
      await utimes(path.join(source, name), new Date(0), new Date(0));
    }
    for (
      let i = 0;
      i < 1000 &&
      (
        s.catalog.db
          .prepare(
            "SELECT COUNT(*) n FROM auto_new_images WHERE status='enqueued'",
          )
          .get() as any
      ).n < 2;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      (
        s.catalog.db
          .prepare(
            "SELECT COUNT(*) n FROM auto_new_images WHERE status='enqueued'",
          )
          .get() as any
      ).n,
      2,
    );
    assert.equal(
      (s.catalog.db.prepare("SELECT COUNT(*) n FROM ai_jobs").get() as any).n,
      4,
    );
    assert.equal(
      (s.catalog.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n,
      1,
    );
    assert.equal(
      (
        s.catalog.db
          .prepare("SELECT COUNT(*) n FROM danbooru_jobs")
          .get() as any
      ).n,
      2,
    );
    assert.equal(
      (s.catalog.db.prepare("SELECT COUNT(*) n FROM sauce_jobs").get() as any)
        .n,
      1,
    );
    assert.equal(s.sauce.status().reason, "quota_reserve");
    assert.equal(requests, 0);
    for (const file of s.catalog.query({}).items) {
      assert.ok(file.thumbnailKey);
      await readFile(path.join(s.catalog.cacheDirectory, file.thumbnailKey!));
    }
    await s.invoke("settings.setAutoDiscoverNewImages", { enabled: false });
    assert.equal((s.local as any).watchers.length, 0);
    await writeFile(path.join(source, "not-discovered.png"), png);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(s.catalog.query({}).total, 2);
  } finally {
    await s.close();
  }
});

test("matching cancelled fingerprints stop automatic preparation and prevent late enqueue", async () => {
  for (const timing of ["before", "during"] as const) {
    const f = await fixture();
    try {
      await f.scanner.scan(f.root.id);
      await f.add("new.png");
      await f.scanner.scan(f.root.id);
      const file = f.c.query({}).items[0];
      let prepares = 0;
      const cancel = () =>
        f.c.db
          .prepare(
            "INSERT OR REPLACE INTO local_cancelled_images VALUES(?,?,?)",
          )
          .run(file.id, file.bytes, file.mtimeMs);
      if (timing === "before") cancel();
      f.setPrepare(async () => {
        prepares++;
        cancel();
      });
      f.advance();
      await f.flow.tick();
      assert.equal(prepares, timing === "before" ? 0 : 1);
      assert.equal(f.queued.length, 0);
      assert.equal(
        (f.c.db.prepare("SELECT status FROM auto_new_images").get() as any)
          .status,
        "ignored",
      );
      f.advance();
      await f.flow.tick();
      assert.equal(f.queued.length, 0);
    } finally {
      await f.close();
    }
  }
});
async function ownedAutoFixture() {
  const base = await mkdtemp(path.join(tmpdir(), "auto-new-owner-"));
  const source = path.join(base, "source");
  await mkdir(source);
  const png = await sharp({
    create: { width: 20, height: 30, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(source, "old.png"), png);
  await utimes(path.join(source, "old.png"), new Date(0), new Date(0));
  const s = new ImageFinderService(path.join(base, "data"), {
    startPaused: true,
    cachePreferenceFile: path.join(base, "cache.json"),
  });
  const root = await s.invoke("library.add", { directory: source });
  await s.invoke("library.scan", { rootId: root.id });
  await writeFile(path.join(source, "new.png"), png);
  await utimes(path.join(source, "new.png"), new Date(0), new Date(0));
  await s.invoke("library.scan", { rootId: root.id });
  const id = s.catalog.query({ filter: { text: "new.png" } }).items[0].id;
  s.catalog.db
    .prepare("UPDATE auto_new_images SET next_check_at=0,stable_since=0")
    .run();
  return { s, id, base };
}

test("cooperative automatic work drains safely for backup, restore, close and cancellation", async () => {
  for (const mode of ["backup", "restore", "close", "cancel"] as const) {
    const { s, id, base } = await ownedAutoFixture();
    let closed = false,
      release!: () => void,
      started!: () => void;
    const began = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const original = s.images.process.bind(s.images);
    const backup = path.join(base, "before.sqlite");
    await s.catalog.backup(backup);
    s.images.process = async (fileId, signal) => {
      if (fileId === id) {
        assert.equal(s.local.inAutoNewTurn, true);
        started();
        await gate;
      }
      return original(fileId, signal);
    };
    try {
      await s.invoke("local.resume", { kind: "images" });
      await began;
      const operation =
        mode === "backup"
          ? s.invoke("system.backup", {
              destination: path.join(base, "after.sqlite"),
            })
          : mode === "restore"
            ? s.invoke("system.restore", { source: backup })
            : mode === "cancel"
              ? s.invoke("tasks.cancel", { kind: "local" })
              : s.close();
      release();
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          operation,
          new Promise(
            (_, reject) =>
              (timeout = setTimeout(
                () =>
                  reject(new Error("automatic owner drain timed out: " + mode)),
                4000,
              )),
          ),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      if (mode === "close") closed = true;
      else if (mode === "cancel") {
        assert.equal(
          (s.catalog.db.prepare("SELECT COUNT(*) n FROM ai_jobs").get() as any)
            .n,
          0,
        );
        assert.equal(s.catalog.getFile(id).thumbnailKey, null);
        assert.equal(
          (
            s.catalog.db
              .prepare("SELECT status FROM auto_new_images")
              .get() as any
          ).status,
          "ignored",
        );
      } else assert.ok(s.catalog.db.open);
    } finally {
      release();
      if (!closed) await s.close();
    }
  }
});
