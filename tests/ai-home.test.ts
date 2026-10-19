import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
  stat,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  migrateAiHome,
  AI_HOME_MARKER,
  AI_HOME_OWNERSHIP,
} from "../src/core/ai-home.js";
import { Catalog } from "../src/core/catalog.js";
import { LocalAi, AI_MODELS } from "../src/core/ai.js";
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-ai-location-"));
  const home = path.join(dir, "old-runtime");
  await mkdir(path.join(home, "python"), { recursive: true });
  await writeFile(path.join(home, "python", "python.exe"), "python-fixture");
  await writeFile(
    path.join(home, "wd-translations.json"),
    JSON.stringify({ tags: { blue_hair: "蓝发" } }),
  );
  const marker: any = {
    format: 1,
    preprocess: "clip-rgba-white-bicubic-square224-meanstd-v2",
    files: {},
  };
  for (const kind of ["wd", "semantic"] as const) {
    await mkdir(path.join(home, "models", kind), { recursive: true });
    marker.files[kind] = {};
    for (const file of AI_MODELS[kind].files) {
      await writeFile(path.join(home, "models", kind, file), "model-fixture");
      marker.files[kind][file] = {
        bytes: 13,
        sha256: createHash("sha256").update("model-fixture").digest("hex"),
      };
    }
  }
  await writeFile(path.join(home, "models-ready.json"), JSON.stringify(marker));
  return {
    dir,
    home,
    pref: path.join(dir, "profile", "ai-location.json"),
    target: path.join(dir, ".image-finder-ai"),
  };
}
test("AI home copies and verifies resources, preserves source/unknown files, persists and reuses a previous managed copy", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.home, "unrelated.txt"), "keep");
    const result = await migrateAiHome(f.home, f.target, f.pref);
    assert.equal(result.sourceRetained, true);
    assert.ok(result.copiedBytes > 0);
    assert.equal(
      await readFile(path.join(f.home, "python", "python.exe"), "utf8"),
      "python-fixture",
    );
    assert.equal(
      await readFile(path.join(f.target, AI_HOME_MARKER), "utf8"),
      AI_HOME_OWNERSHIP,
    );
    assert.equal(
      JSON.parse(await readFile(f.pref, "utf8")).directory,
      f.target,
    );
    assert.ok(!(await readdir(f.target)).includes("unrelated.txt"));
    const again = await migrateAiHome(f.home, f.target, f.pref);
    assert.equal(again.copiedBytes, 0);
    assert.ok(again.reusedBytes > 0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("AI home rejects unknown existing contents, overlaps, conflicting resource versions and links without changing preferences/source", async () => {
  const f = await fixture();
  try {
    await mkdir(f.target);
    await writeFile(path.join(f.target, "personal.txt"), "keep");
    await assert.rejects(migrateAiHome(f.home, f.target, f.pref), /非本程序/);
    assert.equal(
      await readFile(path.join(f.target, "personal.txt"), "utf8"),
      "keep",
    );
    await rm(path.join(f.target, "personal.txt"));
    await writeFile(path.join(f.target, AI_HOME_MARKER), AI_HOME_OWNERSHIP);
    await mkdir(path.join(f.target, "python"));
    await writeFile(path.join(f.target, "python", "python.exe"), "different");
    await assert.rejects(migrateAiHome(f.home, f.target, f.pref), /不同版本/);
    assert.equal(
      await readFile(path.join(f.target, "python", "python.exe"), "utf8"),
      "different",
    );
    await assert.rejects(
      migrateAiHome(f.home, path.join(f.home, ".image-finder-ai"), f.pref),
      /互相包含/,
    );
    await assert.rejects(
      migrateAiHome(f.home, f.target, f.pref, [f.target]),
      /原图根/,
    );
    await rm(f.target, { recursive: true });
    await symlink(f.home, f.target, "junction");
    await assert.rejects(migrateAiHome(f.home, f.target, f.pref), /链接/);
    assert.equal(
      await readFile(path.join(f.home, "python", "python.exe"), "utf8"),
      "python-fixture",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("failed atomic preference commit rolls back copied files and keeps the prior JSON/environment", async () => {
  const f = await fixture();
  try {
    await mkdir(f.pref, { recursive: true });
    await writeFile(path.join(f.pref, "previous.json"), '{"old":true}');
    await assert.rejects(migrateAiHome(f.home, f.target, f.pref));
    assert.equal(
      await readFile(path.join(f.pref, "previous.json"), "utf8"),
      '{"old":true}',
    );
    assert.deepEqual(await readdir(f.target), []);
    assert.equal(
      await readFile(path.join(f.home, "python", "python.exe"), "utf8"),
      "python-fixture",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("LocalAi switches home/python/worker factory and dictionary together; restart uses saved home and busy refusal does not lock", async () => {
  const f = await fixture();
  const c = new Catalog(path.join(f.dir, "catalog"));
  const runtimes: string[] = [];
  const factory = (home: string, python: () => string) => {
    runtimes.push(home);
    return {
      run: async () => ({
        elapsedMs: 1,
        providers: [home, python()],
        candidates: [],
      }),
      close() {},
    };
  };
  const ai = new LocalAi(c, { home: f.home, runtimeFactory: factory });
  try {
    const before = c.db.prepare("SELECT * FROM ai_reviews").all();
    await ai.configureHome(f.target, f.pref);
    assert.equal(ai.home, f.target);
    assert.equal(ai.python, path.join(f.target, "python", "python.exe"));
    assert.deepEqual(runtimes, [f.home, f.target]);
    const originals = path.join(f.dir, "inference-originals");
    await mkdir(originals);
    await writeFile(path.join(originals, "sample.jpg"), "image");
    const root = c.addRoot(originals),
      info = await stat(path.join(originals, "sample.jpg"));
    c.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at)VALUES('new-home-file',?,'sample.jpg',5,?,1)",
      )
      .run(root.id, info.mtimeMs);
    await ai.runCurrent("new-home-file");
    assert.deepEqual(
      JSON.parse(
        (
          c.db
            .prepare(
              "SELECT providers FROM ai_runs WHERE file_id='new-home-file'",
            )
            .get() as any
        ).providers,
      ),
      [f.target, path.join(f.target, "python", "python.exe")],
    );

    assert.equal(ai.status().maintenance, false);
    assert.ok(ai.status().models.every((x) => x.ready));
    assert.deepEqual(c.db.prepare("SELECT * FROM ai_reviews").all(), before);
    await ai.prepareCleanup();
    await assert.rejects(
      ai.configureHome(f.target, f.pref),
      /BUSY|MAINTENANCE/,
    );
    ai.finishCleanup();
    assert.doesNotThrow(() => ai.configure({ generalThreshold: 0.55 }));
    const restarted = new LocalAi(c, {
      home: JSON.parse(await readFile(f.pref, "utf8")).directory,
      runtimeFactory: factory,
    });
    assert.equal(restarted.home, f.target);
    assert.ok(restarted.status().models.every((x) => x.ready));
    await restarted.close();
  } finally {
    await ai.close();
    c.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("active inference, runnable queues and installing dependencies refuse migration; refusal releases no unrelated state", async () => {
  const f = await fixture();
  const c = new Catalog(path.join(f.dir, "catalog"));
  let release!: () => void, entered!: () => void;
  const running = new Promise<void>((resolve) => (entered = resolve)),
    hold = new Promise<void>((resolve) => (release = resolve));
  const ai = new LocalAi(c, {
    home: f.home,
    runtime: {
      run: async () => {
        entered();
        await hold;
        return { elapsedMs: 1, providers: ["fixture"], candidates: [] };
      },
      close() {},
    },
  });
  try {
    const originals = path.join(f.dir, "originals");
    await mkdir(originals);
    await writeFile(path.join(originals, "sample.jpg"), "image");
    const root = c.addRoot(originals),
      info = await stat(path.join(originals, "sample.jpg"));
    c.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at)VALUES('file',?,'sample.jpg',5,?,1)",
      )
      .run(root.id, info.mtimeMs);
    const work = ai.runCurrent("file");
    await running;
    await assert.rejects(ai.configureHome(f.target, f.pref), /BUSY/);
    assert.equal(ai.home, f.home);
    release();
    await work;
    c.db.exec(
      "INSERT OR REPLACE INTO ai_jobs VALUES('wd','file','waiting',0,NULL,1);UPDATE ai_state SET paused=0 WHERE kind='wd'",
    );
    await assert.rejects(ai.configureHome(f.target, f.pref), /BUSY/);
    c.db.exec("UPDATE ai_state SET paused=1");
    await writeFile(
      path.join(f.home, "ai-install.mjs"),
      "setTimeout(()=>process.exit(0),300)",
    );
    ai.install();
    await assert.rejects(ai.configureHome(f.target, f.pref), /BUSY/);
    const deadline = Date.now() + 5000;
    while (ai.status().install.running && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(ai.status().install.running, false);
    assert.equal(ai.status().maintenance, false);
    await assert.rejects(
      ai.configureHome(path.join(f.dir, "bad-leaf"), f.pref),
      /专用/,
    );
    assert.equal(ai.status().maintenance, false);
    assert.doesNotThrow(() => ai.configure({ generalThreshold: 0.55 }));
  } finally {
    release?.();
    await ai.close();
    c.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("unavailable custom-home bootstrap flag never creates or populates the selected directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finder-ai-offline-")),
    home = path.join(dir, "missing-ai-home"),
    c = new Catalog(path.join(dir, "catalog"));
  const previous = process.env.IMAGE_FINDER_AI_BOOTSTRAP_DISABLED;
  process.env.IMAGE_FINDER_AI_BOOTSTRAP_DISABLED = "1";
  const ai = new LocalAi(c, {
    home,
    runtime: {
      run: async () => ({ elapsedMs: 0, providers: [], candidates: [] }),
      close() {},
    },
  });
  try {
    assert.equal(ai.home, home);
    assert.ok(ai.status().models.every((x) => !x.ready));
    assert.throws(() => ai.install(), /AI_HOME_UNAVAILABLE/);
    await assert.rejects(
      ai.configureHome(
        path.join(dir, ".image-finder-ai"),
        path.join(dir, "preferences.json"),
      ),
      /AI_HOME_UNAVAILABLE/,
    );
    await assert.rejects(readdir(home), { code: "ENOENT" });
  } finally {
    await ai.close();
    c.close();
    if (previous === undefined)
      delete process.env.IMAGE_FINDER_AI_BOOTSTRAP_DISABLED;
    else process.env.IMAGE_FINDER_AI_BOOTSTRAP_DISABLED = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
test(
  "Windows readonly existing preference refuses atomic commit and preserves its exact old JSON",
  { skip: process.platform !== "win32" },
  async () => {
    const f = await fixture();
    try {
      await mkdir(path.dirname(f.pref));
      const old = JSON.stringify({ schema: 1, directory: f.home });
      await writeFile(f.pref, old);
      await chmod(f.pref, 0o444);
      await assert.rejects(migrateAiHome(f.home, f.target, f.pref));
      assert.equal(await readFile(f.pref, "utf8"), old);
      assert.deepEqual(await readdir(f.target), []);
      assert.equal(
        await readFile(path.join(f.home, "python", "python.exe"), "utf8"),
        "python-fixture",
      );
    } finally {
      await chmod(f.pref, 0o666).catch(() => {});
      await rm(f.dir, { recursive: true, force: true });
    }
  },
);
