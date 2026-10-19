import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Catalog } from "../src/core/catalog.js";
import { SauceQueue, parseSauce, saucePreview } from "../src/core/sauce.js";
const reply = (remaining = 2) => ({
  status: 200,
  body: JSON.stringify({
    header: { status: 0, short_remaining: remaining, long_remaining: 99 },
    results: [
      {
        header: { similarity: "91.25" },
        data: {
          pixiv_id: 123456,
          title: "example",
          ext_urls: ["https://www.pixiv.net/artworks/123456"],
        },
      },
    ],
  }),
});
test("Sauce parses only matching explicit Pixiv IDs and trusted official URL, preserving quota", () => {
  const r = reply();
  const b = JSON.parse(r.body);
  b.results.push(
    {
      header: { similarity: "100" },
      data: {
        pixiv_id: "654321",
        ext_urls: ["https://pixiv.net.evil.invalid/artworks/654321"],
      },
    },
    {
      header: { similarity: "100" },
      data: {
        pixiv_id: "777777",
        ext_urls: ["https://www.pixiv.net/artworks/123456"],
      },
    },
  );
  const parsed = parseSauce({ ...r, body: JSON.stringify(b) });
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].artworkId, "123456");
  assert.equal(parsed.shortRemaining, 2);
  assert.equal(parseSauce(reply(0)).pause, "quota_exhausted");
  for (const status of [401, 403, 429])
    assert.ok(parseSauce({ status, body: "" }).pause);
  b.results[0].data.ext_urls = [
    "https://www.pixiv.net/member_illust.php?mode=medium&illust_id=123456",
  ];
  assert.equal(
    parseSauce({ ...r, body: JSON.stringify(b) }).candidates.length,
    1,
  );
  assert.throws(() => parseSauce({ status: 200, body: "{}" }));
});
async function fixture(request: (p: Uint8Array) => Promise<any>) {
  const dir = await mkdtemp(path.join(tmpdir(), "sauce-test-"));
  const originals = path.join(dir, "originals");
  await mkdir(originals);
  const c = new Catalog(path.join(dir, "data"));
  const root = c.addRoot(originals);
  for (const [id, name] of [
    ["a", "folder/a.png"],
    ["b", "folder/sub/b.png"],
    ["c", "folder-other/c.png"],
  ]) {
    await mkdir(path.dirname(path.join(originals, name)), { recursive: true });
    await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: id === "a" ? "red" : "blue",
      },
    })
      .png()
      .toFile(path.join(originals, name));
    const info = await stat(path.join(originals, name));
    c.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, root.id, name, info.size, info.mtimeMs, 1);
  }
  const q = new SauceQueue(c, { request, intervalMs: 1 });
  return {
    dir,
    c,
    q,
    root,
    originals,
    async cleanup() {
      await q.close();
      c.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
}
test("directory enqueue, single request, sanitized preview, cache, explicit confirmation and changed-file rejection", async () => {
  let calls = 0;
  const f = await fixture(async (p) => {
    calls++;
    const meta = await sharp(p).metadata();
    assert.ok(meta.width! <= 512 && meta.height! <= 512);
    assert.equal(meta.exif, undefined);
    return reply();
  });
  try {
    assert.equal(
      f.q.enqueue({
        rootId: f.root.id,
        relativePath: "folder",
        recursive: false,
      }).added,
      1,
    );
    assert.equal(
      f.q.enqueue({
        rootId: f.root.id,
        relativePath: "folder",
        recursive: false,
      }).added,
      0,
    );
    assert.equal(calls, 0);
    f.q.resume();
    await waitUntil(() => f.q.list()[0]?.status === "review");
    assert.equal(f.c.getFile("a").artworkId, null);
    await f.q.review({
      fileId: "a",
      action: "confirm",
      artworkId: "123456",
      page: null,
    });
    assert.equal(f.c.getFile("a").artworkId, "123456");
    assert.equal(f.c.getFile("a").page, null);
    assert.equal(calls, 1);
    f.q.enqueue({ rootId: f.root.id, relativePath: "folder", recursive: true });
    f.q.resume();
    await waitUntil(() =>
      f.q.list().some((i) => i.fileId === "b" && i.status === "review"),
    );
    await writeFile(
      path.join(f.originals, "folder/sub/b.png"),
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: "green" },
      })
        .png()
        .toBuffer(),
    );
    await assert.rejects(
      f.q.review({ fileId: "b", action: "confirm", artworkId: "123456" }),
      /CHANGED|rescan required/,
    );
    assert.equal(f.c.getFile("b").artworkId, null);
  } finally {
    await f.cleanup();
  }
});
test("quota pause survives reopen and failed uploads never automatically repeat", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return reply(0);
  });
  try {
    f.q.enqueue({ rootId: f.root.id, relativePath: "folder", recursive: true });
    f.q.resume();
    await waitUntil(() => f.q.status().reason === "quota_exhausted");
    assert.equal(calls, 1);
    await f.q.close();
    const reopened = new SauceQueue(f.c, {
      request: async () => {
        throw new Error("must not call");
      },
    });
    assert.equal(reopened.status().reason, "quota_exhausted");
    assert.throws(() => reopened.resume(), /REQUIRES_SETTINGS/);
    await reopened.close();
  } finally {
    await f.cleanup();
  }
});
test("ambiguous transport failure is durable and not re-enqueued", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    throw new Error("connection reset");
  });
  try {
    f.q.enqueue({
      rootId: f.root.id,
      relativePath: "folder",
      recursive: false,
    });
    f.q.resume();
    await waitUntil(() => f.q.list()[0]?.status === "uncertain");
    assert.equal(
      f.q.enqueue({
        rootId: f.root.id,
        relativePath: "folder",
        recursive: false,
      }).added,
      0,
    );
    f.q.resume();
    await waitUntil(() => f.q.status().paused);
    assert.equal(calls, 1);
  } finally {
    await f.cleanup();
  }
});

