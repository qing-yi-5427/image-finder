import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { decodeClipboardImage } from "../src/electron/clipboard-image-decode.js";
import { validateInvocation } from "../src/bridge.js";

test("bitmap IPC accepts one indexed ID only, rejects arbitrary paths, arrays and extras", () => {
  validateInvocation("files.copyImage", { fileId: "indexed" });
  for (const payload of [{path:"C:/secret.png"},{fileIds:["a","b"]},{fileId:"a",path:"C:/secret.png"},{fileId:""}])
    assert.throws(()=>validateInvocation("files.copyImage",payload));
});
test("clipboard decoder preserves transparent PNG pixels, supports WebP/JPEG EXIF and never changes source", async () => {
 sharp.cache(false);
 const dir=await mkdtemp(path.join(tmpdir(),"finder-bitmap-"));
 try {
  const rgba=Buffer.from([255,0,0,255,0,255,0,128,0,0,255,0,255,255,255,255,0,0,0,255,100,110,120,255]);
  for(const format of ["png","webp","jpeg"] as const){
   const file=path.join(dir,"synthetic."+format);
   let pipeline=sharp(rgba,{raw:{width:3,height:2,channels:4}});
   if(format==="jpeg")pipeline=pipeline.withMetadata({orientation:6});
   await pipeline.toFormat(format).toFile(file);
   const before=await readFile(file);const decoded=await decodeClipboardImage(file);const meta=await sharp(decoded).metadata();
   assert.equal(meta.format,"png");assert.deepEqual([meta.width,meta.height],format==="jpeg"?[2,3]:[3,2]);
   if(format==="png")assert.deepEqual(await sharp(decoded).raw().toBuffer(),rgba);
   assert.deepEqual(await readFile(file),before);
  }
  const bad=path.join(dir,"bad.png");await writeFile(bad,"invalid image");
  await assert.rejects(decodeClipboardImage(bad),/无法解码/);
  const huge=path.join(dir,"huge.png");await sharp({create:{width:5001,height:5000,channels:3,background:"red"}}).png().toFile(huge);
  await assert.rejects(decodeClipboardImage(huge),/2500 万像素/);
 } finally {await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
