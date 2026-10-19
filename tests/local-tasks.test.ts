import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Catalog } from "../src/core/catalog.js";
import { Scanner } from "../src/core/filesystem.js";
import { ImageProcessor } from "../src/core/images.js";
import { LocalTasks } from "../src/core/local-tasks.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Local task progress timeout");
    await delay(10);
  }
}
test("local scan/image pause states survive restart, startup reconciles and failed images retry explicitly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-tasks-")),
    source = path.join(dir, "source");
  await mkdir(source);
  const catalog = new Catalog(path.join(dir, "data"));
  let tasks: LocalTasks | undefined;
  try {
    await sharp({
      create: { width: 6, height: 8, channels: 3, background: "#0000ff" },
    })
      .png()
      .toFile(path.join(source, "123456_p0.png"));
    await writeFile(path.join(source, "bad.png"), "broken");
    const age = new Date(Date.now() - 3000);
    for (const name of ["123456_p0.png", "bad.png"])
      await utimes(path.join(source, name), age, age);
    const root = catalog.addRoot(source),
      scanner = new Scanner(catalog),
      images = new ImageProcessor(catalog, path.join(dir, "data"));
    tasks = new LocalTasks(catalog, scanner, images);
    assert.equal(tasks.status().imagesPaused, true);
    tasks.pause("scan");
    await tasks.start({ watch: false });
    assert.equal(tasks.status().pendingRoots.length, 1);
    await tasks.close();
    tasks = new LocalTasks(catalog, scanner, images);
    assert.equal(tasks.status().scanPaused, true);
    await tasks.start({ watch: false });
    tasks.resume("scan");
    await until(() => catalog.query().total === 2 && !tasks!.status().running);
    assert.equal(tasks.status().images.ready, 0);
    assert.equal(tasks.status().discovered, 2);
    tasks.resume("images");
    await until(
      () =>
        tasks!.status().images.ready === 1 &&
        tasks!.status().images.failed === 1 &&
        !tasks!.status().running,
    );
    assert.equal(tasks.status().processed, 1);
    assert.equal(tasks.status().failed, 1);
    tasks.pause("images");
    await tasks.close();
    tasks = new LocalTasks(catalog, scanner, images);
    assert.equal(tasks.status().imagesPaused, true);
    assert.equal(tasks.status().processed, 1);
    assert.equal(tasks.retry().retried, 1);
    assert.equal(tasks.status().images.failed, 0);
    catalog.setFavorite([catalog.query().items[0].id], true);
    sharp.cache(false);
    const trimmed = await images.trimCache(0);
    assert.equal(trimmed.removed, 1);
    assert.equal(trimmed.remainingBytes, 0);
    assert.equal(catalog.query({ filter: { favorite: true } }).total, 1);
    assert.equal(
      (await stat(path.join(source, "123456_p0.png"))).isFile(),
      true,
    );
    const bounded = await tasks.scan(root.id, { limit: 1 });
    assert.equal(bounded.complete, false);
    assert.equal(bounded.discovered, 1);
    const intent = tasks.status();
    await tasks.exclusive(async () => {
      assert.equal(tasks!.status().running, false);
      assert.equal(tasks!.status().scanPaused, intent.scanPaused);
      assert.equal(tasks!.status().imagesPaused, intent.imagesPaused);
    });
    assert.equal(tasks.status().imagesPaused, true);
  } finally {
    await tasks?.close();
    catalog.close();
    sharp.cache(false);
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test('local cancellation drains image work without publishing, persists fingerprints, rebuilds explicitly and cleans removed roots',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cancel-local-'));const source=path.join(dir,'source');await mkdir(source);const c=new Catalog(path.join(dir,'data'));const root=c.addRoot(source);const scanner=new Scanner(c);const images=new ImageProcessor(c,path.join(dir,'data'));let tasks:LocalTasks|undefined;let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
 try{await sharp({create:{width:20,height:20,channels:3,background:'blue'}}).png().toFile(path.join(source,'a.png'));const old=new Date(Date.now()-3000);await utimes(path.join(source,'a.png'),old,old);await scanner.scan(root.id);tasks=new LocalTasks(c,scanner,images);tasks.pause('scan');const original=images.process.bind(images);images.process=async(id,signal)=>{started();await gate;return original(id,signal);};tasks.resume('images');await began;const cancelling=tasks.cancel();release();assert.equal((await cancelling).cancelled,1);assert.equal((c.db.prepare('SELECT count(*) n FROM features').get()as any).n,0);assert.equal(tasks.status().images.pending,0);assert.equal(tasks.status().images.failed,0);await tasks.close();tasks=new LocalTasks(c,scanner,images);tasks.resume('images');await until(()=>!tasks!.status().running);assert.equal(tasks.status().images.ready,0);tasks.pause('images');const retry=tasks.retry();assert.equal(retry.retried,1);assert.equal(tasks.status().images.pending,1);await tasks.cancel();assert.equal((c.db.prepare('SELECT count(*) n FROM local_cancelled_roots').get()as any).n,0,'no queued scan roots are suppressed');const backup=path.join(dir,'cancel.sqlite');await c.backup(backup);await c.restore(backup);assert.equal((c.db.prepare('SELECT count(*) n FROM local_cancelled_images').get()as any).n,1);await tasks.scan(root.id);assert.equal(tasks.status().images.pending,1);await tasks.cancel();c.removeRoot(root.id);assert.equal((c.db.prepare('SELECT count(*) n FROM local_cancelled_images').get()as any).n,0);}finally{release?.();await tasks?.close();c.close();await rm(dir,{recursive:true,force:true});}
});