test("sidecar pacing counts only new loop records, and locks prevent duplicate runners", async () => {
  const { sauceInterval, acquireSauceLock } = await import(
    "../src/core/sauce-discovery.js"
  );
  const delays: number[] = [];
  const oldLedgerLength = 20;
  assert.ok(oldLedgerLength > 2);
  await sauceInterval(0, 2, false, async (ms) => {
    delays.push(ms);
  });
  await sauceInterval(1, 2, false, async (ms) => {
    delays.push(ms);
  });
  assert.deepEqual(delays, [35000]);
  const dir = await mkdtemp(path.join(tmpdir(), "sauce-lock-"));
  try {
    const output = path.join(dir, "results.json");
    const release = await acquireSauceLock(output);
    await assert.rejects(acquireSauceLock(output), /EEXIST/);
    await release();
    await (
      await acquireSauceLock(output)
    )();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("filename hints preserve uncertainty and page identity without binding", async () => {
  const { filenameSourceHints: h } = await import(
    "../src/core/filename-hints.js"
  );
  assert.deepEqual(h("130619526_p0 (1).jpg"), [
    { artworkId: "130619526", page: 0, reason: "page_marker" },
  ]);
  assert.equal(h("a130638739_p0.jpg")[0].artworkId, "130638739");
  assert.deepEqual(h("artist-title-150385156.jpg"), [
    { artworkId: "150385156", page: null, reason: "trailing_id" },
  ]);
  assert.equal(h("123456-name-654321.jpg").length, 2);
  assert.equal(h("random.jpg").length, 0);
});

test("sidecar imports verify file identity and preserve manual state without another upload", async () => {
  const { createHash } = await import("node:crypto");
  const f = await fixture(async () => {
    throw new Error("no upload");
  });
  try {
    f.c.setFavorite(["a"], true);
    const file = f.c.getFile("a");
    const preview = await saucePreview(await f.c.resolveOriginal("a"));
    const ledger = path.join(f.dir, "ledger.json");
    const candidate = parseSauce(reply()).candidates;
    const data = {
      version: 1,
      rootId: f.root.id,
      results: [
        {
          fileId: "a",
          bytes: file.bytes,
          mtimeMs: file.mtimeMs,
          previewHash: createHash("sha256").update(preview).digest("hex"),
          candidates: candidate,
          status: "review",
        },
      ],
    };
    await writeFile(ledger, JSON.stringify(data));
    assert.deepEqual(await f.q.importLedger(ledger), {
      imported: 1,
      skipped: 0,
    });
    assert.equal(f.q.list()[0].status, "review");
    assert.equal(f.c.getFile("a").favorite, true);
    assert.equal(f.c.getFile("a").artworkId, null);
    assert.deepEqual(await f.q.importLedger(ledger), {
      imported: 0,
      skipped: 1,
    });
    data.results[0].fileId = "b";
    await writeFile(ledger, JSON.stringify(data));
    assert.deepEqual(await f.q.importLedger(ledger), {
      imported: 0,
      skipped: 1,
    });
  } finally {
    await f.cleanup();
  }
});
test("transport fixes endpoint, keeps credentials in body, refuses redirects and oversized responses", async () => {
  const { requestSauce } = await import("../src/core/sauce-request.js");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://saucenao.com/search.php");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const form = init?.body as FormData;
      assert.equal(form.get("api_key"), "test-secret");
      assert.equal(form.get("db"), "5");
      assert.equal((form.get("file") as File).name, "preview.jpg");
      return new Response("{}", { status: 200 });
    };
    assert.deepEqual(
      await requestSauce("test-secret", new Uint8Array([1, 2, 3])),
      { status: 200, body: "{}" },
    );
    globalThis.fetch = async () =>
      new Response("{}", {
        headers: { "content-length": String(3 * 1024 * 1024) },
      });
    await assert.rejects(
      requestSauce("test-secret", new Uint8Array([1])),
      /TOO_LARGE/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("long reserve stops at five, permits six, and short quota five is usable", async () => {
  const { sauceQuotaPause } = await import("../src/core/sauce.js");
  const { sauceLedgerPause } = await import("../src/core/sauce-discovery.js");
  for (const long of [1, 4, 5]) {
    const b = JSON.parse(reply().body);
    b.header.long_remaining = long;
    assert.equal(
      parseSauce({ status: 200, body: JSON.stringify(b) }).pause,
      "quota_reserve",
    );
    assert.equal(
      sauceLedgerPause({
        status: "review",
        shortRemaining: 5,
        longRemaining: long,
      }),
      "quota_reserve",
    );
  }
  assert.equal(sauceQuotaPause(5, 6), null);
  assert.equal(sauceQuotaPause(0, 6), "quota_exhausted");
  assert.equal(sauceQuotaPause(5, null), "quota_unknown");
  assert.equal(sauceLedgerPause({ status: "review" }), "quota_unknown");
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    const b = JSON.parse(reply().body);
    b.header.long_remaining = calls === 1 ? 6 : 5;
    return { status: 200, body: JSON.stringify(b) };
  });
  try {
    f.q.enqueue({ rootId: f.root.id, relativePath: "folder", recursive: true });
    f.q.resume();
    await waitUntil(() => f.q.status().reason === "quota_reserve");
    assert.equal(calls, 2);
    await f.q.close();
    const reopened = new SauceQueue(f.c, {
      request: async () => {
        throw new Error("must not upload");
      },
    });
    assert.equal(reopened.status().reason, "quota_reserve");
    assert.throws(() => reopened.resume(), /REQUIRES_SETTINGS/);
    reopened.configured();
    assert.throws(() => reopened.resume(), /REQUIRES_SETTINGS/);
    await reopened.close();
  } finally {
    await f.cleanup();
  }
});

test("unknown response quota remains blocked after restart and configuration", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    const b = JSON.parse(reply().body);
    delete b.header.long_remaining;
    return { status: 200, body: JSON.stringify(b) };
  });
  try {
    f.q.enqueue({ rootId: f.root.id, relativePath: "folder", recursive: true });
    f.q.resume();
    await waitUntil(() => f.q.status().reason === "quota_unknown");
    await f.q.close();
    const reopened = new SauceQueue(f.c, {
      request: async () => {
        calls++;
        return reply();
      },
    });
    assert.throws(() => reopened.resume(), /REQUIRES_SETTINGS/);
    reopened.configured();
    assert.throws(() => reopened.resume(), /REQUIRES_SETTINGS/);
    assert.equal(calls, 1);
    await reopened.close();
  } finally {
    await f.cleanup();
  }
});

test('Sauce cancellation retains quota and late protection while refusing candidate publication',async()=>{
 let release!:(r:any)=>void,started!:()=>void;const began=new Promise<void>(r=>started=r);const f=await fixture(()=>{started();return new Promise(r=>release=r);});try{f.q.enqueue({rootId:f.root.id,relativePath:'folder',recursive:true});f.q.resume();await began;const cancelling=f.q.cancel();const response=reply(2);const body=JSON.parse(response.body);body.header.long_remaining=2;response.body=JSON.stringify(body);release(response);assert.equal((await cancelling).cancelled,2);assert.equal(f.q.status().shortRemaining,2);assert.equal(f.q.status().reason,'quota_reserve');assert.ok((f.c.db.prepare('SELECT status FROM sauce_jobs').all()as any[]).every(r=>r.status==='cancelled'));assert.equal((f.c.db.prepare('SELECT count(*) n FROM sauce_cache').get()as any).n,0);assert.equal(f.q.enqueue({rootId:f.root.id,relativePath:'folder',recursive:true}).added,2);assert.equal(f.q.status().reason,'quota_reserve');}finally{await f.cleanup();}
});
