import {createServer} from 'vite';
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const fixture='renderer/__preview-menu-fixture.tsx',html='renderer/__preview-menu-fixture.html';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import App from './App';import './styles.css';import './standalone.css';import './live.css';
const root={id:'root',path:'SYNTHETIC ONLY',status:'partial',createdAt:1,lastScanAt:1};
const items=['first','second','missing'].map((id,i)=>({id,rootId:'root',relativePath:id+'.png',title:'Synthetic '+id,creatorName:'Fixture',bytes:100,mtimeMs:1,addedAt:1,missing:i===2,artworkId:i===0?'123':null,page:0,candidateArtworkId:null,favorite:false,rating:0,width:600,height:400,format:'png',thumbnailKey:'fixture',root,processing:{status:'ready',error:null,algorithmVersion:'fixture'},tags:[],source:i===0?{id:'123',title:'Fixture',creatorId:'1',creatorName:'Fixture',pageCount:1,publishedAt:null,fetchedAt:1,url:'https://www.pixiv.net/artworks/123'}:null}));
window.calls=[];window.imageFinder={invoke:async(method,payload)=>{window.calls.push({method,payload});
if(method==='files.query')return{items:payload?.filter?.artworkIds?[items[0]]:items,total:3,offset:0,limit:100};
if(method==='files.detail')return items.find(i=>i.id===payload.fileId);
if(method==='system.stats')return{at:1,files:3,features:3,jobs:[],roots:[root],local:{scanPaused:true,running:false}};
if(method==='library.list')return[root];if(method==='tags.list'||method==='collections.list'||method==='directories.list')return[];
if(method==='settings.get')return{dataDir:'SYNTHETIC',cacheLimitBytes:1e9,autoProcessNewImages:false,autoDiscoverNewImages:false};
if(method==='files.copyImage'){if(window.failBitmap)throw Error('合成图片复制失败');return;}
if(method==='files.copy')return{successIds:payload.fileIds,failures:[],canceled:false};
if(method==='files.trash'){window.trashConfirmation=payload.fileIds;window.alert('合成回收站确认：已取消');return{successIds:[],failures:[],canceled:true};}
if(method==='organization.apply'){for(const id of payload.fileIds)Object.assign(items.find(i=>i.id===id),{favorite:payload.favorite});return{changed:1};}
if(method==='files.open'||method==='files.reveal'||method==='files.openSource')return;
if(method==='network.status')return{proxy:{mode:'system'},sessionPresent:false,authState:'unauthenticated'};
if(method==='ai.status')return{config:{},models:[],queues:[],install:{running:false},maintenance:false};
if(method==='ai.candidates')return{run:null,candidates:[]};if(method==='danbooru.tags')return[];
if(method==='jobs.settings')return{intervalMinSeconds:10,intervalMaxSeconds:15,batchLimit:200,restMinutes:15,autoRest:true};
if(method==='sauce.status')return{configured:false,paused:true,counts:[]};
throw Error('Synthetic unavailable '+method);
},onProgress:()=>()=>{},onAppEvent:()=>()=>{}};createRoot(document.getElementById('image-finder-prototype')).render(<App/>);`;
let server,browser;
try{
await fs.writeFile(fixture,source);await fs.writeFile(html,'<html><body><div id="image-finder-prototype"></div><script type="module" src="/__preview-menu-fixture.tsx"></script></body></html>');
server=await createServer({plugins:[{name:'synthetic-image-url',transform(code,id){if(id.replaceAll('\\\\','/').endsWith('/src/ui-model.ts'))return code.replace('image-finder://image/','/__fixture-image/');}}],server:{port:5198,strictPort:true}});await server.listen();
browser=await chromium.launch({executablePath:process.env.IMAGE_FINDER_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
await page.route('**/__fixture-image/**',route=>route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#668ca4"/><circle cx="300" cy="200" r="100" fill="#b5d5cc"/></svg>'}));
await page.goto('http://localhost:5198/__preview-menu-fixture.html');
await page.locator('.if-gallery-card').first().waitFor();
// Open the actual App viewer, then exercise its target isolation against broader gallery selection.
await page.keyboard.press('Control+a');await page.locator('.if-gallery-card').first().dblclick();await page.locator('.if-viewer').waitFor();
await page.locator('.if-gallery-card[data-file-id=second] .if-card-image-button').evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})));assert.equal(await page.locator('.if-gallery-card.selected').count(),2);
const image=page.locator('.if-viewer-image-area .if-art');const menu=page.getByRole('menu');
const open=async()=>{await image.click({button:'right'});await menu.waitFor();};
const action=async(label,method)=>{await open();await menu.getByRole('menuitem',{name:label,exact:true}).click();await page.waitForFunction(m=>window.calls.some(c=>c.method===m),method);const call=await page.evaluate(m=>window.calls.filter(c=>c.method===m).at(-1),method);assert.deepEqual(call.payload.fileIds??[call.payload.fileId],['first']);assert.equal(await menu.count(),0);};
await action('复制图片','files.copyImage');await page.getByText('已复制图片，可在聊天窗口粘贴',{exact:true}).waitFor();
await page.evaluate(()=>window.failBitmap=true);await open();await menu.getByRole('menuitem',{name:'复制图片',exact:true}).click();await page.getByText('合成图片复制失败',{exact:true}).waitFor();await page.evaluate(()=>window.failBitmap=false);
await action('复制文件','files.copy');await action('复制路径','files.copy');assert.equal((await page.evaluate(()=>window.calls.filter(c=>c.method==='files.copy').at(-1))).payload.format,'paths');
await action('打开所在文件夹','files.reveal');await action('用默认程序打开','files.open');await action('打开 Pixiv 投稿','files.openSource');await action('收藏图片','organization.apply');
await open();assert.equal(await menu.getByRole('menuitem',{name:'取消收藏'}).count(),1);await page.keyboard.press('Escape');assert.equal(await menu.count(),0);assert.equal(await page.locator('.if-viewer').count(),1);
await action('移到回收站','files.trash');assert.deepEqual(await page.evaluate(()=>window.trashConfirmation),['first']);
await open();await page.getByRole('button',{name:'100% 原始尺寸',exact:true}).click();assert.equal(await menu.count(),0);const before=await image.getAttribute('style');await open();await page.keyboard.press('Space');assert.equal(await image.getAttribute('style'),before);if(await menu.count())await page.keyboard.press('Escape');
await page.locator('.if-viewer-image-area').focus();await page.keyboard.press('Shift+F10');await menu.waitFor();await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'复制路径');await page.keyboard.press('Escape');
// Preserve zoom/pan and double-click behavior around right clicks.
await page.getByRole('button',{name:'放大',exact:true}).click();const zoomBefore=await page.getByLabel('当前缩放比例').textContent();
const artBefore=await image.locator('..').getAttribute('style');await open();await page.mouse.move(450,450);await page.mouse.up({button:'right'});await page.keyboard.press('Escape');assert.equal(await image.locator('..').getAttribute('style'),artBefore);assert.equal(await page.getByLabel('当前缩放比例').textContent(),zoomBefore);
await image.dblclick();assert.equal(await page.locator('.if-viewer').count(),1);await page.keyboard.press('Space');assert.equal(await page.getByLabel('当前缩放比例').textContent(),'100%');
// Clamp the expanded seven-action menu at a deliberately edge-anchored context event.
await image.evaluate(el=>el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:1278,clientY:898})));await menu.waitFor();const bounds=await menu.boundingBox();assert.ok(bounds.x>=8&&bounds.y>=8&&bounds.x+bounds.width<=1272&&bounds.y+bounds.height<=892,JSON.stringify(bounds));
await fs.mkdir('artifacts/preview-context-menu',{recursive:true});await page.screenshot({path:'artifacts/preview-context-menu/edge-menu.png'});
await page.keyboard.press('Escape');await page.setViewportSize({width:640,height:600});await page.locator('.if-viewer').getByRole('button',{name:'显示或隐藏图片信息',exact:true}).click();await image.evaluate(el=>el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:638,clientY:598})));await menu.waitFor();const narrow=await menu.boundingBox();assert.ok(narrow.x>=8&&narrow.y>=8&&narrow.x+narrow.width<=632&&narrow.y+narrow.height<=592,JSON.stringify(narrow));for(const row of await menu.getByRole('menuitem').all()){assert.equal(await row.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'Menu row obscured by toast');}await page.screenshot({path:'artifacts/preview-context-menu/narrow-menu.png'});await page.setViewportSize({width:1280,height:900});
await page.getByRole('button',{name:'下一张',exact:true}).click();assert.equal(await menu.count(),0);await open();assert.equal(await menu.getByRole('menuitem',{name:'打开 Pixiv 投稿'}).count(),0);await page.keyboard.press('Escape');
await page.getByRole('button',{name:'下一张',exact:true}).click();await open();for(const label of ['复制图片','复制文件','复制路径','打开所在文件夹','用默认程序打开','移到回收站'])assert.equal(await menu.getByRole('menuitem',{name:label,exact:true}).isDisabled(),true);assert.equal(await menu.getByRole('menuitem',{name:'收藏图片',exact:true}).isEnabled(),true);await page.screenshot({path:'artifacts/preview-context-menu/missing-menu.png'});await page.keyboard.press('Escape');
await page.keyboard.press('Space');assert.equal(await page.locator('.if-viewer').count(),1);await page.locator('.if-viewer-image-area').dblclick({position:{x:100,y:100}});assert.equal(await page.locator('.if-viewer').count(),0);
// Reopen and verify viewer Escape still closes after the menu is gone.
await page.locator('.if-gallery-card').first().locator('.if-card-image-button').dblclick();await page.locator('.if-viewer').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('.if-viewer').count(),0);
// The shared gallery menu retains multi-file targets and keyboard behavior after portaling.
await page.keyboard.press('Control+a');assert.equal(await page.locator('.if-gallery-card.selected').count(),3);await page.locator('.if-gallery-card').first().click({button:'right'});await menu.waitFor();assert.equal(await menu.getByRole('menuitem',{name:'复制图片',exact:true}).isDisabled(),true);assert.equal(await menu.getByRole('menuitem',{name:'用默认程序打开',exact:true}).isDisabled(),true);await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'复制路径');await page.keyboard.press('Enter');assert.deepEqual((await page.evaluate(()=>window.calls.filter(c=>c.method==='files.copy').at(-1))).payload.fileIds,['first','second','missing']);await page.locator('.if-gallery-card').first().click({button:'right'});await menu.waitFor();await page.keyboard.press('Escape');assert.equal(await menu.count(),0);
// A partial root still permits accessible single images; missing originals remain disabled.
await page.locator('.if-gallery-card[data-file-id=second] .if-card-image-button').click();await page.locator('.if-gallery-card[data-file-id=second]').click({button:'right'});await menu.waitFor();await menu.getByRole('menuitem',{name:'复制图片',exact:true}).click();assert.deepEqual((await page.evaluate(()=>window.calls.filter(c=>c.method==='files.copyImage').at(-1))).payload,{fileId:'second'});
await page.locator('.if-gallery-card[data-file-id=missing] .if-card-image-button').click();await page.locator('.if-gallery-card[data-file-id=missing]').click({button:'right'});await menu.waitFor();assert.equal(await menu.getByRole('menuitem',{name:'复制图片',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');
assert.deepEqual(errors,[]);const calls=await page.evaluate(()=>window.calls);await fs.writeFile('artifacts/preview-context-menu/report.json',JSON.stringify({passed:true,rendererErrors:errors,actions:calls.filter(c=>['files.copyImage','files.copy','files.reveal','files.open','files.openSource','organization.apply','files.trash'].includes(c.method)),syntheticOnly:true},null,2));console.log('PASS: full App synthetic preview menu, current single target, all existing actions, cancelled synthetic trash, keyboard/Esc/outside/navigation close, edge clamp, missing-file states; no production API or files used.');
}finally{await browser?.close();await server?.close();await fs.rm(fixture,{force:true});await fs.rm(html,{force:true});}
