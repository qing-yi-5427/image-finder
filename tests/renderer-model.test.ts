import test from "node:test";
import assert from "node:assert/strict";
import {
  updateTagGroup,
  layoutImages,
  composeQuery,
  cleanPayload,
  validateFilter,
} from "../src/ui-model.js";
test('editing a panel group retains appended sidebar tag groups in saved smart rules',()=>{const groups=Array.from({length:4},(_,i)=>({ids:[`panel-${i}`],mode:'any' as const}));const saved=composeQuery({tags:groups},'',{tags:[{ids:['sidebar-tag'],mode:'all'}]},'added_desc',false).filter!;const edited=updateTagGroup(saved.tags,0,{ids:['new-character']});assert.equal(edited.length,5);assert.deepEqual(edited[4],{ids:['sidebar-tag'],mode:'all'});assert.deepEqual(edited[0].ids,['new-character']);assert.deepEqual(saved.tags?.[0].ids,['panel-0']);});
import { validateInvocation } from "../src/bridge.js";
import type { FileItem } from "../src/contracts.js";
test("optional form payloads are omitted without weakening IPC validation", () => {
  const p = cleanPayload({
    text: "",
    category: undefined,
    offset: 0,
    limit: 50,
  });
  assert.deepEqual(p, { offset: 0, limit: 50 });
  assert.doesNotThrow(() => validateInvocation("tags.list", p));
  assert.throws(() =>
    validateInvocation("tags.list", { category: undefined, text: "" }),
  );
  const f = cleanPayload({
    filter: {
      heightMin: undefined,
      tone: { warmth: undefined },
      color: { hex: "#3366cc", restrict: false, minWeight: undefined },
    },
  });
  assert.doesNotThrow(() => validateInvocation("files.query", f));
});
test("sidebar tag scope and combination groups remain separate AND groups with stable IDs", () => {
  const q = composeQuery(
    { tags: [{ ids: ["character-id"], mode: "all" }], heightMin: 2560 },
    " alias ",
    { tags: [{ ids: ["sidebar-id"], mode: "any" }], rootIds: ["root-id"] },
    "added_desc",
    true,
  );
  assert.deepEqual(q.filter?.tags, [
    { ids: ["character-id"], mode: "all" },
    { ids: ["sidebar-id"], mode: "any" },
  ]);
  assert.equal(q.filter?.text, "alias");
  assert.deepEqual(q.filter?.rootIds, ["root-id"]);
  assert.equal(q.stackArtworks, true);
});
test("three layouts produce finite bounded geometry and support viewport culling", () => {
  const files = Array.from(
    { length: 10000 },
    (_, i) =>
      ({ id: String(i), width: i % 2 ? 2000 : 800, height: 1200 }) as FileItem,
  );
  for (const mode of ["rows", "masonry", "grid"] as const) {
    const geometry = layoutImages(files, 1200, 208, mode);
    assert.equal(geometry.boxes.length, 10000);
    assert.ok(geometry.height > 100000);
    for (const b of geometry.boxes) {
      assert.ok(Number.isFinite(b.x + b.y + b.width + b.height));
      assert.ok(b.width > 0 && b.height > 0 && b.x >= 0);
      assert.ok(b.x + b.width <= 1200.01);
    }
    assert.ok(geometry.boxes.filter((b) => b.y < 1400).length < 100);
  }
});
test("invalid limits and ratios stay in the form rather than querying", () => {
  assert.match(validateFilter({ heightMin: 2000, heightMax: 1000 })!, /下限/);
  assert.match(validateFilter({ aspect: 0 })!, /比例/);
  assert.match(validateFilter({ bytesMin: -1 })!, /非负/);
  assert.equal(
    validateFilter({ heightMin: 2560, bytesMin: 2 * 1024 ** 2 }),
    null,
  );
});
