import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/core/catalog.js";
import { PixivQueue } from "../src/core/queue.js";
const body = (id = "12345") => ({
  error: false,
  body: {
    illustId: id,
    illustTitle: "title",
    userId: "1",
    userName: "author",
    pageCount: 2,
    tags: { tags: [{ tag: "tag" }] },
  },
});
test("deduplicated artwork queue commits in-flight work on close and restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  let c = new Catalog(dir);
  let release!: (r: Response) => void;
  const q = new PixivQueue(c, {
    fetcher: () => new Promise((r) => (release = r)),
  });
  assert.equal(q.enqueue(["12345", "12345"]), 1);
  q.resume();
  const tick = q.tick();
  q.pause();
  const closing = q.close();
  release(Response.json(body()));
  await tick;
  await closing;
  assert.equal(q.list()[0].status, "done");
  assert.equal(
    (c.db.prepare("SELECT count(*) n FROM artwork_tags").get() as any).n,
    1,
  );
  c.close();
  c = new Catalog(dir);
  const next = new PixivQueue(c);
  assert.equal(next.list()[0].status, "done");
  assert.equal(await next.tick(), false);
  await next.close();
  c.close();
  rmSync(dir, { recursive: true });
});
test("429 persists source Retry-After and invalid ID never commits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const c = new Catalog(dir);
  const q = new PixivQueue(c, {
    fetcher: async () =>
      new Response("", { status: 429, headers: { "retry-after": "120" } }),
    jitterMs: 0,
  });
  q.enqueue(["12345"]);
  const before = Date.now();
  q.resume();
  await q.tick();
  assert.equal(q.list()[0].status, "retry_wait");
  assert.ok(q.list()[0].nextRunAt >= before + 120000);
  await q.close();
  const q2 = new PixivQueue(c, {
    fetcher: async () => Response.json(body("99999")),
  });
  assert.equal(await q2.tick(), false);
  q2.resume();
  assert.equal(await q2.tick(), false);
  c.db.prepare("UPDATE source_state SET pause_until=0").run();
  c.db.prepare("UPDATE jobs SET next_run_at=0").run();
  await q2.tick();
  assert.equal(q2.list()[0].status, "failed");
  assert.equal(
    (c.db.prepare("SELECT count(*) n FROM artworks").get() as any).n,
    0,
  );
  await q2.close();
  c.close();
  rmSync(dir, { recursive: true });
});

test("running recovery and persisted user pause prevent accidental source requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  let c = new Catalog(dir);
  let calls = 0;
  let q = new PixivQueue(c, {
    fetcher: async () => {
      calls++;
      return Response.json(body());
    },
  });
  q.enqueue(["12345"]);
  c.db.prepare("UPDATE jobs SET status='running'").run();
  q.pause();
  await q.close();
  c.close();
  c = new Catalog(dir);
  q = new PixivQueue(c, {
    fetcher: async () => {
      calls++;
      return Response.json(body());
    },
  });
  assert.equal(q.list()[0].status, "waiting");
  assert.equal(await q.tick(), false);
  assert.equal(calls, 0);
  q.resume();
  await q.tick();
  assert.equal(calls, 1);
  await q.close();
  c.close();
  rmSync(dir, { recursive: true });
});

test("authorized queue scheduling resumes after restart while a fresh queue remains idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  let c = new Catalog(dir);
  let calls = 0;
  const options = {
    fetcher: async () => {
      calls++;
      return Response.json(body());
    },
    intervalMs: 5,
    jitterMs: 0,
  };
  let q = new PixivQueue(c, options);
  q.enqueue(["12345"]);
  q.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 0);
  q.resume();
  await q.close();
  c.close();
  c = new Catalog(dir);
  q = new PixivQueue(c, options);
  q.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1);
  assert.equal(q.list()[0].status, "done");
  await q.close();
  c.close();
  rmSync(dir, { recursive: true });
});
test("queue pages and counts are bounded and duplicate enqueue raises only pending priority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const c = new Catalog(dir);
  const q = new PixivQueue(c);
  q.enqueue(Array.from({ length: 210 }, (_, i) => String(10000 + i)));
  assert.equal(q.list().length, 100);
  const page = q.listPage({ offset: 100, limit: 25, statuses: ["waiting"] });
  assert.equal(page.items.length, 25);
  assert.equal(page.total, 210);
  assert.equal(page.counts.waiting, 210);
  assert.equal(q.enqueue(["10000"], 8), 0);
  assert.equal(q.list()[0].artworkId, "10000");
  c.db.prepare("UPDATE jobs SET status='done' WHERE artwork_id='10000'").run();
  q.enqueue(["10000"], 99);
  assert.equal(q.listPage({ statuses: ["done"] }).items[0].priority, 8);
  await q.close();
  c.close();
  rmSync(dir, { recursive: true });
});

test('cancelled Pixiv flight cannot publish source results and preserves budget, saved scope and protection',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cancel-pixiv-'));const c=new Catalog(dir);let release!:(r:Response)=>void;const q=new PixivQueue(c,{fetcher:()=>new Promise(r=>release=r)});
 try{q.enqueue(['12345','23456']);q.resume();const flight=q.tick();c.db.prepare("UPDATE source_state SET reason='rate_limit',paused=1,rest_until=9999999999999 WHERE source='pixiv'").run();const before=q.sourceState();const cancellation=q.cancel();release(Response.json(body()));assert.equal((await cancellation).cancelled,2);await flight;assert.ok(q.list().every(j=>j.status==='cancelled'));assert.equal((c.db.prepare('SELECT count(*) n FROM artworks').get() as any).n,0);assert.equal(q.sourceState().batch_used,before.batch_used);assert.equal(q.sourceState().rest_until,before.rest_until);assert.equal(q.sourceState().reason,'rate_limit');assert.equal(q.enqueue(['34567']),1);assert.equal(q.enqueue(['12345']),0);assert.equal(q.enqueue(['12345'],0,true),1);assert.equal(q.sourceState().reason,'rate_limit');}finally{await q.close();c.close();rmSync(dir,{recursive:true});}
});
test('rate limit received by a cancelled Pixiv flight remains protected without changing cancelled jobs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cancel-pixiv-429-'));const c=new Catalog(dir);let release!:(r:Response)=>void;const q=new PixivQueue(c,{fetcher:()=>new Promise(r=>release=r)});
 try{q.enqueue(['12345']);q.resume();const flight=q.tick();const cancellation=q.cancel();release(new Response('',{status:429,headers:{'retry-after':'60'}}));await cancellation;await flight;assert.equal(q.sourceState().reason,'rate_limit');assert.ok(q.sourceState().pause_until>Date.now());assert.equal(q.list()[0].status,'cancelled');}finally{await q.close();c.close();rmSync(dir,{recursive:true});}
});
