import {app,clipboard,nativeImage} from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {copyImageToClipboard} from '../dist/src/electron/image-clipboard.js';
app.whenReady().then(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'finder-electron-bitmap-'));
 const formatsBefore=clipboard.availableFormats();
 // This smoke uses an in-memory adapter: never replace the user's clipboard.
 try {
 const file=path.join(dir,'synthetic.png');const pixels=Buffer.from([255,0,0,255,0,255,0,128]);
 await sharp(pixels,{raw:{width:2,height:1,channels:4}}).png().toFile(file);
 let stored=nativeImage.createEmpty(),writes=0;
 const adapter={writeImage(image){stored=nativeImage.createFromBuffer(image.toPNG());writes++},readImage(){return stored}};
 await copyImageToClipboard(file,adapter);assert.equal(writes,1);assert.deepEqual(stored.getSize(),{width:2,height:1});
 assert.deepEqual(await sharp(stored.toPNG()).raw().toBuffer(),pixels);
 await assert.rejects(copyImageToClipboard(file,{writeImage(){throw Error('busy')},readImage(){return stored}}),/剪贴板暂不可用/);
 await assert.rejects(copyImageToClipboard(file,{writeImage(){},readImage(){return nativeImage.createEmpty()}}),/剪贴板暂不可用/);
 assert.deepEqual(clipboard.availableFormats(),formatsBefore);
 console.log('PASS Electron nativeImage bitmap roundtrip and clipboard adapter errors; OS clipboard not modified (rich formats present).');
 } finally {await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}).then(()=>app.quit()).catch(e=>{console.error(e);app.exit(1)});
