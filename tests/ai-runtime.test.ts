import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {PythonRuntime} from "../src/core/ai.js";

test("timed out worker rejects all pending work and the replacement survives old exit", async () => {
 const home=await mkdtemp(path.join(tmpdir(),"ai-worker-timeout-"));
 await writeFile(path.join(home,"ai-worker.py"), `const fs=require('node:fs');const path=require('node:path');const readline=require('node:readline');const marker=path.join(process.argv[2],'started');const first=!fs.existsSync(marker);fs.writeFileSync(marker,'1');readline.createInterface({input:process.stdin}).on('line',line=>{if(!first){const req=JSON.parse(line);console.log(JSON.stringify({id:req.id,result:{elapsedMs:1,providers:[]}}));}});`);
 const runtime=new PythonRuntime(home,process.execPath,{timeoutMs:500,idleMs:30000});
 try {
  const first=runtime.run("wd",{path:"a"},"cpu");
  const expired=(runtime as any).workers.get("wd");
  const second=runtime.run("wd",{path:"b"},"cpu");
  const result=await Promise.allSettled([first,second]);
  assert.ok(result.every(item=>item.status==="rejected"&&/AI_INFERENCE_TIMEOUT/.test(String(item.reason))));
  assert.equal((runtime as any).workers.size,0);
  const recovered=await runtime.run("wd",{path:"c"},"cpu");
  assert.equal(recovered.elapsedMs,1);
  expired.child.emit("exit",1,null); // A delayed old exit must not remove its replacement.
  assert.equal((runtime as any).workers.size,1);
  const again=await runtime.run("wd",{path:"d"},"cpu");assert.equal(again.elapsedMs,1);
 }finally{runtime.close();await rm(home,{recursive:true,force:true});}
});


test("stdin failure and explicit close settle pending requests immediately", async () => {
 const home=await mkdtemp(path.join(tmpdir(),"ai-worker-close-"));
 await writeFile(path.join(home,"ai-worker.py"),`process.stdin.resume();`);
 const runtime=new PythonRuntime(home,process.execPath,{timeoutMs:5000,idleMs:30000});
 try {
  const pending=runtime.run("semantic",{text:"a"},"cpu");
  const rejected=assert.rejects(pending,/broken pipe/);
  (runtime as any).workers.get("semantic").child.stdin.emit("error",new Error("broken pipe"));
  await rejected;assert.equal((runtime as any).workers.size,0);
  const next=runtime.run("semantic",{text:"b"},"cpu");
  const closed=assert.rejects(next,/AI_WORKER_CLOSED/);runtime.close();await closed;
  assert.equal((runtime as any).workers.size,0);
 }finally{runtime.close();await rm(home,{recursive:true,force:true});}
});


test("worker protocol preserves input, environment and unknown runtime error classes", async () => {
 const home=await mkdtemp(path.join(tmpdir(),"ai-worker-errors-"));
 await writeFile(path.join(home,"ai-worker.py"),`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);console.log(JSON.stringify({id:req.id,error:'fixture failure',errorKind:req.path}));});`);
 const runtime=new PythonRuntime(home,process.execPath);
 try {
  await assert.rejects(runtime.run("wd",{path:"input"},"cpu"),/AI_INPUT_ERROR: fixture failure/);
  await assert.rejects(runtime.run("wd",{path:"environment"},"cpu"),/AI_ENVIRONMENT_ERROR: fixture failure/);
  await assert.rejects(runtime.run("wd",{path:"runtime"},"cpu"),/AI_WORKER_ERROR: fixture failure/);
 }finally{runtime.close();await rm(home,{recursive:true,force:true});}
});
