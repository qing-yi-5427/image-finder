import { test } from "node:test";
import assert from "node:assert/strict";
import { taskProgress } from "../src/task-progress.js";

test("persistent queue progress counts terminal failures and keeps pending retries unprocessed", () => {
  assert.deepEqual(taskProgress({ done: 20, failed: 2, needs_login: 1, unavailable: 1, waiting: 25, running: 1, retry_wait: 10 }), { success: 20, failed: 4, pending: 35, running: 1, cancelled:0, total: 60, processed: 24, percent: 40 });
});
test("empty queues have no fake percentage and new work/retries change current-queue denominator", () => {
  assert.equal(taskProgress({}).percent, null);
  assert.equal(taskProgress({ done: 10 }).percent, 100);
  assert.equal(taskProgress({ done: 10, waiting: 10 }).percent, 50);
  assert.equal(taskProgress({ done: 9, waiting: 11 }).percent, 45);
});

test('cancelled queue entries are processed terminal outcomes and never successful coverage',()=>{
 const result=taskProgress({done:2,cancelled:3,waiting:5});assert.equal(result.total,10);assert.equal(result.success,2);assert.equal(result.cancelled,3);assert.equal(result.processed,5);assert.equal(result.percent,50);
});
