import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskPowerGuard } from "../src/electron/task-power.js";
import { TaskPowerPreference } from "../src/electron/task-power-preference.js";
import { validateInvocation } from "../src/bridge.js";
function fixture() {
  const calls: string[] = [];
  let serial = 0;
  const guard = new TaskPowerGuard({
    start: () => {
      calls.push("start");
      return serial++;
    },
    stop: () => {
      calls.push("stop");
    },
  });
  return { calls, guard };
}
test("missing old preference defaults off and active polling never causes a transient blocker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "power-pref-"));
  try {
    const f = fixture();
    const p = new TaskPowerPreference(
      path.join(dir, "task-power.json"),
      f.guard,
    );
    p.update(true);
    assert.deepEqual(await p.initialize(), {
      enabled: false,
      active: false,
      error: null,
    });
    p.update(true);
    assert.deepEqual(f.calls, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("enable follows real work; disable releases immediately, persists and remains off on restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "power-pref-"));
  try {
    const file = path.join(dir, "task-power.json");
    const f = fixture();
    const p = new TaskPowerPreference(file, f.guard);
    await p.initialize();
    await p.setEnabled(true);
    assert.equal(p.status().active, false);
    p.update(true);
    p.update(true);
    assert.deepEqual(f.calls, ["start"]);
    const saving = p.setEnabled(false);
    assert.equal(p.status().active, false);
    assert.deepEqual(f.calls, ["start", "stop"]);
    p.update(true);
    await saving;
    assert.equal(JSON.parse(await readFile(file, "utf8")).enabled, false);
    const next = fixture();
    const restarted = new TaskPowerPreference(file, next.guard);
    restarted.update(true);
    await restarted.initialize();
    assert.deepEqual(next.calls, []);
    assert.equal(restarted.status().enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("persisted enable survives restart, but blocks only after work and releases at idle/protective pause", async () => {
  const f = fixture();
  const p = new TaskPowerPreference("unused", f.guard, {
    read: async () => '{"enabled":true}',
  });
  await p.initialize();
  assert.equal(p.status().enabled, true);
  assert.equal(p.status().active, false);
  p.update(true);
  p.update(false);
  p.update(true);
  assert.deepEqual(f.calls, ["start", "stop", "start"]);
  f.guard.close();
});
test("pending older enable and task poll cannot override a newer disable", async () => {
  const f = fixture();
  let release!: () => void;
  let begun!: () => void;
  const begin = new Promise<void>((r) => (begun = r));
  let n = 0;
  const p = new TaskPowerPreference("unused", f.guard, {
    read: async () => '{"enabled":false}',
    save: async () => {
      if (++n === 1) {
        begun();
        await new Promise<void>((r) => (release = r));
      }
    },
  });
  await p.initialize();
  p.update(true);
  const on = p.setEnabled(true);
  await begin;
  const off = p.setEnabled(false);
  p.update(true);
  release();
  await on;
  await off;
  assert.deepEqual(f.calls, []);
  assert.equal(p.status().enabled, false);
});
test("corrupt load and failed save stay safely off and surface a useful error", async () => {
  const f = fixture();
  const p = new TaskPowerPreference("unused", f.guard, {
    read: async () => "{bad",
    save: async () => {
      throw new Error("disk denied");
    },
  });
  p.update(true);
  assert.equal((await p.initialize()).enabled, false);
  assert.ok(p.status().error);
  await assert.rejects(p.setEnabled(true), /保存失败/);
  assert.equal(p.status().active, false);
  assert.deepEqual(f.calls, []);
});
test("power IPC accepts only an explicit boolean and no native path or arbitrary setting", () => {
  validateInvocation("power.get", {});
  validateInvocation("power.set", { enabled: false });
  for (const payload of [
    {},
    { enabled: "false" },
    { enabled: true, path: "x" },
    { enabled: true, value: 1 },
  ])
    assert.throws(() => validateInvocation("power.set", payload));
});
