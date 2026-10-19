import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, writeFile, symlink, access } from "node:fs/promises";
import { AiEnvironment, markManagedAiHome } from "../src/electron/ai-environment.js";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "image-finder-environment-"));
  const home = path.join(base, "profile", "ai-runtime");
  const catalog = path.join(base, "catalog");
  await mkdir(catalog);
  await markManagedAiHome(home, home);
  return { base, home, environment: new AiEnvironment(home, home, catalog) };
}
test("managed cleanup removes only runtime assets and leaves bootstrap, metadata, unrelated files and original images intact", async () => {
  const { base, home, environment } = await fixture();
  await mkdir(path.join(home, "models", "wd"), { recursive: true });
  await mkdir(path.join(home, "python"));
  await writeFile(path.join(home, "models", "wd", "model.onnx"), "model");
  await writeFile(path.join(home, "python", "python.exe"), "python");
  await writeFile(path.join(home, "models-ready.json"), "marker");
  await writeFile(path.join(home, "pip.whl.part"), "cache");
  await writeFile(path.join(home, "ai-install.mjs"), "bootstrap");
  await writeFile(path.join(home, "user-note.txt"), "keep");
  const original = path.join(base, "original.png");
  await writeFile(original, "original");
  const before = await environment.inspect();
  assert.equal(before.cleanupSupported, true);
  assert.equal(before.bytes, 22);
  assert.deepEqual(await environment.clear(), { clearedBytes: 22 });
  await assert.rejects(access(path.join(home, "models")));
  assert.equal(await readFile(path.join(home, "ai-install.mjs"), "utf8"), "bootstrap");
  assert.equal(await readFile(path.join(home, "user-note.txt"), "utf8"), "keep");
  assert.equal(await readFile(original, "utf8"), "original");
  assert.equal((await environment.inspect()).cleanupSupported, true);
});
test("cleanup refuses external, unowned, catalogue-overlapping and image-root-overlapping paths", async () => {
  const { base, home, environment } = await fixture();
  const external = new AiEnvironment(home, path.join(base, "other"), base);
  assert.equal((await external.inspect()).cleanupSupported, false);
  assert.equal((await external.inspect()).error, null);
  await assert.rejects(external.clear(), /随程序自带或外部配置/);
  await writeFile(path.join(home, ".image-finder-managed.json"), "invalid");
  assert.equal((await environment.inspect()).cleanupSupported, false);
  await writeFile(path.join(home, ".image-finder-managed.json"), '{"appId":"local.imagefinder.app","schema":1}\n');
  assert.equal((await new AiEnvironment(home, home, home).inspect()).cleanupSupported, false);
  assert.equal((await environment.inspect([base])).cleanupSupported, false);
  await assert.rejects(environment.clear([home]), /重叠/);
});
test("cleanup refuses junctions inside the runtime and does not touch their targets", async () => {
  const { base, home, environment } = await fixture();
  const outside = path.join(base, "originals");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.png"), "keep");
  await symlink(outside, path.join(home, "models"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await environment.inspect()).cleanupSupported, false);
  await assert.rejects(environment.clear(), /链接/);
  assert.equal(await readFile(path.join(outside, "keep.png"), "utf8"), "keep");
});
test("managed ownership cannot be established through a junction used as the runtime root", async () => {
  const { base, home } = await fixture();
  const alias = path.join(base, "linked-runtime");
  await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(markManagedAiHome(alias, alias), /链接/);
  const environment = new AiEnvironment(alias, alias, path.join(base, "catalog"));
  assert.equal((await environment.inspect()).cleanupSupported, false);
  await assert.rejects(environment.clear(), /链接/);
});
