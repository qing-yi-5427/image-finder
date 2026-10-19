import test from 'node:test';import assert from 'node:assert/strict';import {trayPauseActions}from'../src/electron/tray-actions.js';
const idle=()=>({stats:{local:{scanPaused:true,imagesPaused:true}},pixiv:{source:{paused:1,reason:'user'},counts:[]},ai:{queues:[]},sauce:{paused:true,counts:[]},danbooru:{paused:true,reason:'access_restricted',counts:[{status:'waiting',count:2}]}});
test('tray pause targets only fresh runnable task states and never resumes or clears queues/protection',()=>{
 const s:any=idle();assert.deepEqual(trayPauseActions(s),[]);
 s.stats.local={scanPaused:false,imagesPaused:false,pendingRoots:['r'],images:{pending:3}};
 s.pixiv={source:{paused:1,reason:'batch_rest',scopePending:3},counts:[]};
 s.ai={queues:[{kind:'wd',paused:false,counts:{waiting:2,running:0}},{kind:'semantic',paused:true,counts:{waiting:2,running:0}}]};
 s.sauce={paused:false,counts:[{status:'waiting',count:2}]};
 const before=JSON.stringify(s);assert.deepEqual(trayPauseActions(s),[{method:'local.pause',payload:{kind:'scan'}},{method:'local.pause',payload:{kind:'images'}},{method:'jobs.pause',payload:{}},{method:'ai.pause',payload:{kind:'wd'}},{method:'sauce.pause',payload:{}}]);assert.equal(JSON.stringify(s),before);
 s.danbooru.paused=false;assert.equal(trayPauseActions(s).some(a=>a.method==='danbooru.pause'),true);
});
