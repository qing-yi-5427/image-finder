import path from "node:path";

/** Review evidence only. Downloader provenance does not establish which numeric field is an ID. */
export function filenameRecoveryEvidence(filename: string) {
  const originalStem = path.posix.parse(filename.replace(/\\/g, "/")).name;
  const duplicate = / \(([1-9][0-9]*)\)$/.exec(originalStem);
  const stem = duplicate ? originalStem.slice(0, duplicate.index) : originalStem;
  const candidates = new Map<string, { artworkId: string; page: number | null; pageKnown: boolean; evidence: string[] }>();
  const add = (id: string, page: number | null, evidence: string) => {
    const item = candidates.get(id) ?? { artworkId: id, page: null, pageKnown: false, evidence: [] };
    if (page !== null) { item.page = page; item.pageKnown = true; }
    item.evidence.push(evidence);
    candidates.set(id, item);
  };
  // Only delimiter-separated numeric fields count. Digits embedded in an author or hash do not.
  for (const m of stem.matchAll(/(?:^|[-_])([1-9][0-9]{4,11})(?=$|[-_])/g)) {
    const start = m.index! + (m[0].length - m[1].length);
    const suffix = stem.slice(start + m[1].length);
    const marker = /^_p([0-9]+)$/.exec(suffix);
    const page = marker && Number.isSafeInteger(Number(marker[1])) ? Number(marker[1]) : null;
    add(m[1], page, start === 0 ? "leading_numeric_field" : suffix === "" || marker ? "trailing_numeric_field" : "interior_numeric_field");
  }
  // A trailing page marker also belongs to leading-ID downloader layouts, but is never inferred.
  const leading = /^([1-9][0-9]{4,11})-.+_p([0-9]+)$/.exec(stem);
  if (leading && Number.isSafeInteger(Number(leading[2]))) add(leading[1], Number(leading[2]), "explicit_terminal_page_marker");
  const values = [...candidates.values()];
  const only = values[0];
  const edge = only?.evidence.some(e => e !== "interior_numeric_field");
  const classification = values.length !== 1 || !edge ? "ambiguous" : only.pageKnown ? "candidate_page_known" : "candidate_page_unknown";
  return { originalStem, duplicateSuffix: duplicate?.[1] ?? null, classification, candidates: values,
    ambiguousReason: classification === "ambiguous" ? values.length > 1 ? "multiple_numeric_fields_author_or_title_may_be_numeric" : values.length === 0 ? "nonstandard_or_missing_id_boundary" : "interior_numeric_field_only" : null };
}
