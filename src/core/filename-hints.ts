import path from "node:path";
/** Filename hints only: never binds works or invents a page for suffix IDs. */
export function filenameSourceHints(
  filename: string,
): Array<{ artworkId: string; page: number | null; reason: string }> {
  const name = path.parse(filename.replace(/\\/g, "/")).name;
  const hints = new Map<
    string,
    { artworkId: string; page: number | null; reason: string }
  >();
  for (const m of name.matchAll(
    /(?:^|[^0-9])([1-9][0-9]{4,11})_p([0-9]+)(?=$|[^0-9])/g,
  )) {
    if (Number.isSafeInteger(Number(m[2])))
      hints.set(m[1], {
        artworkId: m[1],
        page: Number(m[2]),
        reason: "page_marker",
      });
  }
  for (const [pattern, reason] of [
    [/^([1-9][0-9]{4,11})(?:[-_]|$)/, "leading_id"],
    [/(?:[-_])([1-9][0-9]{4,11})$/, "trailing_id"],
  ] as const) {
    const m = pattern.exec(name);
    if (m && !hints.has(m[1]))
      hints.set(m[1], { artworkId: m[1], page: null, reason });
  }
  return [...hints.values()];
}
