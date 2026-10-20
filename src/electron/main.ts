import { AppTray, trayIconPath } from "./tray.js";
import { NativeFileDrag } from "./file-drag.js";
import { AiEnvironment, markManagedAiHome, isOwnedAiHome } from "./ai-environment.js";
import { readAiHomePreferences } from "./ai-preferences.js";
import { readCachePreferences } from "./cache-preferences.js";
import { CacheOperationGate } from "./cache-gate.js";
import { trayPauseActions, type TrayTaskSnapshot } from "./tray-actions.js";
import { TaskPowerPreference } from "./task-power-preference.js";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  shell,
  clipboard,
  powerSaveBlocker,
  Tray,
  Menu,
  nativeImage,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { mkdtemp, writeFile, realpath, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { validateInvocation, boundSourceUrl } from "../bridge.js";
import { SauceNetwork } from "./sauce-network.js";
import { SourceNetwork } from "./network.js";
import { ServiceHost } from "./service-host.js";
import { FileActions, copyWindowsFiles } from "./file-actions.js";
import { TaskPowerGuard, tasksNeedAwake } from "./task-power.js";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "image-finder",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let host: ServiceHost;
let quitting = false;
let mainWindow: BrowserWindow | undefined;
const taskPower = new TaskPowerGuard(powerSaveBlocker);
const appTray = new AppTray({
  create: (icon) => new Tray(icon),
  menu: (items) => Menu.buildFromTemplate(items),
  window: () => mainWindow,
  quit: () => app.quit(),
});
app.on("will-quit", () => appTray.close());
app.on("will-quit", () => taskPower.close());
// Acquire before any catalog/service is opened: a second normal window must not
// reset another process's in-flight jobs or spend its persisted source budget.
// Disposable smoke runs have their own temporary data directory below.
const isolatedSmoke =
  process.argv.includes("--smoke") || process.argv.includes("--source-check");
const ownsInstance = isolatedSmoke || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
if (!isolatedSmoke && ownsInstance)
  app.on("second-instance", () => {
    const existing =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    }
  });
