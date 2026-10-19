import test from "node:test";
import assert from "node:assert/strict";
import { filenameRecoveryEvidence as evidence } from "../src/core/filename-recovery.js";

test("downloader candidates preserve explicit pages and Windows duplicate suffixes", () => {
  for (const n of [1, 2, 12]) {
    const result = evidence(`12\\author-title-123456_p3 (${n}).jpg`);
    assert.equal(result.duplicateSuffix, String(n));
    assert.equal(result.classification, "candidate_page_known");
    assert.deepEqual(result.candidates.map(c => [c.artworkId, c.page]), [["123456", 3]]);
  }
  assert.equal(evidence("123456-author-title_p2.png").candidates[0].page, 2);
  assert.equal(evidence("123456-a12345-title.jpg").candidates.length, 1);
});
test("numeric authors and titles remain ambiguous and missing pages stay unknown", () => {
  for (const name of ["123456-title-654321.jpg", "author-123456-654321.jpg", "123456-author-654321.jpg"])
    assert.equal(evidence(name).classification, "ambiguous");
  for (const name of ["123456-author-title.jpg", "author-title-123456 (2).jpg", "author-title-123456.jpg"])
    assert.deepEqual(evidence(name).candidates.map(c => [c.page, c.pageKnown]), [[null, false]]);
  assert.equal(evidence("a123456_p0.jpg").classification, "ambiguous");
  assert.equal(evidence("author-123456-title.jpg").classification, "ambiguous");
  assert.equal(evidence("123456-40cce3613c4495a32f537f103c202ebd_p1.jpg").candidates.length, 1);
  assert.equal(evidence("author-title-123456 (654321).jpg").candidates.length, 1);
});
