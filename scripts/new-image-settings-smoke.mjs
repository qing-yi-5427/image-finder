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
 if(method==='jobs.settings')return{intervalMinSeconds:10,intervalMaxSeconds:15,batchLimit:200,restMinutes:15,autoRest:true};
 if(method==='sauce.status')return{configured:false,paused:true,counts:[]};
 if(method==='ai.status')return{python:'C:/isolated-fixture/very-long-environment-directory/python/python.exe',config:{generalThreshold:0.55,characterThreshold:0.85,provider:'cpu'},install:{running:false,stage:'',error:null},queues:[],maintenance:false,models:[{kind:'wd',ready:true,id:'SmilingWolf/wd-swinv2-tagger-v3',version:'fixture-model-version-sha256-0123456789abcdef0123456789abcdef0123456789abcdef',filesMissing:[]},{kind:'semantic',ready:true,id:'OFA-Sys/chinese-clip-vit-base-patch16',version:'fixture-model-version',filesMissing:[]}]};
 if(method==='ai.environment')return{home:'C:/isolated-fixture/very-long-environment-directory/.image-finder-ai',managed:true,cleanupSupported:true,bytes:5*1024**3,error:null};
 throw Error('fixture unavailable');
},onProgress:callback=>{window.emitProgress=paused=>{localStorage.setItem("fixture.discover",JSON.stringify(!paused));callback({local:{scanPaused:paused}})};return()=>{};},onAppEvent:()=>()=>{}};
function Fixture(){const [theme,setTheme]=React.useState('dark');const [density,setDensity]=React.useState('compact');return <div data-theme={theme} style={{height:'100vh',display:'flex',background:'var(--if-bg)'}}><SettingsPage theme={theme} setTheme={setTheme} density={density} setDensity={setDensity} notify={()=>{}}/></div>};
createRoot(document.getElementById('image-finder-prototype')).render(<Fixture/>);
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
 // All navigation and maintenance checks operate solely against the synthetic API above.
 const nav=page.getByRole('navigation',{name:'设置分类'});
 const select=async label=>{await nav.getByRole('button',{name:label,exact:false}).click();};
 await select('存储与数据');const cacheInput=page.getByRole('spinbutton',{name:'缓存容量 GiB'});await cacheInput.fill('12.5');
 await page.getByRole('button',{name:'清理缓存',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'从备份恢复',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();
 await select('来源连接');const requestDetails=page.locator('details').filter({has:page.locator('summary').getByText('请求间隔与批次设置',{exact:true})});
 if(await requestDetails.getAttribute('open')!==null)throw Error('Request controls should start collapsed');await requestDetails.locator('summary').click();
 const interval=page.getByRole('spinbutton',{name:'最小请求间隔（秒）',exact:true});await interval.fill('23');
 await page.getByRole('combobox',{name:'代理模式'}).selectOption('custom');await page.getByRole('textbox',{name:'代理地址'}).fill('127.0.0.1:9999');
 const key=page.getByLabel('SauceNAO API 密钥',{exact:true});await key.fill('unsaved-fixture-key');
 await select('本地 AI');const threshold=page.getByRole('spinbutton',{name:'一般标签分析阈值',exact:true});await threshold.fill('0.62');
 const technical=page.locator('details').filter({has:page.locator('summary').getByText('模型版本与环境详情',{exact:true})});if(await technical.getAttribute('open')!==null)throw Error('AI technical details should start collapsed');
 const cleanup=page.locator('details').filter({has:page.locator('summary').getByText('清理 AI 环境与模型',{exact:true})});await cleanup.locator('summary').click();await cleanup.getByRole('button',{name:'清理环境与模型',exact:true}).click();await page.getByRole('button',{name:'保留环境',exact:true}).click();await cleanup.locator('summary').click();
 await select('存储与数据');if(await cacheInput.inputValue()!=='12.5')throw Error('Cache draft lost');
 await select('来源连接');if(await interval.inputValue()!=='23'||await key.inputValue()!=='unsaved-fixture-key'||await page.getByRole('textbox',{name:'代理地址'}).inputValue()!=='127.0.0.1:9999')throw Error('Source draft lost');
 await select('本地 AI');if(await threshold.inputValue()!=='0.62')throw Error('AI draft lost');
 await threshold.fill('0.55');await select('存储与数据');await cacheInput.fill('10');await select('来源连接');await interval.fill('10');await key.fill('');await page.getByRole('combobox',{name:'代理模式'}).selectOption('system');await requestDetails.locator('summary').evaluate(el=>el.parentElement.open=false);
 await select('常规');await toggle.click();await page.waitForTimeout(300);await toggle.click();await page.waitForTimeout(300); // Clear the deliberately injected save error before visual review.
 await fs.mkdir('artifacts/settings-layout',{recursive:true});const layouts=[];
 for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});for(const theme of ['dark','light']){
 await select('常规');await page.getByRole('combobox',{name:'主题',exact:true}).selectOption(theme);
 for(const label of ['常规','存储与数据','本地 AI','来源连接']){await select(label);await page.locator('.if-settings-page').evaluate(el=>el.scrollTop=0);
 const visible=await page.locator('.if-settings-panel:visible').count();if(visible!==1)throw Error('Expected exactly one visible category');
 const overflow=await page.evaluate(()=>{const el=document.querySelector('.if-settings-page');return {page:document.documentElement.scrollWidth>innerWidth,settings:el.scrollWidth>el.clientWidth+1};});if(overflow.page||overflow.settings)throw Error('Horizontal overflow '+JSON.stringify({width,theme,label,overflow}));
 const file='artifacts/settings-layout/'+width+'-'+theme+'-'+({'常规':'general','存储与数据':'storage','本地 AI':'ai','来源连接':'sources'}[label])+'.png';await page.screenshot({path:file});layouts.push({width,theme,label,file});
 }
 }}
 await page.setViewportSize({width:390,height:1000});await select('本地 AI');await technical.locator('summary').click();await page.screenshot({path:'artifacts/settings-layout/390-light-ai-expanded.png'});if(await page.locator('.if-settings-page').evaluate(el=>el.scrollWidth>el.clientWidth+1))throw Error('Expanded AI details overflow');
 await select('来源连接');await requestDetails.locator('summary').click();await select('常规');await select('来源连接');if(await requestDetails.getAttribute('open')===null)throw Error('Disclosure state lost');await requestDetails.locator('summary').click();
 await nav.getByRole('button',{name:'常规',exact:false}).focus();await page.keyboard.press('Enter');if(!await page.getByRole('region',{name:'常规',exact:true}).isVisible())throw Error('Keyboard navigation failed');
 await fs.writeFile('artifacts/settings-layout/report.json',JSON.stringify({passed:true,layouts,draftsPreserved:['cache','proxy','request interval','SauceNAO key','AI threshold'],confirmationsCancelled:['cache','restore','AI cleanup'],rendererErrors:errors},null,2));
 const calls=await page.evaluate(()=>window.calls);const writes=calls.filter(call=>!['settings.get','network.status','cache.status','power.get','app.version','library.list','jobs.settings','ai.status','ai.environment','sauce.status'].includes(call.method));
 if(writes.some(call=>!['settings.setAutoProcessNewImages','settings.setAutoDiscoverNewImages'].includes(call.method)||typeof call.payload.enabled!=='boolean'))throw Error('Unexpected side effects '+JSON.stringify(writes));
 if(errors.length)throw Error('Renderer errors '+errors.join(';'));
 await fs.writeFile('artifacts/new-image-settings/report.json',JSON.stringify({passed:true,writes,rendererErrors:errors},null,2));
 console.log('PASS: automation save/reload/error behavior; four categories; 1440/900/390 dark/light without overflow; form drafts/disclosure preserved; keyboard navigation; maintenance confirmations cancelled; no queue/model/cache mutation calls.');
}finally{await browser?.close();await server?.close();await fs.rm(fixture,{force:true});await fs.rm(html,{force:true});}
