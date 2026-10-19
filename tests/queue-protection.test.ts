import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/core/catalog.js';
import { PixivQueue } from '../src/core/queue.js';

test('200 attempt budget survives restart and ordinary retry/resume; explicit next batch is required', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-budget-'));
  let c = new Catalog(dir), calls = 0;
  const options = { intervalMs: 0, jitterMs: 0, fetcher: async () => { calls++; return new Response('', {status:404}); } };
  let q = new PixivQueue(c, options);
  q.configure({...q.settings(),batchLimit:200,autoRest:false});
  q.enqueue(Array.from({length:202}, (_,i)=>String(10000+i))); q.resume();
  for (let i=0;i<201;i++) await q.tick();
  assert.equal(calls,200); assert.equal(q.sourceState().paused,1); assert.equal(q.sourceState().batch_used,200);
  q.retry([q.list()[0].id]); assert.throws(()=>q.resume(), /额度/);
  await q.close(); c.close(); c = new Catalog(dir); q = new PixivQueue(c,options);
  q.start(); assert.equal(await q.tick(),false); assert.equal(q.sourceState().batch_used,200);
  q.resume(true); await q.tick(); assert.equal(calls,201); assert.equal(q.sourceState().batch_used,1);
  q.pause(); q.resume(); assert.equal(q.sourceState().batch_used,1);
  await q.close(); c.close(); rmSync(dir,{recursive:true});
});

for (const status of [401,403,200]) test(`HTTP ${status} login/access/HTML stops the whole queue`, async () => {
  const dir = mkdtempSync(join(tmpdir(),'queue-stop-')), c = new Catalog(dir); let calls=0;
  const q = new PixivQueue(c,{intervalMs:0,jitterMs:0,fetcher:async()=>{calls++; return new Response('<html>verify login</html>',{status});}});
  q.enqueue(['12345','12346']); q.resume(); await q.tick(); await q.tick();
  assert.equal(calls,1); assert.equal(q.sourceState().paused,1); assert.equal(q.sourceState().batch_used,1);
  assert.equal(q.listPage({statuses:['waiting']}).total,1);
  q.retry(); assert.equal(q.sourceState().paused,1);
  await q.close(); c.close(); rmSync(dir,{recursive:true});
});

test('429 cooling honours longer Retry-After and cannot be bypassed by resume/retry',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'queue-cool-')), c=new Catalog(dir); let calls=0;
  const q=new PixivQueue(c,{jitterMs:0,fetcher:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'1800'}});}});
  q.enqueue(['12345','12346']);q.resume();const before=Date.now();await q.tick();
  assert.ok(q.sourceState().pause_until>=before+1800000); q.pause();q.retry();q.resume(true);await q.tick();assert.equal(calls,1);
  await q.close();c.close();rmSync(dir,{recursive:true});
});

test('normal request cadence also protects failures and prefix paging remains bounded',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'queue-page-')),c=new Catalog(dir);let calls=0;
  const q=new PixivQueue(c,{fetcher:async()=>{calls++;return new Response('',{status:404});}});
  q.enqueue(Array.from({length:50000},(_,i)=>String(100000+i)));
  const start=performance.now();const page=q.listPage({artworkId:'10000',limit:3,offset:3});
  assert.equal(page.total,10);assert.equal(page.allTotal,50000);assert.equal(page.items.length,3);
  assert.ok(page.items.every(x=>x.artworkId.startsWith('10000')));assert.ok(performance.now()-start<3000);
  q.resume();await q.tick();await q.tick();assert.equal(calls,1);assert.ok(q.sourceState().pause_until>Date.now());
  await q.close();c.close();rmSync(dir,{recursive:true});
});
