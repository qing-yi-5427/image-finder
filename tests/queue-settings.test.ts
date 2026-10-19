import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/core/catalog.js";
import { PixivQueue } from "../src/core/queue.js";
import {
  DEFAULT_PIXIV_QUEUE_SETTINGS as defaults,
  validatePixivQueueSettings,
} from "../src/core/queue-settings.js";
import { validateInvocation } from "../src/bridge.js";

test("new catalogs use the selected automatic Pixiv cadence", () => {
  assert.deepEqual(defaults,{intervalMinSeconds:10,intervalMaxSeconds:15,batchLimit:200,autoRest:true,restMinutes:15});
});

function fixture(status = 404) {
  const dir = mkdtempSync(join(tmpdir(), "queue-settings-"));
  let catalog = new Catalog(dir),
    now = 1000000,
    calls = 0;
  const options = {
    now: () => now,
    random: () => 0.5,
    fetcher: async () => {
      calls++;
      return new Response(status === 200 ? "<html>challenge</html>" : "", {
        status,
        headers: { "retry-after": "1800" },
      });
    },
  };
  let queue = new PixivQueue(catalog, options);
  return {
    get queue() {
      return queue;
    },
    get calls() {
      return calls;
    },
    get now() {
      return now;
    },
    get catalog() {
      return catalog;
    },
    advance(ms: number) {
      now += ms;
    },
    async restart() {
      await queue.close();
      catalog.close();
      catalog = new Catalog(dir);
      queue = new PixivQueue(catalog, options);
      queue.start();
    },
    async close() {
      await queue.close();
      catalog.close();
      rmSync(dir, { recursive: true });
    },
  };
}

test("request settings enforce complete finite integer ranges at IPC and queue boundaries", async () => {
  validateInvocation("jobs.settings", {});
  validatePixivQueueSettings(defaults);
  for (const invalid of [
    { ...defaults, intervalMinSeconds: 0 },
    { ...defaults, intervalMaxSeconds: 3601 },
    { ...defaults, intervalMinSeconds: defaults.intervalMaxSeconds + 1 },
    { ...defaults, intervalMinSeconds: 1.5 },
    { ...defaults, batchLimit: 0 },
    { ...defaults, batchLimit: 10001 },
    { ...defaults, batchLimit: Infinity },
    { ...defaults, restMinutes: 0 },
    { ...defaults, restMinutes: 1441 },
    { ...defaults, restMinutes: "15" },
    { ...defaults, autoRest: 1 },
    { ...defaults, surprise: true },
    {},
    null,
    [],
  ]) {
    assert.throws(() => validatePixivQueueSettings(invalid));
    assert.throws(() => validateInvocation("jobs.configure", invalid));
  }
  for (const valid of [
    {
      ...defaults,
      intervalMinSeconds: 1,
      intervalMaxSeconds: 1,
      batchLimit: 1,
      restMinutes: 1,
    },
    {
      ...defaults,
      intervalMinSeconds: 3600,
      intervalMaxSeconds: 3600,
      batchLimit: 10000,
      restMinutes: 1440,
    },
  ])
    validateInvocation("jobs.configure", valid);
  const f = fixture();
  try {
    assert.throws(() => f.queue.configure({ ...defaults, batchLimit: NaN }));
    assert.deepEqual(f.queue.settings(), defaults);
    const settings = {
      ...defaults,
      intervalMinSeconds: 7,
      intervalMaxSeconds: 9,
      batchLimit: 6,
      autoRest: true,
      restMinutes: 4,
    };
    f.queue.configure(settings);
    await f.restart();
    assert.deepEqual(f.queue.settings(), settings);
    assert.equal(f.queue.sourceState().reason, "not_started");
  } finally {
    await f.close();
  }
});

test("configured cadence protects failures from dispatch and after request completion", async () => {
  const f = fixture();
  try {
    f.queue.configure({
      ...defaults,
      intervalMinSeconds: 2,
      intervalMaxSeconds: 4,
    });
    f.queue.enqueue(["12345", "12346"]);
    f.queue.resume();
    await f.queue.tick();
    assert.equal(f.queue.sourceState().pause_until, f.now + 3000);
    f.advance(2999);
    assert.equal(await f.queue.tick(), false);
    f.advance(1);
    await f.queue.tick();
    assert.equal(f.calls, 2);
  } finally {
    await f.close();
  }
});

test("batch rest deadline and used attempts survive restart and automatically reset only on deadline", async () => {
  const f = fixture();
  try {
    f.queue.configure({
      ...defaults,
      batchLimit: 1,
      autoRest: true,
      restMinutes: 2,
    });
    f.queue.enqueue(["12345", "12346"]);
    f.queue.resume();
    await f.queue.tick();
    const deadline = f.queue.sourceState().rest_until;
    assert.equal(deadline, f.now + 120000);
    assert.equal(f.queue.sourceState().reason, "batch_rest");
    await f.restart();
    assert.equal(f.queue.sourceState().batch_used, 1);
    assert.equal(f.queue.sourceState().rest_until, deadline);
    f.advance(119999);
    assert.equal(await f.queue.tick(), false);
    assert.equal(f.calls, 1);
    f.advance(1);
    await f.queue.tick();
    assert.equal(f.calls, 2);
    assert.equal(f.queue.sourceState().batch_used, 1);
    assert.equal(f.queue.sourceState().rest_until, f.now + 120000);
  } finally {
    await f.close();
  }
});

