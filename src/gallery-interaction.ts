/** Shared thumbnail bounds for the display menu and gallery wheel gesture. */
export const THUMB_MIN = 140;
export const THUMB_MAX = 290;
export const THUMB_STEP = 10;
export const THUMB_DEFAULT = 208;
export function clampThumbnail(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(THUMB_MIN, Math.min(THUMB_MAX, value))
    : THUMB_DEFAULT;
}
/** Accumulate high-resolution wheel events; DOM delta modes are px/line/page. */
export function thumbnailWheel(
  remainder: number,
  delta: number,
  mode: number,
  page: number,
) {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? Math.max(1, page) : 1);
  if (!Number.isFinite(pixels)) return { steps: 0, remainder: 0 };
  const total = remainder + pixels;
  const steps = Math.trunc(total / 100);
  return { steps, remainder: total - steps * 100 };
}
