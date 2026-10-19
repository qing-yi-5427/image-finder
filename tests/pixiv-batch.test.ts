import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Catalog } from "../src/core/catalog.js";
import { PixivQueue } from "../src/core/queue.js";
import { validateInvocation } from "../src/bridge.js";
import type { PixivBatchScope } from "../src/core/pixiv-batch-contracts.js";

function fixture(nested = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "pixiv-batch-"));
  const original = path.join(dir, "original");
  mkdirSync(original);
  const c = new Catalog(
    nested ? path.join(original, ".image-finder") : path.join(dir, "data"),
  );
  const root = c.addRoot(original);
  const q = new PixivQueue(c, { intervalMs: 60000, jitterMs: 0 });
  const insert = c.db.prepare(
    "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,artwork_id,page,missing,candidate_artwork_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  const file = (
    id: string,
    relative: string,
    artwork: string | null,
    page = 0,
    missing = 0,
    candidate: string | null = null,
  ) =>
    insert.run(
      id,
      root.id,
      relative,
      1,
      1,
      1,
      artwork,
      page,
      missing,
      candidate,
    );
  const scope = (
    relativePath = "",
    recursive = true,
    mode: PixivBatchScope["mode"] = "missing_or_failed",
  ): PixivBatchScope => ({ rootId: root.id, relativePath, recursive, mode });
  const cleanup = async () => {
    await q.close();
    c.close();
    rmSync(dir, { recursive: true });
  };
  return { dir, original, c, root, q, file, scope, cleanup };
}
function source(c: Catalog, id: string, tag = "source_tag") {
  c.applyArtwork({
    id,
    title: `source-${id}`,
    creator: { id: "1", name: "Fixture" },
    pageCount: 10,
    publishedAt: null,
    tags: [{ name: tag }],
    raw: { fixture: true },
  });
}

test("directory scope uses boundaries, escaped names, recursive flag and distinct works; candidate IDs and missing files are not jobs", async () => {
  const f = fixture();
  try {
    f.file("a", "目录%_/10001_p0.png", "10001");
    f.file("b", "目录%_\\10001_p1.png", "10001", 1);
    f.file("c", "目录%_/child/10002_p0.png", "10002");
    f.file("sibling", "目录XX/10003_p0.png", "10003");
    f.file("boundary", "目录%_2/10004_p0.png", "10004");
    f.file("unbound", "目录%_/unknown.png", null, 0, 0, "10005");
    f.file("missing", "目录%_/10006_p0.png", "10006", 0, 1);
    f.file("outside", "other/10001_p2.png", "10001", 2);
    let p = f.q.previewScope(f.scope("目录%_", false));
    assert.deepEqual(
      [
        p.fileCount,
        p.boundFileCount,
        p.unboundFileCount,
        p.artworkCount,
        p.eligibleFileCount,
      ],
      [3, 2, 1, 1, 2],
    );
    p = f.q.previewScope(f.scope("目录%_", true));
    assert.deepEqual(
      [p.fileCount, p.artworkCount, p.eligibleFileCount],
      [4, 2, 3],
    );
    const normalized = f.q.previewScope(f.scope("目录%_\\child", false));
    assert.equal(normalized.scope.relativePath, "目录%_/child");
    assert.equal(normalized.fileCount, 1);
    const result = f.q.enqueueScope(p.scope, p.previewToken);
    assert.deepEqual([result.enqueued, result.queuedFileCount], [2, 3]);
    assert.deepEqual(
      f.q
        .list()
        .map((x) => x.artworkId)
        .sort(),
      ["10001", "10002"],
    );
  } finally {
    await f.cleanup();
  }
});

test("all mode requeues done and failed with fresh attempts, but terminal unavailable never loops and pending/running remain untouched", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 6; i++)
      f.file(`f${i}`, `scope/${10000 + i}_p0.png`, String(10000 + i));
    for (const id of ["10001", "10002", "10003"]) source(f.c, id);
    f.q.enqueue(["10001", "10002", "10003", "10004", "10005"]);
    const states = ["done", "failed", "unavailable", "waiting", "running"];
    for (let i = 0; i < states.length; i++)
      f.c.db
        .prepare(
          "UPDATE jobs SET status=?,attempts=7,next_run_at=9999999999999,last_error='old',priority=9 WHERE artwork_id=?",
        )
        .run(states[i], String(10001 + i));
    const missing = f.q.previewScope(f.scope("scope"));
    assert.deepEqual(
      [
        missing.eligibleArtworkCount,
        missing.completedArtworkCount,
        missing.unavailableArtworkCount,
        missing.queuedArtworkCount,
        missing.runningArtworkCount,
      ],
      [2, 1, 1, 1, 1],
    );
    const all = f.q.previewScope(f.scope("scope", true, "all"));
    const result = f.q.enqueueScope(all.scope, all.previewToken);
    assert.deepEqual(
      [result.enqueued, result.requeued, result.queuedArtworkCount],
      [1, 2, 3],
    );
    for (const id of ["10001", "10002"]) {
      const job = f.q.list().find((x) => x.artworkId === id)!;
      assert.deepEqual(
        [job.status, job.attempts, job.nextRunAt, job.lastError, job.priority],
        ["waiting", 0, 0, null, 9],
      );
    }
    assert.equal(
      f.q.list().find((x) => x.artworkId === "10005")!.status,
      "running",
    );
    f.q.retry();
    const unavailable = f.q.list().find((x) => x.artworkId === "10003")!;
    assert.equal(unavailable.status, "unavailable");
    f.q.retry([unavailable.id]);
    assert.deepEqual(
      f.q.list().find((x) => x.id === unavailable.id),
      {
        ...unavailable,
        status: "waiting",
        attempts: 0,
        nextRunAt: 0,
        lastError: null,
      },
    );
  } finally {
    await f.cleanup();
  }
});

