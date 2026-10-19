import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, copyFile, stat, rename, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalPath, pathWithin } from "./data-path.js";

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export function databaseInventory(db: Database.Database) {
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
  return tables.map(({name,sql}) => {
    const columns = (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {name:string}[]).map(row => row.name);
    const hash = createHash("sha256");
    let rows = 0;
    for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${columns.map(quote).join(",")}`).iterate()) {
      hash.update(JSON.stringify(row) + "\n"); rows++;
    }
    return {name,sql,rows,sha256:hash.digest("hex")};
  });
}
async function hashFile(filename: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
async function ancillaryInventory(directory: string, prefix = ""): Promise<{name:string;bytes:number;sha256:string}[]> {
  const result: {name:string;bytes:number;sha256:string}[] = [];
  for (const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (!prefix && ["catalog.sqlite","catalog.sqlite-wal","catalog.sqlite-shm","catalog.sqlite-journal"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error("图库数据中含链接，需人工确认后迁移：" + name);
    if (entry.isDirectory()) result.push(...await ancillaryInventory(directory,name));
    else if (entry.isFile()) result.push({name,bytes:(await stat(path.join(directory,name))).size,sha256:await hashFile(path.join(directory,name))});
    else throw new Error("图库含不支持的特殊文件：" + name);
  }
  return result.sort((a,b)=>a.name.localeCompare(b.name));
}

/** Offline-only copy. The caller supplies a process guard; it never edits the source. */
export async function migrateLibrary(source: string, destination: string, assertIdle: ()=>Promise<void>) {
  source = await realpath(source);
  destination = path.resolve(destination);
  const actualDestination = canonicalPath(destination);
  if (pathWithin(source,actualDestination) || pathWithin(actualDestination,source)) throw new Error("迁移源和目标不能互相包含");
  await assertIdle();
  try { await stat(destination); throw new Error("目标目录已存在；为避免覆盖，迁移已停止"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(path.dirname(destination),{recursive:true});
  const staging = destination + ".incoming-" + randomUUID();
  await mkdir(staging);
  const original = new Database(path.join(source,"catalog.sqlite"),{readonly:true,fileMustExist:true});
  try {
    if (original.pragma("quick_check",{simple:true}) !== "ok") throw new Error("原数据库完整性检查失败");
    const tables = databaseInventory(original);
    const files = await ancillaryInventory(source);
    await original.backup(path.join(staging,"catalog.sqlite"));
    for (const file of files) {
      const target = path.join(staging,file.name);
      await mkdir(path.dirname(target),{recursive:true});
      await copyFile(path.join(source,file.name),target);
    }
    // Preserve even empty cache/config directories.
    async function emptyDirectories(prefix=""): Promise<void> {
      for (const entry of await readdir(path.join(source,prefix),{withFileTypes:true})) if (entry.isDirectory()) {
        const name = path.join(prefix,entry.name);
        await mkdir(path.join(staging,name),{recursive:true});
        await emptyDirectories(name);
      }
    }
    await emptyDirectories();
    const copied = new Database(path.join(staging,"catalog.sqlite"),{readonly:true,fileMustExist:true});
    try {
      if (copied.pragma("quick_check",{simple:true}) !== "ok" || JSON.stringify(tables)!==JSON.stringify(databaseInventory(copied))) throw new Error("数据库迁移前后内容不一致");
    } finally { copied.close(); }
    const copiedFiles = await ancillaryInventory(staging);
    if (JSON.stringify(files)!==JSON.stringify(copiedFiles)) throw new Error("缓存或配置复制校验失败");
    await assertIdle();
    if (JSON.stringify(tables)!==JSON.stringify(databaseInventory(original)) || JSON.stringify(files)!==JSON.stringify(await ancillaryInventory(source))) throw new Error("复制期间原库发生变化，已停止切换");
    // Windows rename never replaces an existing nonempty destination directory.
    await rename(staging,destination);
    return {source,destination,tables,files,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0)+(await stat(path.join(destination,"catalog.sqlite"))).size,sourceRetained:true};
  } catch (error) {
    if (path.dirname(staging) === path.dirname(destination) && path.basename(staging).startsWith(path.basename(destination)+".incoming-")) await rm(staging,{recursive:true,force:true});
    throw error;
  } finally { original.close(); }
}
