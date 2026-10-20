import {createServer} from 'vite';
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const fixture=path.join(root,'renderer/__new-image-settings-fixture.tsx');
const html=path.join(root,'renderer/__new-image-settings-fixture.html');
const source=`
import React from 'react';import {createRoot} from 'react-dom/client';import {SettingsPage} from './UtilityPages';import './styles.css';import './standalone.css';import './live.css';
const settings=()=>({dataDir:'isolated-fixture',cacheLimitBytes:10*1024**3,autoProcessNewImages:JSON.parse(localStorage.getItem('fixture.auto')??'true'),autoDiscoverNewImages:JSON.parse(localStorage.getItem('fixture.discover')??'false')});
window.calls=[];window.failNext=false;window.imageFinder={invoke:async(method,payload)=>{
 window.calls.push({method,payload});
 if(method==='settings.get')return settings();
 if(method==='settings.setAutoProcessNewImages'||method==='settings.setAutoDiscoverNewImages'){await new Promise(resolve=>setTimeout(resolve,200));if(window.failNext){window.failNext=false;throw Error('fixture save failure');}localStorage.setItem(method==='settings.setAutoDiscoverNewImages'?'fixture.discover':'fixture.auto',JSON.stringify(payload.enabled));return settings();}
 if(method==='network.status')return{proxy:{mode:'system'},sessionPresent:false,authState:'unauthenticated'};
 if(method==='cache.status')return{directory:'isolated-fixture/.image-finder-cache',requestedDirectory:null,error:null};
 if(method==='power.get')return{enabled:false,active:false,error:null};
 if(method==='app.version')return{version:'fixture',packaged:false};
 if(method==='library.list')return[];
 throw Error('fixture unavailable');
},onProgress:callback=>{window.emitProgress=paused=>{localStorage.setItem("fixture.discover",JSON.stringify(!paused));callback({local:{scanPaused:paused}})};return()=>{};},onAppEvent:()=>()=>{}};
createRoot(document.getElementById('image-finder-prototype')).render(<SettingsPage theme="dark" setTheme={()=>{}} density="compact" setDensity={()=>{}} notify={()=>{}}/>);
`;
let server,browser;
try{
 await fs.writeFile(fixture,source);await fs.writeFile(html,'<html><body><div id="image-finder-prototype"></div><script type="module" src="/__new-image-settings-fixture.tsx"></script></body></html>');
 server=await createServer({server:{port:5199,strictPort:true}});await server.listen();
 browser=await chromium.launch({executablePath:process.env.IMAGE_FINDER_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://localhost:5199/__new-image-settings-fixture.html');
 const toggle=page.getByRole('switch',{name:'自动处理新增图片',exact:true});await toggle.waitFor();await page.waitForFunction(()=>!document.querySelector('#settings-auto-process-new-images').disabled);
 if(!await toggle.isChecked())throw Error('Processing default must be on'); const discover=page.getByRole('switch',{name:'自动扫描发现新增图片',exact:true});if(await discover.isChecked())throw Error('Discovery ignored backend paused state');await discover.click();if(!await toggle.isDisabled())throw Error('Parallel save was not blocked');await page.waitForTimeout(300);if(!await discover.isChecked())throw Error('Discovery on save failed');await page.evaluate(()=>window.emitProgress(true));if(await discover.isChecked())throw Error('External pause did not synchronize');await page.evaluate(()=>window.emitProgress(false));if(!await discover.isChecked())throw Error('External resume did not synchronize');
 const onBackground=await toggle.evaluate(el=>getComputedStyle(el).backgroundColor);const section=page.getByRole('region',{name:'新增图片自动处理',exact:true});
 if(!await section.getByText('开启不会重跑已有图库',{exact:false}).count())throw Error('Missing scope explanation');
 await fs.mkdir('artifacts/new-image-settings',{recursive:true});await section.screenshot({path:'artifacts/new-image-settings/default-on.png'});
 await toggle.click();if(!await toggle.isDisabled())throw Error('Save did not lock switch');await page.waitForTimeout(300);if(await toggle.isChecked())throw Error('Off save failed');
 await page.reload();await page.waitForFunction(()=>!document.querySelector('#settings-auto-process-new-images').disabled);if(await toggle.isChecked())throw Error('Off did not persist on reload');if(!await discover.isChecked())throw Error('Discovery did not persist on reload');await discover.click();await page.waitForTimeout(300);if(await discover.isChecked())throw Error('Discovery off save failed');
 if(onBackground===await toggle.evaluate(el=>getComputedStyle(el).backgroundColor))throw Error('On/off visual states are indistinguishable');await section.screenshot({path:'artifacts/new-image-settings/off.png'});
 await toggle.click();await page.waitForTimeout(300);if(!await toggle.isChecked())throw Error('On save failed');
 await page.evaluate(()=>window.failNext=true);await toggle.click();await section.getByRole('alert').waitFor();if(!await toggle.isChecked())throw Error('Failed save changed accepted value');
 await section.screenshot({path:'artifacts/new-image-settings/save-error.png'});
 const calls=await page.evaluate(()=>window.calls);const writes=calls.filter(call=>!['settings.get','network.status','cache.status','power.get','app.version','library.list','jobs.settings','ai.status','ai.environment','sauce.status'].includes(call.method));
 if(writes.some(call=>!['settings.setAutoProcessNewImages','settings.setAutoDiscoverNewImages'].includes(call.method)||typeof call.payload.enabled!=='boolean'))throw Error('Unexpected side effects '+JSON.stringify(writes));
 if(errors.length)throw Error('Renderer errors '+errors.join(';'));
 await fs.writeFile('artifacts/new-image-settings/report.json',JSON.stringify({passed:true,writes,rendererErrors:errors},null,2));
 console.log('PASS: default on, off/on save, persist after reload, failed save keeps prior value, no queue/model/cache mutation calls.');
}finally{await browser?.close();await server?.close();await fs.rm(fixture,{force:true});await fs.rm(html,{force:true});}
