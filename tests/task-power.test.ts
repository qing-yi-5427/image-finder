import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskPowerGuard, tasksNeedAwake } from "../src/electron/task-power.js";
const pixiv = (reason: string | null, pending = 2) => ({
  counts: [{ status: "waiting", count: pending }],
  source: { paused: reason !== null, reason, settings: { autoRest: true } },
});
test("sleep protection follows runnable queues and ordinary rest, releases on protection or completion", () => {
  for (const reason of [null, "batch_rest"])
    assert.equal(tasksNeedAwake({}, pixiv(reason), {}), true);
  for (const reason of [
    "user",
    "restricted",
    "needs_login",
    "challenge",
    "rate_limit",
    "batch_limit",
  ])
    assert.equal(tasksNeedAwake({}, pixiv(reason), {}), false);
  assert.equal(tasksNeedAwake({}, pixiv(null, 0), {}), false);
  assert.equal(
    tasksNeedAwake(
      {},
      { ...pixiv(null), source: { ...pixiv(null).source, scopePending: 0 } },
      {},
    ),
    false,
  );
  assert.equal(
    tasksNeedAwake({}, pixiv("user"), {
      queues: [{ paused: false, counts: { waiting: 1, running: 0 } }],
    }),
    true,
  );
  assert.equal(
    tasksNeedAwake({}, pixiv("user"), {
      queues: [{ paused: true, counts: { waiting: 1, running: 0 } }],
    }),
    false,
  );
  assert.equal(
    tasksNeedAwake(
      {
        local: {
          imagesPaused: false,
          images: { pending: 1 },
          scanPaused: true,
        },
      },
      pixiv("user"),
      {},
    ),
    true,
  );
});
test("power guard starts once and releases on pause or exit", () => {
  const calls: unknown[] = [];
  const guard = new TaskPowerGuard({
    start: (type) => {
      calls.push(type);
      return 9;
    },
    stop: (id) => {
      calls.push(id);
    },
  });
  guard.update(true);
  guard.update(true);
  guard.update(false);
  guard.update(false);
  guard.update(true);
  guard.close();
  assert.deepEqual(calls, [
    "prevent-app-suspension",
    9,
    "prevent-app-suspension",
    9,
  ]);
});

test("Sauce queues keep runnable or in-flight work awake but release quota pauses", () => {
  assert.equal(
    tasksNeedAwake(
      {},
      pixiv("user", 0),
      {},
      { paused: false, counts: [{ status: "waiting", count: 1 }] },
    ),
    true,
  );
  assert.equal(
    tasksNeedAwake(
      {},
      pixiv("user", 0),
      {},
      {
        paused: true,
        reason: "quota_exhausted",
        counts: [{ status: "waiting", count: 1 }],
      },
    ),
    false,
  );
  assert.equal(
    tasksNeedAwake(
      {},
      pixiv("user", 0),
      {},
      { paused: true, counts: [{ status: "running", count: 1 }] },
    ),
    true,
  );
});
