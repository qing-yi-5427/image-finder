/** Directory scopes are root-relative identifiers, never arbitrary disk paths. */
export function directoryPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4000 || /[\0:]/.test(value))
    throw new Error("INVALID_DIRECTORY_SCOPE");
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((x) => x === "." || x === "..")
  )
    throw new Error("INVALID_DIRECTORY_SCOPE");
  return normalized.split("/").filter(Boolean).join("/");
}
