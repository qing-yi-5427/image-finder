import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { readAiHomePreferences } from "../src/electron/ai-preferences.js";
test("AI location remains unconfigured when absent and accepts an absolute dedicated leaf", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "image-finder-ai-preferences-"));
  const file = path.join(directory, "ai-location.json");
  assert.deepEqual(await readAiHomePreferences(file), { directory: undefined, configurationError: null });
  const selected = path.join(directory, "selected", ".image-finder-ai");
  await writeFile(file, JSON.stringify({ schema: 1, directory: selected }));
  assert.deepEqual(await readAiHomePreferences(file), { directory: selected, configurationError: null });
});
test("corrupt, relative and general-purpose AI location preferences are warned about without rewriting the file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "image-finder-ai-preferences-"));
  const file = path.join(directory, "ai-location.json");
  for (const content of ["{broken", JSON.stringify({ schema: 1, directory }), JSON.stringify({ schema: 1, directory: "relative/.image-finder-ai" })]) {
    await writeFile(file, content);
    const result = await readAiHomePreferences(file);
    assert.equal(result.directory, undefined);
    assert.match(result.configurationError!, /设置/);
    assert.equal(await readFile(file, "utf8"), content);
  }
});