test("editing rest duration or batch size cannot shorten active deadline; saving never resumes paused queue", async () => {
  const f = fixture();
  try {
    f.queue.configure({
      ...defaults,
      batchLimit: 1,
      autoRest: true,
      restMinutes: 4,
    });
    f.queue.enqueue(["12345", "12346"]);
    f.queue.resume();
    await f.queue.tick();
    const deadline = f.queue.sourceState().rest_until;
    f.queue.configure({
      ...f.queue.settings(),
      restMinutes: 1,
      batchLimit: 20,
    });
    assert.equal(f.queue.sourceState().rest_until, deadline);
    assert.equal(f.queue.sourceState().paused, 1);
    f.advance(60000);
    f.queue.resume(true);
    assert.equal(await f.queue.tick(), false);
    assert.equal(f.calls, 1);
    f.advance(180000);
    await f.queue.tick();
    assert.equal(f.calls, 2);
    assert.equal(f.queue.sourceState().batch_used, 1);
  } finally {
    await f.close();
  }
});

test("manual pause during rest overrides automatic continuation across restart", async () => {
  const f = fixture();
  try {
    f.queue.configure({
      ...defaults,
      batchLimit: 1,
      autoRest: true,
      restMinutes: 1,
    });
    f.queue.enqueue(["12345", "12346"]);
    f.queue.resume();
    await f.queue.tick();
    f.queue.pause();
    const deadline = f.queue.sourceState().rest_until;
    assert.equal(f.queue.sourceState().reason, "user");
    await f.restart();
    f.advance(60000);
    assert.equal(await f.queue.tick(), false);
    assert.equal(f.calls, 1);
    assert.equal(f.queue.sourceState().rest_until, deadline);
    f.queue.resume(true);
    await f.queue.tick();
    assert.equal(f.calls, 2);
  } finally {
    await f.close();
  }
});

test("manual resume during rest permits future automatic continuation but cannot skip original deadline", async () => {
  const f = fixture();
  try {
    f.queue.configure({
      ...defaults,
      batchLimit: 1,
      autoRest: true,
      restMinutes: 1,
    });
    f.queue.enqueue(["12345", "12346"]);
    f.queue.resume();
    await f.queue.tick();
    f.queue.pause();
    f.advance(10000);
    f.queue.resume(true);
    assert.equal(f.queue.sourceState().reason, "batch_rest");
    assert.equal(await f.queue.tick(), false);
    f.advance(50000);
    await f.queue.tick();
    assert.equal(f.calls, 2);
  } finally {
    await f.close();
  }
});

test("disabling auto rest persists deadline and requires manual continuation after deadline", async () => {
  const f = fixture();
  try {
    f.queue.configure({
      ...defaults,
      batchLimit: 1,
      autoRest: true,
      restMinutes: 2,
    });
    f.queue.enqueue(["12345", "12346"]);
    f.queue.resume();
    await f.queue.tick();
    const deadline = f.queue.sourceState().rest_until;
    f.queue.configure({
      ...f.queue.settings(),
      autoRest: false,
      restMinutes: 1,
    });
    f.queue.resume(true);
    assert.equal(f.queue.sourceState().rest_until, deadline);
    assert.equal(f.queue.sourceState().reason, "batch_limit");
    f.advance(120000);
    await f.queue.tick();
    assert.equal(f.calls, 1);
    f.queue.configure({ ...f.queue.settings(), autoRest: true });
    await f.queue.tick();
    assert.equal(f.calls, 1);
    f.queue.resume(true);
    await f.queue.tick();
    assert.equal(f.calls, 2);
  } finally {
    await f.close();
  }
});

test("reducing batch size applies before next dispatch and increasing it cannot resume a paused batch", async () => {
  const f = fixture();
  try {
    f.queue.configure({...defaults,intervalMinSeconds:10,intervalMaxSeconds:15,autoRest:false});
    f.queue.enqueue(["12345", "12346"]);
    f.queue.resume();
    await f.queue.tick();
    f.queue.configure({ ...f.queue.settings(), batchLimit: 1 });
    f.advance(20000);
    await f.queue.tick();
    assert.equal(f.calls, 1);
    assert.equal(f.queue.sourceState().reason, "batch_limit");
    f.queue.configure({ ...f.queue.settings(), batchLimit: 20, autoRest: true });
    await f.queue.tick();
    assert.equal(f.calls, 1);
    assert.equal(f.queue.sourceState().paused, 1);
    f.queue.resume();
    await f.queue.tick();
    assert.equal(f.calls, 2);
    assert.equal(f.queue.sourceState().batch_used, 2);
  } finally {
    await f.close();
  }
});

