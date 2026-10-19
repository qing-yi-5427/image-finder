import test from'node:test';import assert from'node:assert/strict';import{NativeFileDrag}from'../src/electron/file-drag.js';import{validateInvocation}from'../src/bridge.js';
test('native file drag resolves unique registered identifiers before publishing OS files and rejects unresolved originals atomically',async()=>{
 const started:string[][]=[];const resolved:string[]=[];const drag=new NativeFileDrag({resolve:async id=>{resolved.push(id);if(id==='bad')throw Error('missing');return 'C:/isolated/'+id+'.png';},start:files=>{started.push(files);}});
 assert.deepEqual(await drag.start(['a','b','a']),{started:true,count:2});assert.deepEqual(resolved,['a','b']);assert.deepEqual(started,[['C:/isolated/a.png','C:/isolated/b.png']]);await assert.rejects(drag.start(['a','bad']));assert.equal(started.length,1);await drag.start(['a']);assert.equal(started.length,2);
});
test('native file drag bounds identifiers, disallows caller paths in IPC and blocks concurrent gesture publication',async()=>{
 validateInvocation('files.drag',{fileIds:['a']});validateInvocation('app.version',{});
 for(const payload of [{path:'C:/secret.png'},{fileIds:[]},{fileIds:Array(501).fill('a')},{fileIds:['a'],files:['C:/secret.png']}])assert.throws(()=>validateInvocation('files.drag',payload));assert.throws(()=>validateInvocation('app.version',{version:'fake'}));
 let release!:(s:string)=>void;const drag=new NativeFileDrag({resolve:()=>new Promise(r=>release=r),start:()=>{}});const first=drag.start(['a']);await assert.rejects(drag.start(['b']),/拖出文件/);release('C:/isolated/a.png');await first;
});
