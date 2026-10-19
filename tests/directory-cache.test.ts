import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,readdir,copyFile,rm} from "node:fs/promises";
import os from "node:os";import path from "node:path";
import {Catalog} from "../src/core/catalog.js";
import {Scanner} from "../src/core/filesystem.js";
import {ThumbnailCache} from "../src/core/thumbnail-cache.js";
import {hideManagedDataDirectory} from "../src/core/managed-data.js";
import {directories} from "../src/core/directories.js";
import {hasDotDirectory,isExcludedImagePath} from "../src/core/directory-policy.js";
const key="a".repeat(64)+".webp";
async function fixture(){const dir=await mkdtemp(path.join(os.tmpdir(),"finder-dot-cache-"));const c=new Catalog(path.join(dir,"data"));return {dir,c};}
test("dot directory policy preserves dot filenames and rejects nested/canonical dot roots",async()=>{
 const {dir,c}=await fixture();try{const root=path.join(dir,"originals");await mkdir(path.join(root,"normal",".nested"),{recursive:true});await mkdir(path.join(root,".image-finder"));
 for(const file of ["file.name.jpg",".hidden.jpg","normal/ok.png","normal/.nested/no.png",".image-finder/no.webp"])await writeFile(path.join(root,file),"demo");
 const r=c.addRoot(root);await new Scanner(c).scan(r.id);assert.equal(c.query().total,3);assert.deepEqual((await directories(c,r.id)).items.map((x:any)=>x.name),["normal"]);
 assert.throws(()=>c.addRoot(path.join(root,".image-finder")),/EXCLUDED_DIRECTORY/);assert.equal(isExcludedImagePath(".hidden.jpg"),false);assert.equal(isExcludedImagePath("normal/.cache/a.jpg"),true);assert.equal(hasDotDirectory("normal/file.name"),false);
 }finally{c.close();await rm(dir,{recursive:true,force:true});}
});
test("migration backs up then removes only dot file relations, retaining shared artwork/jobs and normal rows",async()=>{
 const {dir,c}=await fixture();const root=path.join(dir,"originals");await mkdir(root);const r=c.addRoot(root);
 c.db.exec("INSERT INTO creators VALUES('creator','demo');INSERT INTO artworks VALUES('123','title','creator',1,NULL,1);INSERT INTO jobs(id,artwork_id,status,updated_at)VALUES('job','123','paused',1)");
 const insert=c.db.prepare("INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,artwork_id)VALUES(?,?,?,1,1,1,'123')");insert.run("normal",r.id,"file.name.jpg");insert.run("dot",r.id,"nested/.cache/image.jpg");
 c.db.exec("INSERT INTO collections VALUES('collection','demo','normal',NULL,1);INSERT INTO collection_items VALUES('collection','dot');INSERT INTO collection_items VALUES('collection','normal')");
 assert.equal(c.query().total,1);assert.equal(c.stats().files,1);assert.equal(c.query({filter:{collectionId:"collection"}}).total,1);c.db.exec("UPDATE files SET format='jpeg'");const normal=c.db.prepare("SELECT * FROM files WHERE id='normal'").get();c.close();const next=new Catalog(path.join(dir,"data"));try{assert.equal(next.directoryMigration.removed,1);assert.ok(next.directoryMigration.backup);assert.deepEqual(next.db.prepare("SELECT * FROM files WHERE id='normal'").get(),normal);assert.equal(next.query().total,1);assert.equal((next.db.prepare("SELECT count(*) n FROM jobs").get()as any).n,1);assert.equal((next.db.prepare("SELECT count(*) n FROM collection_items").get()as any).n,1);assert.deepEqual(next.db.pragma("foreign_key_check"),[]);}finally{next.close();await rm(dir,{recursive:true,force:true});}
});
test("cache copies verified webp, persists fixed preference, preserves unknown files and database keys, and can move again",async()=>{
 const {dir,c}=await fixture();try{await mkdir(c.cacheDirectory);await writeFile(path.join(c.cacheDirectory,key),"thumbnail");await writeFile(path.join(c.cacheDirectory,"unknown.txt"),"keep");const old=c.cacheDirectory;const root=path.join(dir,"originals");await mkdir(root);const r=c.addRoot(root);c.db.prepare("INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,thumbnail_key,feature_version)VALUES('cached',?,'image.jpg',1,1,1,?,'srgb-lab-1')").run(r.id,key);const fileBefore=c.db.prepare("SELECT * FROM files WHERE id='cached'").get();const pref=path.join(dir,"profile","cache.json");const cache=new ThumbnailCache(c,pref);const destination=path.join(dir,".image-finder-cache");const result=await cache.configure(destination,true);assert.equal(result.error,null);assert.equal(result.directory,destination);assert.equal(await readFile(path.join(destination,key),"utf8"),"thumbnail");assert.deepEqual(await readdir(old),["unknown.txt"]);assert.equal(JSON.parse(await readFile(pref,"utf8")).directory,destination);assert.deepEqual(c.db.prepare("SELECT * FROM files WHERE id='cached'").get(),fileBefore);assert.ok(c.isManagedPath(path.join(destination,key)));const parent=path.join(dir,"second");await mkdir(parent);assert.equal((await cache.configure(path.join(parent,".image-finder-cache"),true)).error,null);assert.deepEqual(await readdir(destination),[]);
 }finally{c.close();await rm(dir,{recursive:true,force:true});}
});
test("cache conflicting destination or preference persistence failure retains original pointer/files",async()=>{
 const {dir,c}=await fixture();try{await mkdir(c.cacheDirectory);await writeFile(path.join(c.cacheDirectory,key),"source");const old=c.cacheDirectory,destination=path.join(dir,".image-finder-cache");await mkdir(destination);await writeFile(path.join(destination,key),"different");const cache=new ThumbnailCache(c,path.join(dir,"pref"));assert.match((await cache.configure(destination,true)).error!,/未切换/);assert.equal(c.cacheDirectory,old);assert.equal(await readFile(path.join(old,key),"utf8"),"source");await rm(path.join(destination,key));await mkdir(path.join(dir,"pref"));assert.match((await cache.configure(destination,true)).error!,/未切换/);assert.equal(c.cacheDirectory,old);assert.deepEqual(await readdir(destination),[]);
 }finally{c.close();await rm(dir,{recursive:true,force:true});}
});
test("Hidden attribute targets only managed leaf without recursion",()=>{const calls:any[]=[];const run=((...args:any[])=>{calls.push(args);return {status:0};})as any;for(const leaf of [".image-finder",".image-finder-cache"])assert.equal(hideManagedDataDirectory(path.join("C:\\demo",leaf),"win32",run),null);hideManagedDataDirectory("C:\\demo","win32",run);assert.equal(calls.length,2);for(const call of calls)assert.deepEqual(call[1].slice(0,1),["+H"]);assert.ok(calls.every(c=>c[1].length===2));});
test("failed preference replacement preserves old JSON and file feature keys; offline startup keeps requested location",async()=>{
 const {dir,c}=await fixture();try{await mkdir(c.cacheDirectory);await writeFile(path.join(c.cacheDirectory,key),"source");const source=c.cacheDirectory;const pref=path.join(dir,"profile.json");await writeFile(pref,JSON.stringify({schema:1,directory:source}));
 // A directory at the exact destination makes the atomic replacement fail deterministically.
 const blocked=path.join(dir,"blocked.json");await mkdir(blocked);const cache=new ThumbnailCache(c,blocked);const destination=path.join(dir,".image-finder-cache");const before=c.db.prepare("SELECT thumbnail_key,feature_version FROM files ORDER BY id").all();assert.match((await cache.configure(destination,true)).error!,/未切换/);assert.deepEqual(JSON.parse(await readFile(pref,"utf8")),{schema:1,directory:source});assert.deepEqual(c.db.prepare("SELECT thumbnail_key,feature_version FROM files ORDER BY id").all(),before);
 const missing=path.join(dir,"missing",".image-finder-cache");const state=await cache.configure(missing,false);assert.equal(state.directory,source);assert.equal(state.requestedDirectory,missing);assert.match(state.error!,/未切换/);
 }finally{c.close();await rm(dir,{recursive:true,force:true});}
});
test("cache migration refuses source and destination directory junctions",async()=>{
 const {dir,c}=await fixture();const {symlink}=await import("node:fs/promises");try{const outside=path.join(dir,"outside");await mkdir(outside);await writeFile(path.join(outside,key),"must remain");await symlink(outside,c.cacheDirectory,"junction");const cache=new ThumbnailCache(c);assert.match((await cache.configure(path.join(dir,".image-finder-cache"),false)).error!,/原缓存目录/);assert.equal(await readFile(path.join(outside,key),"utf8"),"must remain");await rm(c.cacheDirectory);await mkdir(c.cacheDirectory);await symlink(outside,path.join(dir,".image-finder-cache"),"junction");assert.match((await cache.configure(path.join(dir,".image-finder-cache"),false)).error!,/链接/);assert.equal(await readFile(path.join(outside,key),"utf8"),"must remain");
 }finally{c.close();await rm(dir,{recursive:true,force:true});}
});