test("stale preview and empty start are atomic and cannot resume an unrelated queue", async () => {
  const f = fixture();
  try {
    f.q.enqueue(["99999"]);
    f.file("a", "scope/10001_p0.png", "10001");
    const stale = f.q.previewScope(f.scope("scope"));
    f.file("b", "scope/10002_p0.png", "10002");
    assert.throws(
      () => f.q.enqueueScope(stale.scope, stale.previewToken, true),
      /重新预览/,
    );
    assert.equal(f.q.list().length, 1);
    assert.equal(
      (f.c.db.prepare("SELECT paused FROM source_state").get() as any).paused,
      1,
    );
    const empty = f.q.previewScope(f.scope("empty"));
    assert.throws(
      () => f.q.enqueueScope(empty.scope, empty.previewToken, true),
      /没有可开始/,
    );
    assert.equal(
      (f.c.db.prepare("SELECT paused FROM source_state").get() as any).paused,
      1,
    );
    const p = f.q.previewScope(f.scope("scope"));
    f.q.enqueue(["10001"]);
    assert.throws(() => f.q.enqueueScope(p.scope, p.previewToken), /重新预览/);
    assert.equal(f.q.list().length, 2);
  } finally {
    await f.cleanup();
  }
});

test("batch default pause is durable and explicit start preserves source cooldown", async () => {
  const f = fixture();
  let calls = 0;
  try {
    await f.q.close();
    let q = new PixivQueue(f.c, {
      fetcher: async () => {
        calls++;
        return new Response("", { status: 404 });
      },
      intervalMs: 60000,
    });
    f.file("a", "scope/10001_p0.png", "10001");
    q.resume();
    const cooldown = Date.now() + 120000;
    f.c.db.prepare("UPDATE source_state SET pause_until=?").run(cooldown);
    const p = q.previewScope(f.scope("scope"));
    assert.equal(q.enqueueScope(p.scope, p.previewToken).paused, true);
    assert.equal(await q.tick(), false);
    await q.close();
    q = new PixivQueue(f.c, {
      fetcher: async () => {
        calls++;
        return new Response("", { status: 404 });
      },
      intervalMs: 60000,
    });
    q.start();
    assert.equal(await q.tick(), false);
    const queued = q.previewScope(f.scope("scope"));
    assert.equal(queued.queuedArtworkCount, 1);
    assert.equal(
      q.enqueueScope(queued.scope, queued.previewToken, true).paused,
      false,
    );
    assert.equal(
      (f.c.db.prepare("SELECT pause_until FROM source_state").get() as any)
        .pause_until,
      cooldown,
    );
    assert.equal(await q.tick(), false);
    assert.equal(calls, 0);
    f.c.db.prepare("UPDATE source_state SET pause_until=0").run();
    await q.tick();
    assert.equal(calls, 1);
    assert.equal(q.list()[0].status, "unavailable");
    assert.equal(await q.tick(), false);
    const terminal = q.previewScope(f.scope("scope", true, "all"));
    assert.equal(terminal.eligibleArtworkCount, 0);
    assert.equal(terminal.unavailableArtworkCount, 1);
    await q.close();
  } finally {
    await f.cleanup();
  }
});