void app.whenReady().then(async () => {
  if (!ownsInstance) return;
  const sourceCheck = process.argv.includes("--source-check");
  const smoke = process.argv.includes("--smoke") || sourceCheck;
  const sourceEvidence: any[] = [];
  const configuredDataDir =
    process.argv
      .find((arg) => arg.startsWith("--data-dir="))
      ?.slice("--data-dir=".length) ?? process.env.IMAGE_FINDER_DATA_DIR;
  const dataDir = smoke
    ? await mkdtemp(join(tmpdir(), "image-finder-smoke-"))
    : configuredDataDir
      ? resolve(configuredDataDir)
      : join(app.getPath("userData"), "catalog");
  await mkdir(dataDir, { recursive: true });
  const powerPreference = new TaskPowerPreference(
    join(app.getPath("userData"), "task-power.json"),
    taskPower,
  );
  await powerPreference.initialize();
  const sendPower = () => {
    if(mainWindow && !mainWindow.isDestroyed())mainWindow.webContents.send("image-finder:app-event",{type:"power",status:powerPreference.status()});
  };
  let trayCanPause = false;
  const syncTray = (force=false) => {appTray.update({power:powerPreference.status(),canPause:trayCanPause},force);sendPower();};
  const setPower = async (enabled:boolean) => {try{return await powerPreference.setEnabled(enabled);}finally{syncTray(true);}};
  const aiHomePreferenceFile = join(app.getPath("userData"), "ai-location.json");
  const aiHomePreference = await readAiHomePreferences(aiHomePreferenceFile);
  const inheritedAiHome = process.env.IMAGE_FINDER_AI_HOME;
  const defaultManagedAiHome = join(app.getPath("userData"), "ai-runtime");
  let expectedManagedAiHome = inheritedAiHome ? defaultManagedAiHome : aiHomePreference.directory ?? defaultManagedAiHome;
  let aiLocationWarning = inheritedAiHome ? null : aiHomePreference.configurationError;
  if (!inheritedAiHome && aiHomePreference.directory) {
    process.env.IMAGE_FINDER_AI_HOME = aiHomePreference.directory;
    if (!await isOwnedAiHome(aiHomePreference.directory)) {
      process.env.IMAGE_FINDER_AI_BOOTSTRAP_DISABLED = "1";
      aiLocationWarning = "配置的 AI 环境位置不可用或管理标记无效，未自动切换或写入其他目录；请检查原位置，重新连接后重启应用。";
    }
  }
  if (app.isPackaged && !inheritedAiHome) {
    const bundled = join(process.resourcesPath, "ai-runtime");
    const offline = [
      "models/wd/model.onnx", "models/wd/selected_tags.csv",
      "models/semantic/image.onnx", "models/semantic/text.onnx",
      "models/semantic/vocab.txt", "models-ready.json",
    ].every((file) => existsSync(join(bundled, file))) && (
      existsSync(join(bundled, "python", "python.exe")) ||
      existsSync(join(bundled, "python", "cpython-3.12.13-windows-x86_64-none", "python.exe"))
    );
    const aiHome = aiHomePreference.directory ?? (offline ? bundled : defaultManagedAiHome);
    if (aiHome !== bundled && process.env.IMAGE_FINDER_AI_BOOTSTRAP_DISABLED !== "1") {
      try {
        await mkdir(aiHome, { recursive: true });
        await cp(bundled, aiHome, { recursive: true, force: false });
        // Refresh bundled helpers on application upgrades; preserve downloaded models.
        for (const name of ["ai-install.mjs", "ai-download.mjs", "ai-manifest.json", "ai-worker.py", "ai-export.py", "ai-verify.py", "ai-translation.py"])
          await cp(join(bundled, name), join(aiHome, name), { force: true });
        if (!aiHomePreference.directory) await markManagedAiHome(aiHome, defaultManagedAiHome);
      } catch {
        process.env.IMAGE_FINDER_AI_BOOTSTRAP_DISABLED = "1";
        aiLocationWarning = "AI 环境目录不可写或资源不可用，已保留当前配置；请检查磁盘与目录权限后重启应用。";
      }
    }
    process.env.IMAGE_FINDER_AI_HOME = aiHome;
  }
  const sourceNetwork = new SourceNetwork(
    dataDir,
    smoke ? "image-finder-smoke" : "persist:image-finder-pixiv",
  );
  await sourceNetwork.initialize();
  const sauceNetwork = new SauceNetwork(dataDir);
  await sauceNetwork.initialize();
  const cacheProfileDirectory = smoke
    ? await mkdtemp(join(tmpdir(), "image-finder-smoke-cache-profile-"))
    : app.getPath("userData");
  const cachePreferenceFile = join(cacheProfileDirectory, "cache-location.json");
  const cachePreference = await readCachePreferences(cachePreferenceFile, join(cacheProfileDirectory, ".image-finder-cache"));
  host = new ServiceHost(
    dataDir,
    async (url) => {
      if (sourceCheck && sourceEvidence.length >= 2)
        throw new Error("Source check request budget reached");
      const item: any = {
        id: new URL(url).pathname.split("/").at(-1),
        startedAt: Date.now(),
      };
      if (sourceCheck) sourceEvidence.push(item);
      try {
        const result = await sourceNetwork.request(url);
        if (sourceCheck) {
          item.http = result.status;
          try {
            const json = JSON.parse(result.body);
            item.returnedId = String(
              json.body?.illustId ?? json.body?.id ?? "",
            );
            item.tagCount = json.body?.tags?.tags?.length ?? 0;
            item.sourceError = !!json.error;
          } catch {
            item.parseError = true;
          }
        }
        return result;
      } catch (error) {
        item.error = "Official source network unavailable";
        throw error;
      }
    },
    {
      startPaused: process.argv.includes("--start-paused"),
      cachePreferenceFile,
      aiHomePreferenceFile,
      sauceRequest: (preview) => sauceNetwork.request(preview),
    },
  );
  await host.invoke("cache.initialize", cachePreference);
  const rendererPath = fileURLToPath(
    new URL("../../renderer/index.html", import.meta.url),
  );
  const rendererUrl = pathToFileURL(rendererPath).href;
  const fileDrag = new NativeFileDrag({resolve:async fileId=>(await host.invoke("images.resolve",{fileId,variant:"original"})).path,start:files=>mainWindow!.webContents.startDrag({file:files[0],files,icon:nativeImage.createFromPath(trayIconPath(app.isPackaged,process.resourcesPath,app.getAppPath())).resize({width:32,height:32})})});
  const fileActions = new FileActions({
    invoke: (method, payload) => host.invoke(method, payload),
    copyFiles: copyWindowsFiles,
    copyText: (text) => clipboard.writeText(text),
    openPath: (path) => shell.openPath(path),
    reveal: (path) => shell.showItemInFolder(path),
    trash: (path) => shell.trashItem(path),
    confirmTrash: async (count, failed) =>
      (
        await dialog.showMessageBox(window, {
          type: "warning",
          title: "移到回收站",
          message: `将 ${count} 个原文件移到系统回收站？`,
          detail: `收藏、评分和标签会保留。可在 Windows 回收站恢复原文件。${failed ? `另有 ${failed} 个文件不可用，将跳过。` : ""}`,
          buttons: ["取消", `移到回收站（${count} 个文件）`],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      ).response === 1,
  });
  let aiCleaning = false;
  const cacheGate = new CacheOperationGate();
  ipcMain.handle("image-finder:invoke", async (event, method, payload = {}) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== rendererUrl ||
      event.sender.getURL() !== rendererUrl
    )
      throw new Error("Unauthorized sender");
    if (["library.add", "library.relocate"].includes(method)) {
      validateInvocation(
        method,
        { ...payload, directory: "host" },
        { privileged: true },
      );
      const selected = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (selected.canceled) return null;
      payload = { ...payload, directory: selected.filePaths[0] };
    } else if (["system.restore", "sauce.importLedger"].includes(method)) {
      validateInvocation(
        method,
        { ...payload, source: "host" },
        { privileged: true },
      );
      const selected = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters:
          method === "sauce.importLedger"
            ? [{ name: "SauceNAO 结果", extensions: ["json"] }]
            : [{ name: "SQLite backup", extensions: ["sqlite", "db"] }],
      });
      if (selected.canceled) return null;
      payload = { ...payload, source: selected.filePaths[0] };
    } else if (["system.backup", "system.export"].includes(method)) {
      validateInvocation(
        method,
        { ...payload, destination: "host" },
        { privileged: true },
      );
      const selected = await dialog.showSaveDialog({
        defaultPath:
          method === "system.backup" ? "catalog.sqlite" : "catalog.json",
      });
      if (selected.canceled || !selected.filePath) return null;
      payload = { ...payload, destination: selected.filePath };
    } else validateInvocation(method, payload);
    if (method === "cache.select") {
      const selected = await dialog.showOpenDialog(window, {
        title: "选择缓存存放位置（将在所选目录下创建独立隐藏缓存文件夹）",
        properties: ["openDirectory"],
      });
      if (selected.canceled || !selected.filePaths[0]) return null;
      const directory = join(await realpath(selected.filePaths[0]), ".image-finder-cache");
      return cacheGate.change(() => host.invoke("cache.configure", { directory }));
    }
    if (aiCleaning && method.startsWith("ai.") && !["ai.status", "ai.progress", "ai.environment"].includes(method))
      throw new Error("AI 环境正在维护，请稍后重试");
    if (aiCleaning && ["library.add", "library.relocate"].includes(method))
      throw new Error("AI 环境正在维护，请稍后调整图库目录");
    if (method === "ai.environmentSelect") {
      aiCleaning = true;
      try {
        const selected = await dialog.showOpenDialog(window, {
          title: "选择 AI 环境存放位置（将在所选目录下创建独立隐藏文件夹）",
          properties: ["openDirectory"],
        });
        if (selected.canceled || !selected.filePaths[0]) return null;
        const result = await host.invoke("ai.configureHome", {
          directory: join(await realpath(selected.filePaths[0]), ".image-finder-ai"),
        });
        process.env.IMAGE_FINDER_AI_HOME = result.directory;
        delete process.env.IMAGE_FINDER_AI_BOOTSTRAP_DISABLED;
        expectedManagedAiHome = result.directory;
        aiLocationWarning = result.warning;
        return result;
      } finally { aiCleaning = false; }
    }
    if (["ai.environment", "ai.environmentClear"].includes(method)) {
      const clearing = method === "ai.environmentClear";
      if (clearing) aiCleaning = true;
      let prepared = false;
      try {
        const state = await host.invoke("ai.status", {});
        const environment = new AiEnvironment(state.home, expectedManagedAiHome, dataDir);
        const roots = await host.invoke("library.list", {});
        const protectedPaths = roots.map((root: any) => root.path);
        if (!clearing) {
          const result = await environment.inspect(protectedPaths);
          return { ...result, error: [result.error, aiLocationWarning].filter(Boolean).join("；") || null };
        }
        const allowed = await environment.inspect(protectedPaths);
        if (!allowed.cleanupSupported) throw new Error(allowed.error ?? "AI 环境不支持清理");
        await host.invoke("ai.prepareCleanup", {});
        prepared = true;
        return await environment.clear(protectedPaths);
      } finally {
        try { if (prepared) await host.invoke("ai.finishCleanup", {}); }
        finally { if (clearing) aiCleaning = false; }
      }
    }
    if (method === "tray.status") return { exists: appTray.exists };
    if (method === "app.version") return {version:app.getVersion(),packaged:app.isPackaged};
    if (method === "files.drag") return fileDrag.start(payload.fileIds);
    if (method === "power.get") return powerPreference.status();
    if (method === "power.set")
      return setPower(payload.enabled);
    if (method === "window.control") {
      if (payload.action === "minimize") window.minimize();
      else if (payload.action === "maximize")
        window.isMaximized() ? window.unmaximize() : window.maximize();
      else window.close();
      return;
    }
    if (
      ["files.reveal", "files.open", "files.copy", "files.trash"].includes(
        method,
      )
    )
      return fileActions.run(method, payload);
    if (method === "files.openSource") {
      const item = await host.invoke("files.detail", {
        fileId: payload.fileId,
      });
      await shell.openExternal(boundSourceUrl(item.artworkId));
      return;
    }
    if (method === "sauce.configure") {
      const result = await sauceNetwork.configure(payload.apiKey);
      await host.invoke("sauce.configure", { apiKey: "" });
      return result;
    }
    if (method === "sauce.status")
      return {
        ...(await host.invoke(method, payload)),
        ...sauceNetwork.status(),
      };
    if (method === "sauce.resume" && !sauceNetwork.status().configured)
      throw new Error("请先配置 SauceNAO API Key");
    if (method === "sauce.openCandidate") {
      const items = await host.invoke("sauce.list", { limit: 500 });
      const item = items.find((v: any) => v.fileId === payload.fileId);
      const candidate = item?.candidates.find(
        (v: any) => v.artworkId === payload.artworkId,
      );
      if (!candidate) throw new Error("候选不存在");
      await shell.openExternal(boundSourceUrl(candidate.artworkId));
      return;
    }
    if (method === "network.status") return sourceNetwork.status();
    if (method === "network.verify") return sourceNetwork.verify();
    if (method === "network.configure") return sourceNetwork.configure(payload);
    if (method === "network.connect") return sourceNetwork.connect();
    if (method === "network.logout") return sourceNetwork.logout();
    return host.invoke(method, payload);
  });
  protocol.handle("image-finder", (request) => cacheGate.read(async () => {
    try {
      const url = new URL(request.url);
      const fileId = decodeURIComponent(url.pathname.slice(1));
      if (url.hostname !== "image" || !fileId || fileId.includes("/"))
        return new Response(null, { status: 400 });
      const variant =
        url.searchParams.get("variant") === "original"
          ? "original"
          : "thumbnail";
      const item = await host.invoke("images.resolve", { fileId, variant });
      const resolved = await realpath(item.path);
      return await net.fetch(pathToFileURL(resolved).href);
    } catch {
      return new Response(null, { status: 404 });
    }
  }));
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    icon: trayIconPath(app.isPackaged, process.resourcesPath, app.getAppPath()),
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !smoke,
    },
  });
  mainWindow = window;
  const traySnapshot = async ():Promise<TrayTaskSnapshot> => {
    const [stats,pixiv,ai,sauce,danbooru] = await Promise.all([host.invoke("system.stats"),host.invoke("jobs.list",{limit:1}),host.invoke("ai.progress"),host.invoke("sauce.status"),host.invoke("danbooru.status")]);
    return {stats,pixiv,ai,sauce,danbooru};
  };
  appTray.configure({
    navigate: page => window.webContents.send("image-finder:app-event",{type:"navigate",page}),
    setPower: async enabled => {await setPower(enabled);},
    pause: async () => {
      const actions=trayPauseActions(await traySnapshot());
      const failures:string[]=[];
      for(const action of actions)try{await host.invoke(action.method as any,action.payload as any);}catch{failures.push(action.method);}
      trayCanPause=trayPauseActions(await traySnapshot()).length>0;syncTray();
      if(failures.length)throw new Error("部分后台任务暂停失败，请打开后台任务检查："+failures.join("、"));
    },
    error: error => {appTray.showWindow();void dialog.showMessageBox(window,{type:"error",title:"托盘操作失败",message:error instanceof Error?error.message:"操作失败，请打开后台任务或设置重试。"}).catch(()=>{});},
  });
  syncTray();
  appTray.start(
    trayIconPath(app.isPackaged, process.resourcesPath, app.getAppPath()),
  );
  let progressLoading = false;
  const progress = setInterval(() => {
    if (progressLoading || quitting) return;
    progressLoading = true;
    void host
      .invoke("system.stats")
      .then(async (status) => {
        const [pixiv, ai, sauce, danbooru] = await Promise.all([
          host.invoke("jobs.list", { limit: 1 }),
          host.invoke("ai.progress"),
          host.invoke("sauce.status"),
          host.invoke("danbooru.status"),
        ]);
        if (!quitting)
          powerPreference.update(
            tasksNeedAwake(status, pixiv, ai, sauce, danbooru),
          );
        trayCanPause=trayPauseActions({stats:status,pixiv,ai,sauce,danbooru}).length>0;
        syncTray();
        if (!window.isDestroyed())
          window.webContents.send("image-finder:progress", status);
      })
      .catch(() => {})
      .finally(() => { progressLoading = false; });
  }, 1000);
  window.on("closed", () => clearInterval(progress));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadFile(rendererPath);
  if (sourceCheck) {
    try {
      await host.invoke("jobs.enqueue", {
        artworkIds: ["81470181", "136130766"],
      });
      await host.invoke("jobs.resume");
      const deadline = Date.now() + 80000;
      while (Date.now() < deadline) {
        const jobs = await host.invoke("jobs.list");
        if (
          sourceEvidence.length === 2 &&
          jobs.items.every((j: any) => j.status !== "running")
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await host.invoke("jobs.pause");
      const persisted = await host.invoke("__sourceEvidence");
      const report = {
        ok:
          sourceEvidence.length === 2 &&
          persisted.jobs.every((j: any) => j.status === "done"),
        transport: "Electron isolated session -> worker queue",
        requests: sourceEvidence,
        persisted,
        dataDir,
      };
      await writeFile(
        join(dataDir, "source-summary.json"),
        JSON.stringify(report, null, 2),
      );
      console.log("SOURCE_SUMMARY " + JSON.stringify(report));
      await host.close();
      app.exit(report.ok ? 0 : 1);
    } catch (error) {
      console.error("Source check failed");
      app.exit(1);
    }
    return;
  }
  if (smoke) {
    try {
      const started = Date.now();
      const fixtureDir = await mkdtemp(
        join(tmpdir(), "image-finder-smoke-fixtures-"),
      );
      await writeFile(
        join(fixtureDir, "123_p0.png"),
        await (
          await import("sharp")
        )
          .default({
            create: {
              width: 2048,
              height: 2048,
              channels: 3,
              background: "#3366cc",
            },
          })
          .png()
          .toBuffer(),
      );
      await utimes(join(fixtureDir, "123_p0.png"), new Date(0), new Date(0));
      const root = await host.invoke("library.add", { directory: fixtureDir });
      await host.invoke("library.scan", { rootId: root.id });
      const rejected = await window.webContents.executeJavaScript(
        `window.imageFinder.invoke('files.rate',{fileIds:['x'],rating:99}).then(()=>false,()=>true)`,
      );
      let beats = 0;
      const timer = setInterval(() => beats++, 5);
      const processing = await host.invoke("images.processPending", {
        limit: 1,
      });
      const stats = await host.invoke("system.stats");
      const query = await host.invoke("files.query", {});
      clearInterval(timer);
      const renderer = await window.webContents.executeJavaScript(
        "typeof window.imageFinder.invoke + ':' + typeof require",
      );
      let productRenderer = false;
      const rendererDeadline = Date.now() + 12000;
      while (Date.now() < rendererDeadline) {
        productRenderer = await window.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-testid="image-finder-app"]')&&document.querySelector('.if-virtual-canvas')?.getAttribute('data-total')==='1'&&Array.from(document.querySelectorAll('.if-art img')).some(img=>img.naturalWidth>0))`,
        );
        if (productRenderer) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const productScreenshot = join(dataDir, "product-smoke.png");
      if (productRenderer) {
        await window.webContents.executeJavaScript(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        let captureError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await writeFile(
              productScreenshot,
              (
                await window.webContents.capturePage(undefined, {
                  stayAwake: true,
                })
              ).toPNG(),
            );
            captureError = null;
            break;
          } catch (error) {
            captureError = error;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (captureError) throw captureError;
      }
      window.minimize();
      await new Promise((resolve) => setTimeout(resolve, 100));
      appTray.showWindow();
      const trayRestored =
        appTray.exists && !window.isMinimized() && window.isVisible();
      const report = {
        tray: {
          exists: appTray.exists,
          restoredWindow: trayRestored,
          icon: trayIconPath(
            app.isPackaged,
            process.resourcesPath,
            app.getAppPath(),
          ),
        },
        ok:
          trayRestored &&
          rejected &&
          beats > 0 &&
          renderer === "function:undefined" &&
          productRenderer &&
          // The renderer may prepare this same thumbnail on demand before the
          // explicit worker call; validate the completed index in either order.
          processing.failed === 0 &&
          (processing.processed === 0 || processing.processed === 1) &&
          stats.features === 1 &&
          stats.local.images.ready === 1 &&
          stats.local.images.pending === 0 &&
          stats.local.images.failed === 0 &&
          query.total === 1 &&
          query.items[0]?.width === 2048 &&
          query.items[0]?.height === 2048,
        processing,
        stats,
        malformedIpcRejected: rejected,
        mainHeartbeat: beats,
        renderer,
        productRenderer,
        productScreenshot,
        elapsedMs: Date.now() - started,
        dataDir,
      };
      await writeFile(
        join(dataDir, "smoke-summary.json"),
        JSON.stringify(report, null, 2),
      );
      console.log("SMOKE_SUMMARY " + JSON.stringify(report));
      app.exit(report.ok ? 0 : 1);
    } catch (e) {
      console.error(e);
      app.exit(1);
    }
  }
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    appTray.close();
    taskPower.close();
    void sourceNetwork
      .close()
      .catch(() => {})
      .then(() => host.close())
      .finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
});
