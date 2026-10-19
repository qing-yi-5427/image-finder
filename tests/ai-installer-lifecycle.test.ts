import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Catalog } from "../src/core/catalog.js";
import { LocalAi } from "../src/core/ai.js";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
test(
  "closing AI waits for the owned Windows installer tree and leaves an unrelated process running",
  { skip: process.platform !== "win32" },
  async () => {
    const base = await mkdtemp(path.join(tmpdir(), "finder-install-tree-"));
    const ready = path.join(base, "descendant.pid");
    const catalog = new Catalog(path.join(base, "data"));
    const ai = new LocalAi(catalog, { home: path.join(base, "runtime") });
    const options = {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore" as const,
    };
    const descendantCode = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
    const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{windowsHide:true,env:process.env,stdio:'ignore'});setInterval(()=>{},1000);`;
    const owned = spawn(process.execPath, ["-e", parentCode], options);
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      options,
    );
    (ai as any).installer = owned;
    let descendant = 0;
    try {
      for (let i = 0; i < 100 && !descendant; i++) {
        try {
          descendant = Number(await readFile(ready, "utf8"));
        } catch {}
        if (!descendant)
          await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(descendant > 0, "owned installer descendant started");
      assert.ok(alive(owned.pid!));
      assert.ok(alive(descendant));
      await ai.close();
      for (let i = 0; i < 50 && (alive(owned.pid!) || alive(descendant)); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(alive(owned.pid!), false);
      assert.equal(alive(descendant), false);
      assert.equal(alive(unrelated.pid!), true);
    } finally {
      await ai.close();
      owned.kill();
      unrelated.kill();
      if (descendant && alive(descendant))
        try {
          process.kill(descendant);
        } catch {}
      catalog.close();
    }
  },
);
