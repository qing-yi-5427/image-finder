import test from "node:test";
import assert from "node:assert/strict";
import { clampThumbnail, thumbnailWheel } from "../src/gallery-interaction.js";

test("thumbnail sizes retain existing default and clamp corrupt persisted preferences", () => {
  assert.equal(clampThumbnail(208), 208);
  assert.equal(clampThumbnail(218), 218);
  assert.equal(clampThumbnail(900), 290);
  assert.equal(clampThumbnail(-20), 140);
  for (const value of [NaN, Infinity, "220", null, undefined])
    assert.equal(clampThumbnail(value), 208);
});

test("wheel accumulation handles pixel, line and page modes and preserves trackpad remainder", () => {
  let remainder = 0,
    steps = 0;
  for (let i = 0; i < 20; i++) {
    const result = thumbnailWheel(remainder, -7, 0, 600);
    remainder = result.remainder;
    steps += result.steps;
  }
  assert.equal(steps, -1);
  assert.equal(remainder, -40);
  assert.deepEqual(thumbnailWheel(40, 4, 1, 600), { steps: 1, remainder: 4 });
  assert.deepEqual(thumbnailWheel(0, -1, 2, 650), {
    steps: -6,
    remainder: -50,
  });
  assert.deepEqual(thumbnailWheel(-40, 40, 0, 600), { steps: 0, remainder: 0 });
  assert.deepEqual(thumbnailWheel(0, NaN, 0, 600), { steps: 0, remainder: 0 });
});
