import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AppTray, trayIconPath } from "../src/electron/tray.js";
test("tray is singleton per lifecycle, brand tooltip, clicks/menu restore and focus; quit uses normal app quit", () => {
  const events = new Map<string, () => void>();
  const calls: string[] = [];
  let menu: any[] = [];
  let minimized = true;
  let destroyed = false;
  let created = 0;
  const tray = {
    isDestroyed: () => destroyed,
    setToolTip: (text: string) => {
      assert.equal(text, "Image Finder");
    },
    setContextMenu: () => {},
    on: (event: string, handler: () => void) => {
      events.set(event, handler);
    },
    destroy: () => {
      destroyed = true;
      calls.push("destroy");
    },
  };
  const appTray = new AppTray({
    create: (icon) => {
      created++;
      assert.equal(icon, "brand.ico");
      return tray;
    },
    menu: (items) => {
      menu = items;
      return items;
    },
    window: () => ({
      isDestroyed: () => false,
      isMinimized: () => minimized,
      restore: () => {
        calls.push("restore");
        minimized = false;
      },
      show: () => {
        calls.push("show");
      },
      focus: () => {
        calls.push("focus");
      },
    }),
    quit: () => {
      calls.push("quit");
    },
  });
  appTray.start("brand.ico");
  appTray.start("brand.ico");
  assert.equal(created, 1);
  assert.equal(appTray.exists, true);
  events.get("click")!();
  events.get("double-click")!();
  menu[0].click();
  assert.deepEqual(calls, [
    "restore",
    "show",
    "focus",
    "show",
    "focus",
    "show",
    "focus",
  ]);
  assert.deepEqual(
    menu.map((i) => i.label ?? i.type),
    ["显示主窗口", "separator", "退出"],
  );
  menu[2].click();
  assert.equal(calls.at(-1), "quit");
  appTray.close();
  appTray.close();
  assert.equal(appTray.exists, false);
  assert.equal(calls.filter((v) => v === "destroy").length, 1);
});
test("late tray clicks tolerate missing or destroyed window without keeping an app alive", () => {
  let window: any;
  const tray = new AppTray({
    create: () => {
      throw new Error("not needed");
    },
    menu: (items) => items,
    window: () => window,
    quit: () => {},
  });
  tray.showWindow();
  window = { isDestroyed: () => true };
  tray.showWindow();
  assert.equal(tray.exists, false);
});
test("configured tray navigates, synchronizes persistent power checkbox, disables idle pause and catches action failures", async () => {
  let items:any[]=[];let destroyed=false;const calls:string[]=[];
  const controller=new AppTray({create:()=>({isDestroyed:()=>destroyed,setToolTip(){},setContextMenu(){},on(){},destroy(){destroyed=true;}}),menu:menu=>{items=menu;return menu;},window:()=>({isDestroyed:()=>false,isMinimized:()=>false,restore(){},show(){calls.push('show');},focus(){calls.push('focus');}}),quit(){calls.push('quit');}});
  controller.configure({navigate:page=>calls.push(page),setPower:async enabled=>{calls.push(String(enabled));throw Error('save failed');},pause:async()=>{calls.push('pause');},error:error=>calls.push(String(error))});
  controller.start('brand.ico');
  const item=(label:string)=>items.find(i=>i.label===label);
  item('后台任务').click();item('设置').click();
  assert.deepEqual(calls,['show','focus','tasks','show','focus','settings']);
  assert.equal(item('暂停正在运行的任务').enabled,false);
  controller.update({power:{enabled:true,active:false,error:null},canPause:true});
  assert.equal(item('关闭任务防休眠').type,'normal');
  item('关闭任务防休眠').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(calls.some(c=>c.includes('save failed')));
  item('暂停正在运行的任务').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.at(-1),'pause');
  items.find(i=>i.label==='关闭任务防休眠').label='wrong optimistic text';
  controller.update({power:{enabled:true,active:false,error:null},canPause:true},true);
  assert.equal(item('关闭任务防休眠').type,'normal','force refresh reverts native optimistic checkbox even when state is unchanged');
  controller.close();
});
test("dev and packaged icon paths point at the shipped brand resource", () => {
  assert.equal(
    trayIconPath(false, "R", "A"),
    path.join("A", "resources", "branding", "image-finder.ico"),
  );
  assert.equal(
    trayIconPath(true, "R", "A"),
    path.join("R", "branding", "image-finder.ico"),
  );
});

import { validateInvocation } from "../src/bridge.js";
test("tray status is a strictly empty read-only main invocation", () => {
  validateInvocation("tray.status", {});
  assert.throws(() => validateInvocation("tray.status", { path: "x" }));
});
