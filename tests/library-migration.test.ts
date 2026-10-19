import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Catalog } from "../src/core/catalog.js";
import { Scanner } from "../src/core/filesystem.js";
import { directories } from "../src/core/directories.js";
import { ImageProcessor } from "../src/core/images.js";
import { LocalTasks } from "../src/core/local-tasks.js";
import { migrateLibrary,databaseInventory } from "../src/core/library-migration.js";
import { isDataPath } from "../src/core/data-path.js";

test("offline migration preserves WAL committed rows, every table, blobs, cache and metadata; refuses occupied destinations and active apps",async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),"finder-migrate-"));
  const source=path.join(base,"old"),destination=path.join(base,"originals",".image-finder");
  await mkdir(path.join(source,"thumbnails"),{recursive:true});
  const db=new Database(path.join(source,"catalog.sqlite"));
  db.pragma("journal_mode=WAL");
  db.exec("CREATE TABLE annotations(id TEXT PRIMARY KEY,favorite INTEGER,rating INTEGER,review TEXT,queue TEXT,embedding BLOB);INSERT INTO annotations VALUES('x',1,5,'exclude','paused',x'0102');");
  await writeFile(path.join(source,"thumbnails","缓存.webp"),"cached");
  await writeFile(path.join(source,"network.json"),'{"mode":"system"}');
  const before=databaseInventory(db);
  try {
    await assert.rejects(migrateLibrary(source,destination,async()=>{throw new Error("active app");}),/active app/);
    const result=await migrateLibrary(source,destination,async()=>{});
    assert.equal(result.sourceRetained,true);
    const migrated=new Database(path.join(destination,"catalog.sqlite"),{readonly:true});
    try { assert.deepEqual(databaseInventory(migrated),before); } finally { migrated.close(); }
    assert.equal(await readFile(path.join(destination,"thumbnails","缓存.webp"),"utf8"),"cached");
    assert.deepEqual(databaseInventory(db),before);
    await assert.rejects(migrateLibrary(source,destination,async()=>{}),/目标目录已存在/);
    let checks=0;
    await assert.rejects(migrateLibrary(source,path.join(base,"changed"),async()=>{ if(++checks===2) db.exec("UPDATE annotations SET rating=3"); }),/原库发生变化/);
  } finally {db.close();await rm(base,{recursive:true,force:true});}
});

test("source containing arbitrarily named dataDir excludes cache in scans/tree/watch, allows prefix sibling and canonical alias",async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),"finder-exclusion-"));
  const source=path.join(base,"originals"), data=path.join(source,"任意 数据"),normal=path.join(source,"任意 数据2");
  await mkdir(path.join(data,"thumbnails"),{recursive:true});await mkdir(normal);
  await writeFile(path.join(source,"123456_p0.jpg"),"original");
  await writeFile(path.join(normal,"123456_p1.jpg"),"original2");
  await writeFile(path.join(data,"thumbnails","999999_p0.webp"),"cache");
  const c=new Catalog(data),scanner=new Scanner(c);
  let tasks:LocalTasks|undefined;
  try {
    const root=c.addRoot(source);
    assert.throws(()=>c.addRoot(data),/SOURCE_DATA_OVERLAP/);
    assert.throws(()=>c.addRoot(path.join(data,"thumbnails")),/SOURCE_DATA_OVERLAP/);
    assert.equal((await scanner.scan(root.id)).discovered,2);
    assert.deepEqual((await directories(c,root.id)).items.map(x=>x.name),["任意 数据2"]);
    await assert.rejects(directories(c,root.id,"任意 数据/thumbnails"),/INVALID_DIRECTORY_SCOPE/);
    const alias=path.join(base,"alias");await symlink(data,alias,"junction");
    assert.equal(isDataPath(data,path.join(alias,"thumbnails","future.webp")),true);
    assert.equal(isDataPath(data,normal),false);
    tasks=new LocalTasks(c,scanner,new ImageProcessor(c,data));
    await tasks.start();
    for(let i=0;i<100&&(tasks.status().running||tasks.status().pendingRoots.length);i++) await delay(20);
    assert.equal(tasks.status().running,false);
    const discovered=tasks.status().discovered;
    await writeFile(path.join(data,"thumbnails","new.webp"),"new cache");
    c.db.prepare("UPDATE files SET favorite=1").run();
    await delay(1100);
    assert.equal(tasks.status().discovered,discovered,"cache and WAL writes must not schedule a scan");
    await writeFile(path.join(source,"123456_p2.jpg"),"new original");
    for(let i=0;i<100&&c.query().total!==3;i++) await delay(30);
    assert.equal(c.query().total,3,"normal original changes remain watched");
  } finally {await tasks?.close();c.close();await rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
