import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {copyFile,lstat,mkdir,readFile,readdir,rename,rm,writeFile} from "node:fs/promises";
import type {Catalog} from "./catalog.js";
import {canonicalPath,pathWithin} from "./data-path.js";
import {hideManagedDataDirectory} from "./managed-data.js";
const cacheFile=/^[a-f0-9]{64}\.webp$/;
const digest=async(p:string)=>createHash("sha256").update(await readFile(p)).digest("hex");
/** Only thumbnail files move. The profile preference commits before the active pointer changes. */
export class ThumbnailCache {
 private requested:string; private error:string|null=null;
 constructor(private catalog:Catalog,private preferenceFile?:string){this.requested=catalog.cacheDirectory;}
 status(){return {directory:this.catalog.cacheDirectory,requestedDirectory:this.requested,error:this.error};}
 async configure(directory:string,persist:boolean,configurationError?:string){
  this.requested=directory;this.error=null;
  const source=this.catalog.cacheDirectory;const copied:Array<{file:string;hash:string}>=[];
  try{
   if(!path.isAbsolute(directory)||path.basename(directory).toLowerCase()!==".image-finder-cache")throw new Error("缓存位置必须是专用的 .image-finder-cache 子目录");
   try{const sourceInfo=await lstat(source);if(!sourceInfo.isDirectory()||sourceInfo.isSymbolicLink())throw new Error("原缓存目录不能是链接或普通文件");}catch(e:any){if(e.code!=="ENOENT")throw e;}
   const parent=await lstat(path.dirname(directory));if(!parent.isDirectory())throw new Error("缓存父目录不可用");
   await mkdir(directory,{recursive:true});
   const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())throw new Error("缓存目录不能是链接或普通文件");
   const target=canonicalPath(directory);
   if(this.catalog.roots().some(r=>pathWithin(target,canonicalPath(r.path))))throw new Error("缓存目录不能包含图库根目录");
   // Opening a temporary file proves writability without touching existing content.
   const probe=path.join(target,`.probe-${randomUUID()}`);await writeFile(probe,"");await rm(probe);
   if(pathWithin(target,canonicalPath(this.catalog.dataDir)))throw new Error("缓存目录不能包含图库数据库目录");
   const sourceCanonical=canonicalPath(source);
   const unchangedDirectory=async(dir:string,expected:string)=>{const st=await lstat(dir);if(!st.isDirectory()||st.isSymbolicLink()||canonicalPath(dir)!==expected)throw new Error("缓存目录在迁移期间被替换");};
   const same=sourceCanonical===target;
   const transferred:Array<{name:string;hash:string}>=[];
   if(!same){
    for(const name of await readdir(source).catch((e:any)=>{if(e.code==="ENOENT")return [];throw e;})){
     if(!cacheFile.test(name))continue;
     await unchangedDirectory(source,sourceCanonical);await unchangedDirectory(directory,target);
     const old=path.join(source,name),next=path.join(target,name);
     const st=await lstat(old);if(!st.isFile()||st.isSymbolicLink())continue;
     const hash=await digest(old);
     try{const dst=await lstat(next);if(!dst.isFile()||dst.isSymbolicLink()||await digest(next)!==hash)throw new Error("目标缓存存在同名但内容不同的文件");}
     catch(e:any){if(e.code!=="ENOENT")throw e;await copyFile(old,next,1);copied.push({file:next,hash});}
     if(await digest(next)!==hash)throw new Error("缓存复制校验失败");
     transferred.push({name,hash});
    }
   }
   await unchangedDirectory(directory,target);
   if(persist&&this.preferenceFile){
    await mkdir(path.dirname(this.preferenceFile),{recursive:true});
    const temp=this.preferenceFile+`.${randomUUID()}.tmp`;
    try{await writeFile(temp,JSON.stringify({schema:1,directory:target},null,2));await rename(temp,this.preferenceFile);}finally{await rm(temp,{force:true}).catch(()=>{});}
   }
   this.catalog.cacheDirectory=target;
   this.error=configurationError??hideManagedDataDirectory(target);
   let retained=0;
   if(!same)for(const item of transferred){
    const old=path.join(source,item.name);
    try{await unchangedDirectory(source,sourceCanonical);const st=await lstat(old);if(st.isSymbolicLink()||!st.isFile()||await digest(old)!==item.hash){retained++;continue;}await rm(old);}
    catch{retained++;}
   }
   if(retained)this.error=[this.error,`已切换缓存位置，${retained} 个旧缓存文件未能安全清理，仍保留在 ${source}`].filter(Boolean).join("；");
  }catch(e){
   // No source file has been deleted before commit. Existing target files are never removed.
   for(const item of copied)try{const st=await lstat(item.file);if(st.isFile()&&!st.isSymbolicLink()&&await digest(item.file)===item.hash)await rm(item.file);}catch{}
   this.error=`缓存位置未切换，仍使用原位置：${e instanceof Error?e.message:String(e)}`;
   if(configurationError)this.error=configurationError+"；"+this.error;
  }
  return this.status();
 }
}
