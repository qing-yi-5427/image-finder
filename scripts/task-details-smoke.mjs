import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const recordOnly = process.argv.includes('--record-only');
const baseline = process.argv.includes('--baseline');
const root = process.cwd();
const fixture = path.join(root, 'renderer/__task-details-fixture.tsx');
const html = path.join(root, 'renderer/__task-details-fixture.html');
const baselineFiles = ['TaskOverview', 'UtilityPages', 'AiPanel'];
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {TasksPage} from './UtilityPages';
import './styles.css';import './standalone.css';import './live.css';
const cards=['pixiv','wd','semantic','danbooru','sauce','local'].map(kind=>({kind,label:kind,cancellable:1,coverage:{covered:1,total:2},progress:{total:2,processed:1,unit:'图片',counts:[]},paused:true,reason:null}));
window.calls=[];
window.imageFinder={
 invoke:async(method,payload)=>{
  window.calls.push({method,payload,at:performance.now()});
  if(method==='tasks.overview')return{scope:{rootId:null,relativePath:'',recursive:true,total:2,label:'隔离范围'},executionScope:null,cards};
  if(method==='library.list')return[];
  if(method==='ai.resume')return {};
  if(method==='ai.status')return{config:{provider:'cpu',generalThreshold:.55,characterThreshold:.85},models:['wd','semantic'].map(kind=>({kind,id:'fixture',version:'1',ready:true,filesMissing:[],license:'fixture'})),queues:['wd','semantic'].map(kind=>({kind,paused:true,activeFileId:null,counts:{waiting:1,running:0,done:1,failed:0},indexed:1,stale:0,total:2})),install:{running:false,stage:'',error:null}};
  throw Error('fixture unavailable');
 },onProgress:()=>()=>{},onAppEvent:()=>()=>{}
};
createRoot(document.getElementById('image-finder-prototype')).render(<TasksPage notify={()=>{}}/>);
`;
const count = calls => calls.reduce((result, call) => {
  result[call.method] = (result[call.method] || 0) + 1;
  return result;
}, {});
let server, browser;
try {
  if (baseline) for (const name of baselineFiles) {
    let code = execFileSync('git', ['show', 'HEAD:renderer/' + name + '.tsx'], { encoding: 'utf8' });
    if (name === 'UtilityPages') code = code.replaceAll('./TaskOverview', './__baseline_TaskOverview').replaceAll('./AiPanel', './__baseline_AiPanel');
    await fs.writeFile(path.join(root, 'renderer/__baseline_' + name + '.tsx'), code);
  }
  await fs.writeFile(fixture, baseline ? source.replace("from './UtilityPages'", "from './__baseline_UtilityPages'") : source);
  await fs.writeFile(html, '<html><body><div id="image-finder-prototype"></div><script type="module" src="/__task-details-fixture.tsx"></script></body></html>');
  server = await createServer({ server: { port: 5199, strictPort: true } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.IMAGE_FINDER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://localhost:5199/__task-details-fixture.html');
  await page.locator('.if-task-owned-details').last().waitFor();
  await page.waitForTimeout(12200);
  const closed = count(await page.evaluate(() => window.calls));
  console.log('CLOSED ' + JSON.stringify(closed));
  await fs.mkdir('artifacts/task-details-polling', { recursive: true });
  if (recordOnly) {
    await fs.writeFile('artifacts/task-details-polling/' + (baseline ? 'before' : 'record') + '.json', JSON.stringify(closed, null, 2));
  } else {
    if (Object.keys(closed).some(key => !['tasks.overview', 'library.list'].includes(key))) throw Error('Collapsed panels sent requests');
    const reports = { closed };
    for (const [kind, method] of [['wd','ai.status'], ['semantic','ai.status'], ['danbooru','danbooru.status'], ['sauce','sauce.status'], ['pixiv','jobs.list'], ['local','local.status']]) {
      await page.evaluate(() => window.calls = []);
      const details = page.locator('.if-task-card-' + kind + ' > .if-task-body > .if-task-owned-details');
      await details.locator(':scope > summary').click();
      await page.waitForTimeout(150);
      let calls = await page.evaluate(() => window.calls);
      if (!calls.some(call => call.method === method)) throw Error(kind + ' did not load immediately');
      await page.waitForTimeout(4100);
      calls = await page.evaluate(() => window.calls);
      if (calls.filter(call => call.method === method).length < 2) throw Error(kind + ' did not poll while open');
      const allowed = ['library.list', 'tasks.overview', method, ...(kind === 'pixiv' ? ['network.status','jobs.settings'] : []), ...(kind === 'danbooru' ? ['danbooru.list'] : []), ...(kind === 'sauce' ? ['sauce.list'] : [])];
      const unrelated = calls.filter(call => !allowed.includes(call.method));
      if (unrelated.length) throw Error(kind + ' triggered unrelated calls ' + JSON.stringify(count(unrelated)));
      reports[kind] = count(calls);
      if (kind === 'wd') {
        const settings = details.locator('.if-ai-settings');
        await settings.locator(':scope > summary').click();
        await page.waitForTimeout(150);
        if (!(await page.evaluate(() => window.calls)).some(call => call.method === 'ai.environment')) throw Error('Model settings did not load on opening');
        await settings.locator(':scope > summary').click();
        await page.waitForTimeout(100);
        await page.evaluate(() => window.calls = []);
        await page.waitForTimeout(3200);
        if ((await page.evaluate(() => window.calls)).filter(call => call.method === 'ai.status').length !== 1) throw Error('Collapsed model settings kept polling');
      }
      await details.locator(':scope > summary').click();
      await page.waitForTimeout(100);
      await page.evaluate(() => window.calls = []);
      await page.waitForTimeout(4200);
      const after = count(await page.evaluate(() => window.calls));
      if (Object.keys(after).some(key => key !== 'tasks.overview')) throw Error(kind + ' still polled after close ' + JSON.stringify(after));
    }
    await page.evaluate(() => window.calls = []);
    await page.locator('.if-task-card-wd > .if-task-body > .if-task-primary-action').getByRole('button', { name: '继续原队列', exact: true }).click();
    await page.waitForTimeout(150);
    if (!(await page.evaluate(() => window.calls)).some(call => call.method === 'ai.resume' && call.payload.kind === 'wd')) throw Error('Collapsed card resume changed semantics');
    await page.evaluate(() => window.calls = []);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForTimeout(150);
    if (!(await page.evaluate(() => window.calls)).some(call => call.method === 'tasks.overview')) throw Error('Manual refresh did not refresh overview');
    if (errors.length) throw Error('Renderer errors: ' + errors.join('; '));
    await fs.writeFile('artifacts/task-details-polling/after.json', JSON.stringify(reports, null, 2));
    await page.screenshot({ path: 'artifacts/task-details-polling/closed.png', fullPage: true });
    console.log('PASS ' + JSON.stringify(reports));
  }
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(fixture, { force: true });
  await fs.rm(html, { force: true });
  if (baseline) for (const name of baselineFiles) await fs.rm(path.join(root, 'renderer/__baseline_' + name + '.tsx'), { force: true });
}
