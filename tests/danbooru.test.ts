import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Catalog } from "../src/core/catalog.js";
import {
  DanbooruQueue,
  parseDanbooru,
  fileMd5,
  danbooruURL,
  DANBOORU_INTERVAL_MS,
} from "../src/core/danbooru.js";
import { validateInvocation } from "../src/bridge.js";
import { tasksNeedAwake } from "../src/electron/task-power.js";
function reply(md5: string, status = 200) {
  return {
    status,
    body: JSON.stringify([
      {
        id: 77,
        md5,
        pixiv_id: 123,
        tag_string_general: "blue_hair solo",
        tag_string_character: "person_a",
        tag_string_artist: "artist_a",
        tag_string_copyright: "series_a",
        tag_string_meta: "",
      },
    ]),
  };
}
async function fixture(
  request?: (hash: string, signal?: AbortSignal) => Promise<any>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "danbooru-test-"));
  const original = path.join(dir, "original");
  await mkdir(original);
  const c = new Catalog(path.join(dir, "data"));
  const root = c.addRoot(original);
  for (const [id, name] of [
    ["a", "12/a.bin"],
    ["b", "12/sub/b.bin"],
    ["c", "120/c.bin"],
  ]) {
    const dest = path.join(original, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, "identical-image-bytes");
    const s = await stat(dest);
    c.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, root.id, name, s.size, s.mtimeMs, 1);
  }
  const q = new DanbooruQueue(c, { request });
  return {
    c,
    q,
    root,
    dir,
    original,
    async cleanup() {
      await q.close();
      c.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const step = async (q: DanbooruQueue) => {
  (q as any).c.db.prepare("UPDATE danbooru_state SET paused=0").run();
  await (q as any).runOne();
};
test("MD5 response must be unique and exact; Pixiv ID and page never bind", () => {
  const md5 = "a".repeat(32);
  assert.equal(parseDanbooru(reply(md5), md5)?.id, 77);
  assert.throws(
    () => parseDanbooru(reply("b".repeat(32)), md5),
    /invalid_match/,
  );
  assert.throws(() => parseDanbooru({ status: 200, body: "{}" }, md5));
  assert.throws(() =>
    parseDanbooru(
      {
        status: 200,
        body: JSON.stringify([
          JSON.parse(reply(md5).body)[0],
          JSON.parse(reply(md5).body)[0],
        ]),
      },
      md5,
    ),
  );
  assert.equal(parseDanbooru({ status: 200, body: "[]" }, md5), null);
  for (const status of [403, 429])
    assert.throws(
      () => parseDanbooru({ status, body: "" }, md5),
      status === 403 ? /access_restricted/ : /rate_limit/,
    );
  assert.equal(
    danbooruURL(md5),
    `https://danbooru.donmai.us/posts.json?tags=md5%3A${md5}&limit=2`,
  );
  assert.throws(() => danbooruURL("https://evil.invalid"));
  assert.ok(DANBOORU_INTERVAL_MS >= 3000);
});
test("scope boundary, cache reuse, Chinese search, separate sources and durable backup/export", async () => {
  let calls = 0;
  const f = await fixture(async (h) => {
    calls++;
    return reply(h);
  });
  try {
    const { c, q } = f;
    const scope = { rootId: f.root.id, relativePath: "12", recursive: true };
    assert.deepEqual(q.preview(scope), { total: 2, eligible: 2 });
    assert.equal(q.preview({ ...scope, recursive: false }).total, 1);
    assert.throws(() => q.preview({ ...scope, relativePath: "../12" }));
    assert.equal(q.enqueue(scope).added, 2);
    const manual = c.createTag("manual");
    c.overrideTags(["a"], [manual], "add");
    c.db
      .prepare(
        "UPDATE files SET artwork_id='123',page=4,favorite=1,rating=5 WHERE id='a'",
      )
      .run();
    c.db.prepare("INSERT INTO creators VALUES('1','name')").run();
    c.db
      .prepare("INSERT INTO artworks VALUES('123','title','1',6,NULL,?)")
      .run(Date.now());
    const pixiv = c.createTag("pixiv");
    c.db
      .prepare("INSERT INTO artwork_tags VALUES('123',?,'pixiv',NULL)")
      .run(pixiv);
    c.db.prepare("INSERT INTO ai_lexicon VALUES('blue_hair','蓝发')").run();
    const blue = c.createTag("blue_hair");
    c.db
      .prepare("INSERT INTO ai_reviews VALUES('a','blue_hair','accept',?,?)")
      .run(blue, Date.now());
    await step(q);
    await step(q);
    assert.equal(calls, 1);
    assert.equal(
      q.tags("a").find((t) => t.name === "blue_hair")?.displayName,
      "蓝发",
    );
    assert.equal(q.tags("a").length, 5);
    assert.equal(c.query({ filter: { text: "蓝发" }, limit: 20 }).total, 2);
    assert.equal(
      c.query({ filter: { tags: [{ ids: [blue] }] }, limit: 20 }).total,
      2,
    );
    assert.equal(
      c.query({ filter: { excludeTagIds: [blue] }, limit: 20 }).total,
      1,
    );
    assert.equal(c.getFile("a").artworkId, "123");
    assert.equal(c.getFile("a").page, 4);
    assert.equal(c.getFile("a").favorite, true);
    assert.equal(c.getFile("a").rating, 5);
    assert.equal(
      c.detail("a").tags.find((t) => t.id === manual)?.override,
      "add",
    );
    assert.equal(
      c.db.prepare("SELECT count(*) n FROM artwork_tags").get() &&
        c.detail("a").source?.title,
      "title",
    );
    assert.equal(
      (c.db.prepare("SELECT count(*) n FROM ai_reviews").get() as any).n,
      1,
    );
    const backup = path.join(f.dir, "backup.sqlite");
    await c.backup(backup);
    await c.export(path.join(f.dir, "export.json"));
    q.cancel();
    await c.restore(backup);
    assert.equal(q.tags("a").length, 5);
    const blueTag = q.tags("a").find((t) => t.name === "blue_hair");
    assert.ok(blueTag);
    const merge = c.mergeTags(blue, manual);
    assert.equal(
      c.query({ filter: { tags: [{ ids: [manual] }] }, limit: 20 }).total,
      2,
    );
    c.undoTags(merge.undoId);
    assert.equal(
      c.query({ filter: { tags: [{ ids: [blue] }] }, limit: 20 }).total,
      2,
    );
  } finally {
    await f.cleanup();
  }
});
test("403 and 429 pause durably with no automatic retry or network on reopen", async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    const f = await fixture(async () => {
      calls++;
      return { status, body: "" };
    });
    try {
      f.q.enqueueFile("a");
      await step(f.q);
      assert.equal(f.q.status().paused, true);
      assert.equal(
        f.q.status().reason,
        status === 403 ? "access_restricted" : "rate_limit",
      );
      await f.q.close();
      const next = new DanbooruQueue(f.c, {
        request: async () => {
          calls++;
          throw new Error("must not request");
        },
      });
      assert.equal(next.status().paused, true);
      assert.equal(
        next.status().reason,
        status === 403 ? "access_restricted" : "rate_limit",
      );
      await next.close();
      assert.equal(calls, 1);
    } finally {
      await f.cleanup();
    }
  }
});
test("file changed during request rejects tags and preserves previous sources", async () => {
  const f = await fixture(async (h) => {
    await writeFile(
      path.join(f.original, "12/a.bin"),
      "changed-image-bytes-after-request",
    );
    return reply(h);
  });
  try {
    f.q.enqueueFile("a");
    await step(f.q);
    assert.equal(f.q.tags("a").length, 0);
    assert.equal(f.q.list()[0].error, "file_changed");
    assert.equal(f.q.status().paused, true);
  } finally {
    await f.cleanup();
  }
});
test("cancel and close wait for inflight, never commit late response to file or another job", async () => {
  for (const action of ["cancel", "close"]) {
    let release!: (v: any) => void;
    let started!: (hash: string) => void;
    const begin = new Promise<string>((r) => (started = r));
    const f = await fixture((h) => {
      started(h);
      return new Promise((r) => (release = r));
    });
    try {
      f.q.enqueue({ rootId: f.root.id, relativePath: "12", recursive: true });
      f.q.resume();
      const h = await begin;
      let closing: Promise<void> | undefined;
      if (action === "cancel") f.q.cancel();
      else closing = f.q.close();
      release(reply(h));
      if (closing) await closing;
      else await (f.q as any).active;
      assert.equal(f.q.tags("a").length, 0);
      assert.equal(f.q.tags("b").length, 0);
      assert.equal(f.q.status().paused, true);
      assert.equal(
        f.q.list().find((x) => x.fileId === "a")?.status,
        action === "cancel" ? "cancelled" : "waiting",
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("pause-resume respects persisted minimum interval and one concurrent request", async () => {
  let calls = 0;
  const f = await fixture(async (h) => {
    calls++;
    return reply(h);
  });
  try {
    f.q.enqueueFile("a");
    f.c.db
      .prepare("UPDATE danbooru_state SET last_request_at=? WHERE id=1")
      .run(Date.now());
    f.q.resume();
    await new Promise((r) => setTimeout(r, 80));
    f.q.pause();
    f.q.resume();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls, 0);
    assert.equal(f.q.list()[0].status, "waiting");
  } finally {
    await f.cleanup();
  }
});
test("bridge denies unexpected input and sleep guard follows Danbooru queue", () => {
  validateInvocation("danbooru.enqueue", {
    rootId: "r",
    relativePath: "12",
    recursive: true,
  });
  assert.throws(() =>
    validateInvocation("danbooru.enqueue", {
      rootId: "r",
      relativePath: "../x",
      recursive: true,
    }),
  );
  assert.throws(() =>
    validateInvocation("danbooru.enqueueFile", {
      fileId: "f",
      url: "https://evil.invalid",
    }),
  );
  const p = { source: { paused: true, settings: {} }, counts: [] };
  assert.equal(
    tasksNeedAwake({}, p, {}, undefined, {
      paused: false,
      counts: [{ status: "waiting", count: 1 }],
    }),
    true,
  );
  assert.equal(
    tasksNeedAwake({}, p, {}, undefined, {
      paused: true,
      counts: [{ status: "waiting", count: 1 }],
    }),
    false,
  );
});

test("fingerprint changes invalidate old source labels and new jobs become eligible", async () => {
  const f = await fixture(async (h) => reply(h));
  try {
    f.q.enqueueFile("a");
    await step(f.q);
    assert.ok(f.q.tags("a").length);
    f.c.db.prepare("UPDATE files SET mtime_ms=mtime_ms+100 WHERE id='a'").run();
    assert.equal(f.q.tags("a").length, 0);
    assert.equal(
      f.c.query({ filter: { text: "blue_hair" }, limit: 20 }).total,
      0,
    );
    assert.equal(
      f.q.preview({ rootId: f.root.id, relativePath: "12", recursive: false })
        .eligible,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("cancel cannot clear a protected pause and reopen never starts pending jobs", async () => {
  const f = await fixture(async () => ({ status: 429, body: "" }));
  try {
    f.q.enqueueFile("a");
    await step(f.q);
    f.q.cancel();
    assert.equal(f.q.status().reason, "rate_limit");
    await f.q.close();
    const next = new DanbooruQueue(f.c);
    assert.equal(next.status().reason, "rate_limit");
    assert.equal(next.status().paused, true);
    await next.close();
  } finally {
    await f.cleanup();
  }
});
test("network uses only fixed HTTPS hash endpoint, explicit identity, redirect denial and bounded response", async () => {
  const { requestDanbooru, DANBOORU_USER_AGENT } = await import(
    "../src/core/danbooru.js"
  );
  const previous = globalThis.fetch;
  let called = 0;
  try {
    globalThis.fetch = async (input, init) => {
      called++;
      assert.match(
        String(input),
        /^https:\/\/danbooru\.donmai\.us\/posts\.json\?tags=md5%3A[a-f0-9]{32}&limit=2$/,
      );
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as any)["User-Agent"], DANBOORU_USER_AGENT);
      assert.equal(init?.body, undefined);
      assert.equal(init?.credentials, undefined);
      assert.ok(init?.signal);
      return new Response("[]", { status: 200 });
    };
    assert.equal((await requestDanbooru("a".repeat(32))).body, "[]");
    assert.equal(called, 1);
    await assert.rejects(requestDanbooru("https://evil.invalid"));
    assert.equal(called, 1);
    globalThis.fetch = async () =>
      new Response("x".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(requestDanbooru("a".repeat(32)), /TOO_LARGE/);
    globalThis.fetch = async () =>
      new Response("secret-challenge-page", { status: 403 });
    assert.deepEqual(await requestDanbooru("a".repeat(32)), {
      status: 403,
      body: "",
    });
  } finally {
    globalThis.fetch = previous;
  }
});

test("WD and Danbooru use one exact English tag identity, distinct evidence, distinct translation collisions and manual exclusion", async () => {
  const { LocalAi } = await import("../src/core/ai.js");
  const f = await fixture(async (h) => reply(h));
  const ai = new LocalAi(f.c);
  try {
    const db = f.c.db;
    db.prepare(
      "INSERT OR REPLACE INTO ai_lexicon VALUES('blue_hair','蓝发')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO ai_lexicon VALUES('person_a','同名译文')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO ai_lexicon VALUES('series_a','同名译文')",
    ).run();
    db.prepare(
      "INSERT INTO ai_candidates(file_id,tag,category,score) VALUES('a','blue_hair','general',0.92)",
    ).run();
    db.prepare(
      "INSERT INTO ai_candidates(file_id,tag,category,score) VALUES('b','blue_hair','general',0.75)",
    ).run();
    ai.review({ fileIds: ["a"], tag: "blue_hair", action: "accept" });
    const original = (
      db.prepare("SELECT tag_id FROM ai_reviews WHERE file_id='a'").get() as any
    ).tag_id;
    const spaced = f.c.createTag("blue hair");
    assert.notEqual(spaced, original);
    f.q.enqueueFile("a");
    f.q.enqueueFile("b");
    await step(f.q);
    await step(f.q);
    const ids = db
      .prepare(
        "SELECT DISTINCT tag_id FROM danbooru_tags WHERE raw_name='blue_hair'",
      )
      .all() as any[];
    assert.deepEqual(
      ids.map((x) => x.tag_id),
      [original],
    );
    assert.equal(f.c.tags("blue_hair")[0].usageCount, 2);
    assert.equal(f.c.tags("蓝发")[0].id, original);
    assert.equal(
      (
        db
          .prepare(
            "SELECT score FROM ai_candidates WHERE file_id='a' AND tag='blue_hair'",
          )
          .get() as any
      ).score,
      0.92,
    );
    assert.equal(
      (
        db
          .prepare("SELECT action FROM ai_reviews WHERE file_id='a'")
          .get() as any
      ).action,
      "accept",
    );
    assert.equal(
      db.prepare("SELECT 1 FROM ai_reviews WHERE file_id='b'").get(),
      undefined,
    );
    const same = db
      .prepare(
        "SELECT DISTINCT tag_id FROM danbooru_tags WHERE raw_name IN ('person_a','series_a')",
      )
      .all();
    assert.equal(same.length, 2);
    assert.equal(
      f.c.query({ filter: { text: "同名译文" }, limit: 20 }).total,
      2,
    );
    f.c.overrideTags(["a"], [original], "exclude");
    assert.equal(
      f.c.query({ filter: { tags: [{ ids: [original] }] }, limit: 20 }).total,
      1,
    );
    assert.equal(f.c.tags("blue_hair")[0].usageCount, 1);
    assert.equal(f.q.tags("a").filter((x) => x.name === "blue_hair").length, 1);
    assert.equal(
      (
        db
          .prepare("SELECT action FROM ai_reviews WHERE file_id='a'")
          .get() as any
      ).action,
      "accept",
    );
  } finally {
    await ai.close();
    await f.cleanup();
  }
});

test("invalid MD5 response protective reason survives shutdown and restart without retry", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return reply("f".repeat(32));
  });
  try {
    f.q.enqueueFile("a");
    await step(f.q);
    assert.equal(f.q.status().reason, "ambiguous_or_invalid_match");
    await f.q.close();
    const next = new DanbooruQueue(f.c);
    assert.equal(next.status().reason, "ambiguous_or_invalid_match");
    assert.equal(next.status().paused, true);
    assert.equal(calls, 1);
    assert.equal(next.list()[0].status, "error");
    await next.close();
  } finally {
    await f.cleanup();
  }
});

test("explicit banned/deleted with hidden MD5 are typed unavailable; conflicting hashes and ambiguous rows remain protective", () => {
  const hash = "a".repeat(32);
  const response = (p: any) => ({ status: 200, body: JSON.stringify([p]) });
  for (const flag of ["is_banned", "is_deleted"])
    for (const md5 of [undefined, null, "", hash]) {
      const p: any = { id: 10657036, [flag]: true };
      if (md5 !== undefined) p.md5 = md5;
      const result = parseDanbooru(response(p), hash);
      assert.deepEqual(result, {
        kind: "unavailable",
        id: 10657036,
        reason: flag === "is_banned" ? "post_banned" : "post_deleted",
      });
    }
  for (const p of [
    { id: 1, is_banned: true, md5: "b".repeat(32) },
    { id: 0, is_banned: true },
    { id: "1", is_deleted: true },
    { id: 1 },
    { id: 1, md5: null },
    { id: 1, is_banned: "true", md5: hash },
  ])
    assert.throws(() => parseDanbooru(response(p), hash));
  assert.throws(() =>
    parseDanbooru(
      {
        status: 200,
        body: JSON.stringify([
          { id: 1, is_banned: true },
          { id: 2, is_deleted: true },
        ]),
      },
      hash,
    ),
  );
});
test("unavailable is terminal, records post and reason without tags/binding, caches duplicates and lets next jobs continue", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return {
      status: 200,
      body: JSON.stringify([
        { id: 10657036, is_banned: true, is_deleted: false },
      ]),
    };
  });
  try {
    f.q.enqueue({ rootId: f.root.id, relativePath: "12", recursive: true });
    await step(f.q);
    assert.equal(f.q.status().paused, false);
    await step(f.q);
    assert.equal(calls, 1);
    assert.equal(f.q.tags("a").length, 0);
    assert.equal(f.q.tags("b").length, 0);
    assert.equal(f.c.getFile("a").artworkId, null);
    for (const row of f.q.list()) {
      assert.equal(row.status, "unavailable");
      assert.equal(row.postId, 10657036);
      assert.equal(row.error, "post_banned");
      assert.equal(row.matchedBy, null);
    }
    assert.deepEqual(f.q.status().counts, [
      { status: "unavailable", count: 2 },
    ]);
    assert.equal(
      f.q.preview({ rootId: f.root.id, relativePath: "12", recursive: true })
        .eligible,
      0,
    );
    const cache = JSON.parse(
      (f.c.db.prepare("SELECT post_json FROM danbooru_cache").get() as any)
        .post_json,
    );
    assert.equal(cache.kind, "unavailable");
  } finally {
    await f.cleanup();
  }
});
test("legacy matched/null cache and typed unavailable decode without another request; malformed caches reject", async () => {
  const { decodeDanbooruCache } = await import("../src/core/danbooru.js");
  const hash = "a".repeat(32);
  const legacy = {
    id: 77,
    md5: hash,
    tags: [{ name: "solo", category: "general" }],
  };
  assert.deepEqual(decodeDanbooruCache(JSON.stringify(legacy), hash), legacy);
  assert.equal(decodeDanbooruCache("null", hash), null);
  assert.deepEqual(
    decodeDanbooruCache(
      '{"kind":"unavailable","id":77,"reason":"post_deleted"}',
      hash,
    ),
    { kind: "unavailable", id: 77, reason: "post_deleted" },
  );
  assert.throws(() =>
    decodeDanbooruCache(
      '{"kind":"unavailable","id":0,"reason":"unknown"}',
      hash,
    ),
  );
  const f = await fixture(async () => {
    throw new Error("cache must prevent network");
  });
  try {
    const actual = await fileMd5(path.join(f.original, "12/a.bin"));
    f.c.db
      .prepare("INSERT INTO danbooru_cache VALUES(?,?,?)")
      .run(actual, JSON.stringify({ ...legacy, md5: actual }), Date.now());
    f.q.enqueueFile("a");
    await step(f.q);
    assert.equal(f.q.list()[0].status, "done");
    assert.equal(f.q.tags("a").length, 1);
    f.c.db.prepare("UPDATE danbooru_cache SET post_json=?").run("null");
    f.q.enqueueFile("b");
    await step(f.q);
    assert.equal(f.q.list().find((r) => r.fileId === "b")!.status, "no_match");
  } finally {
    await f.cleanup();
  }
});

test("resume naturally retries an existing error once, then classifies banned response unavailable without stopping remaining work", async () => {
  let calls = 0;
  const f = await fixture(async (h) => {
    calls++;
    return calls === 1
      ? reply("f".repeat(32))
      : { status: 200, body: '[{"id":10657036,"is_banned":true}]' };
  });
  try {
    f.q.enqueueFile("a");
    await step(f.q);
    assert.equal(f.q.list()[0].status, "error");
    f.c.db.prepare("UPDATE danbooru_state SET last_request_at=0").run();
    f.q.resume();
    await (f.q as any).active;
    assert.equal(calls, 2);
    assert.equal(f.q.list()[0].status, "unavailable");
    assert.equal(f.q.status().paused, false);
    f.q.pause();
    f.q.enqueueFile("b");
    await step(f.q);
    assert.equal(
      f.q.list().find((r) => r.fileId === "b")!.status,
      "unavailable",
    );
    assert.equal(calls, 2);
  } finally {
    await f.cleanup();
  }
});

test('cancelled Danbooru request retains a late 403 protection without importing tags',async()=>{
 let release!:(v:any)=>void,started!:()=>void;const began=new Promise<void>(r=>started=r);const f=await fixture(()=>{started();return new Promise(r=>release=r);});try{f.q.enqueue({rootId:f.root.id,relativePath:'12',recursive:true});f.q.resume();await began;const cancellation=f.q.cancel();release({status:403,body:''});assert.equal((await cancellation).cancelled,2);assert.equal(f.q.status().reason,'access_restricted');assert.equal(f.q.tags('a').length,0);assert.ok(f.q.list().every(j=>j.status==='cancelled'));}finally{await f.cleanup();}
});
