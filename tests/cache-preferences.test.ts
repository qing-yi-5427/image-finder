import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { readCachePreferences } from "../src/electron/cache-preferences.js";

test("cache preferences use the profile default when absent and accept only an absolute dedicated leaf", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "image-finder-cache-preferences-"));
  const file = path.join(base, "cache-location.json");
  const fallback = path.join(base, "profile", ".image-finder-cache");
  assert.deepEqual(await readCachePreferences(file, fallback), { directory: fallback, configurationError: undefined });
  const selected = path.join(base, "selected", ".image-finder-cache");
  await writeFile(file, JSON.stringify({ schema: 1, directory: selected }));
  assert.deepEqual(await readCachePreferences(file, fallback), { directory: selected, configurationError: undefined });
});
test("corrupt or unsafe cache preferences remain untouched and surface a visible fallback warning", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "image-finder-cache-preferences-"));
  const file = path.join(base, "cache-location.json");
  const fallback = path.join(base, "profile", ".image-finder-cache");
  for (const content of ["{broken", JSON.stringify({ schema: 1, directory: "relative/.image-finder-cache" }), JSON.stringify({ schema: 1, directory: base }), JSON.stringify({ schema: 2, directory: fallback })]) {
    await writeFile(file, content);
    const result = await readCachePreferences(file, fallback);
    assert.equal(result.directory, fallback);
    assert.match(result.configurationError!, /设置/);
    assert.equal(await readFile(file, "utf8"), content);
  }
});