for (const status of [401, 403, 200, 429])
  test(`HTTP ${status} cannot enter or automatically leave batch rest after a limit`, async () => {
    const f = fixture(status);
    try {
      f.queue.configure({
        ...defaults,
        batchLimit: 1,
        autoRest: true,
        restMinutes: 1,
      });
      f.queue.enqueue(["12345", "12346"]);
      f.queue.resume();
      await f.queue.tick();
      const reason = f.queue.sourceState().reason;
      assert.equal(f.calls, 1);
      assert.equal(f.queue.sourceState().paused, 1);
      assert.notEqual(reason, "batch_rest");
      if (status === 429) {
        assert.equal(reason, "rate_limit");
        assert.ok(f.queue.sourceState().pause_until >= f.now + 1800000);
      }
      f.queue.configure({ ...f.queue.settings(), batchLimit: 20 });
      f.queue.retry();
      f.queue.pause();
      assert.equal(f.queue.sourceState().reason, reason);
      await f.restart();
      f.advance(3600000);
      await f.queue.tick();
      assert.equal(f.calls, 1);
      assert.equal(f.queue.sourceState().reason, reason);
      f.queue.resume();
      await f.queue.tick();
      assert.equal(f.calls, 2);
    } finally {
      await f.close();
    }
  });

test("first 429 remains paused beyond cooldown and explicit next batch/retry cannot send during cooldown", async () => {
  const f = fixture(429);
  try {
    f.queue.configure({
      ...defaults,
      batchLimit: 1,
      autoRest: true,
      restMinutes: 1,
    });
    f.queue.enqueue(["12345", "12346"]);
    f.queue.resume();
    await f.queue.tick();
    const cooldown = f.queue.sourceState().pause_until;
    f.queue.retry();
    f.queue.resume(true);
    await f.queue.tick();
    assert.equal(f.calls, 1);
    assert.equal(f.queue.sourceState().pause_until, cooldown);
  } finally {
    await f.close();
  }
});

test("a slow failed response still starts a full configured interval at completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-slow-failure-"));
  const catalog = new Catalog(dir);
  let now = 1000000;
  const queue = new PixivQueue(catalog, {
    now: () => now,
    random: () => 0,
    fetcher: async () => {
      now += 60000;
      return new Response("", { status: 404 });
    },
  });
  try {
    queue.configure({
      ...defaults,
      intervalMinSeconds: 5,
      intervalMaxSeconds: 5,
    });
    queue.enqueue(["12345", "12346"]);
    queue.resume();
    await queue.tick();
    assert.equal(queue.sourceState().pause_until, now + 5000);
    assert.equal(await queue.tick(), false);
  } finally {
    await queue.close();
    catalog.close();
    rmSync(dir, { recursive: true });
  }
});

test("directory starts cannot bypass protective pauses; enqueue-only preserves protection, and rest returns actual paused state", async () => {
  const f = fixture();
  try {
    const root = f.catalog.addRoot(f.catalog.dataDir + "-original");
    f.catalog.db
      .prepare(
        "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,artwork_id,page) VALUES('scope-file',?,'12345_p0.png',1,1,1,'12345',0)",
      )
      .run(root.id);
    const scope = {
      rootId: root.id,
      relativePath: "",
      recursive: true,
      mode: "missing_or_failed" as const,
    };
    for (const reason of [
      "needs_login",
      "restricted",
      "challenge",
      "rate_limit",
    ]) {
      f.catalog.db
        .prepare(
          "UPDATE source_state SET paused=1,reason=?,pause_until=? WHERE source='pixiv'",
        )
        .run(reason, f.now + 1800000);
      const preview = f.queue.previewScope(scope);
      assert.throws(
        () => f.queue.enqueueScope(scope, preview.previewToken, true),
        /保护/,
      );
      f.queue.enqueueScope(scope, preview.previewToken, false);
      assert.equal(f.queue.sourceState().reason, reason);
      assert.equal(f.queue.sourceState().pause_until, f.now + 1800000);
      f.advance(3600000);
      await f.queue.tick();
      assert.equal(f.calls, 0);
    }
    f.queue.configure({ ...defaults, batchLimit: 20, autoRest: true });
    f.catalog.db
      .prepare(
        "UPDATE source_state SET paused=1,reason='batch_rest',batch_used=1,rest_until=? WHERE source='pixiv'",
      )
      .run(f.now + 60000);
    const preview = f.queue.previewScope(scope);
    const result = f.queue.enqueueScope(scope, preview.previewToken, true);
    assert.equal(result.paused, true);
    assert.equal(f.queue.sourceState().reason, "batch_rest");
    await f.queue.tick();
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});
