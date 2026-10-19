import type Database from 'better-sqlite3';
import {mkdirSync}from'node:fs';import path from'node:path';import{randomUUID}from'node:crypto';
import{excludedFileSql,excludedDirectorySql}from'./directory-policy.js';
/** All deletions are catalog relations; source files and physical caches are never removed. */
export function removeExcludedDirectoryRecords(db:Database.Database,dataDir:string){
 const where=`${excludedFileSql('f.relative_path')} OR ${excludedDirectorySql('r.path')}`;
 const affected=(db.prepare(`SELECT count(*) n FROM files f JOIN roots r ON r.id=f.root_id WHERE ${where}`).get()as any).n as number;
 if(!affected)return {removed:0,backup:null};
 const folder=path.join(dataDir,'backups');mkdirSync(folder,{recursive:true});const backup=path.join(folder,`before-dot-directories-${Date.now()}-${randomUUID()}.sqlite`);
 // SQLite's consistent main database snapshot includes committed WAL content.
 db.prepare('VACUUM main INTO ?').run(backup);
 db.transaction(()=>{
  db.exec(`CREATE TEMP TABLE excluded_files_to_remove AS SELECT f.id,f.artwork_id FROM files f JOIN roots r ON r.id=f.root_id WHERE ${where}`);
  db.exec('DELETE FROM files WHERE id IN (SELECT id FROM excluded_files_to_remove)');
  const orphans='SELECT DISTINCT x.artwork_id FROM excluded_files_to_remove x WHERE x.artwork_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM files f WHERE f.artwork_id=x.artwork_id OR f.candidate_artwork_id=x.artwork_id)';
  db.exec(`DELETE FROM jobs WHERE artwork_id IN (${orphans});DELETE FROM source_snapshots WHERE artwork_id IN (${orphans});DELETE FROM artworks WHERE id IN (${orphans})`);
  db.exec('DROP TABLE excluded_files_to_remove');
 })();
 return {removed:affected,backup};
}