test("shared source refresh changes both directories without overwriting manual annotations", async () => {
  const f = fixture();
  try {
    f.file("a", "selected/10001_p0.png", "10001");
    f.file("b", "outside/10001_p1.png", "10001", 1);
    source(f.c, "10001");
    const sourceTag = f.c.tags()[0].id;
    const manual = f.c.createTag("manual", "style");
    f.c.overrideTags(["a"], [sourceTag], "exclude");
    f.c.overrideTags(["a"], [manual], "add");
    f.c.setFavorite(["a"], true);
    f.c.setRating(["a"], 5);
    const collection = f.c.createCollection("Fixture", "normal");
    f.c.collectionItems(collection, ["a"]);
    await f.q.close();
    const q = new PixivQueue(f.c, {
      intervalMs: 60000,
      fetcher: async () =>
        Response.json({
          error: false,
          body: {
            illustId: "10001",
            illustTitle: "refreshed",
            userId: "1",
            userName: "Fixture",
            pageCount: 2,
            tags: { tags: [{ tag: "source_tag" }, { tag: "new_source_tag" }] },
          },
        }),
    });
    try {
      const p = q.previewScope(f.scope("selected", true, "all"));
      assert.deepEqual(
        [p.fileCount, p.artworkCount, p.eligibleFileCount],
        [1, 1, 1],
      );
      q.enqueueScope(p.scope, p.previewToken, true);
      await q.tick();
      assert.equal(q.list().length, 1);
      assert.equal(q.list()[0].status, "done");
      assert.equal(f.c.query({ filter: { text: "refreshed" } }).total, 2);
      assert.equal(
        f.c.query({ filter: { tags: [{ ids: [sourceTag] }] } }).items[0].id,
        "b",
      );
      assert.equal(
        f.c.query({
          filter: {
            tags: [{ ids: [manual] }],
            favorite: true,
            ratingMin: 5,
            collectionId: collection,
          },
        }).items[0].id,
        "a",
      );
    } finally {
      await q.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nested data directory and aliased root are excluded without per-image filesystem reads", async () => {
  const f = fixture(true);
  try {
    f.file("a", "images/10001_p0.png", "10001");
    f.file("cache", ".image-finder/thumbnails/10002_p0.png", "10002");
    assert.equal(f.q.previewScope(f.scope()).fileCount, 1);
    assert.throws(
      () => f.q.previewScope(f.scope(".image-finder/thumbnails")),
      /数据目录/,
    );
    const alias = path.join(f.dir, "alias");
    symlinkSync(
      f.original,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    f.c.db.prepare("UPDATE roots SET path=? WHERE id=?").run(alias, f.root.id);
    assert.equal(f.q.previewScope(f.scope()).fileCount, 1);
    assert.throws(() => f.q.previewScope(f.scope(".image-finder")), /数据目录/);
  } finally {
    await f.cleanup();
  }
});

test("batch IPC only accepts registered root scope, normalized relative directory, exact mode and preview token", () => {
  const scope = {
    rootId: "root",
    relativePath: "",
    recursive: true,
    mode: "missing_or_failed",
  };
  validateInvocation("jobs.scopePreview", scope);
  validateInvocation("jobs.enqueueScope", {
    ...scope,
    previewToken: "a".repeat(64),
  });
  for (const input of [
    { ...scope, relativePath: "../outside" },
    { ...scope, relativePath: "C:\\outside" },
    { ...scope, recursive: "true" },
    { ...scope, mode: "failed" },
    { ...scope, rootPath: "C:/" },
    { rootId: "root", relativePath: "", recursive: true },
  ])
    assert.throws(() => validateInvocation("jobs.scopePreview", input));
  assert.throws(() =>
    validateInvocation("jobs.enqueueScope", {
      ...scope,
      previewToken: "bad",
      start: true,
    }),
  );
});

test("persisted worker scope isolates preexisting global pending jobs and reports exhaustion", async () => {
  const f = fixture();
  try {
    f.file("inside", "12\\10001.jpg", "10001");
    f.file("nested", "12/sub/10002.jpg", "10002");
    f.file("outside", "123/10003.jpg", "10003");
    f.q.enqueue(["10003", "10001", "10002"]);
    f.q.setRunScope(f.scope("12"));
    const calls: string[] = [];
    (f.q as any).options.fetcher = async (url: string) => {
      const id = new URL(url).pathname.split("/").at(-1)!; calls.push(id);
      return Response.json({error:false, body:{illustId:id,illustTitle:"test",userId:"1",userName:"test",pageCount:1,tags:{tags:[]}}});
    };
    (f.q as any).options.intervalMs = 0;
    f.q.resume();
    assert.equal(await f.q.tick(), true);
    assert.equal(await f.q.tick(), true);
    assert.equal(await f.q.tick(), false);
    assert.deepEqual(calls.sort(), ["10001", "10002"]);
    assert.equal(f.q.sourceState().scopePending, 0);
    assert.equal(f.q.list().find(j=>j.artworkId==="10003")!.attempts, 0);
    await f.q.close();
    const reopened = new PixivQueue(f.c);
    assert.equal(reopened.runScope()!.relativePath, "12");
    reopened.setRunScope(null);
    assert.equal(reopened.sourceState().paused, 1);
    assert.equal(reopened.scopePending(), 1);
    await reopened.close();
  } finally { await f.cleanup(); }
});
