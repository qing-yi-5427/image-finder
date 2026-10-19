import type { FileItem, Filter, QueryRequest,TagGroup } from "./contracts.js";
export function updateTagGroup(groups:TagGroup[]|undefined,index:number,patch:Partial<TagGroup>):TagGroup[]{const result=Array.from({length:Math.max(4,groups?.length??0)},(_,i)=>groups?.[i]??{ids:[],mode:'any' as const});result[index]={...result[index],...patch};return result;}
export const titleOf = (item: FileItem) =>
  item.title || item.relativePath.split(/[\\/]/).at(-1) || item.id;
export const imageUrl = (id: string, original = false) =>
  `image-finder://image/${encodeURIComponent(id)}?variant=${original ? "original" : "thumbnail"}`;
export const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(2)} GiB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(2)} MiB`
      : `${(n / 1024).toFixed(1)} KiB`;
export type Layout = "rows" | "masonry" | "grid";
export type Box = {
  item: FileItem;
  x: number;
  y: number;
  width: number;
  height: number;
};
export function cleanPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanPayload);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, v]) =>
            v !== undefined &&
            !(key === "text" && typeof v === "string" && !v.trim()),
        )
        .map(([key, v]) => [key, cleanPayload(v)]),
    );
  return value;
}
/** Geometry has no DOM dependency; all layouts can cull the same viewport. */
export function layoutImages(
  items: FileItem[],
  width: number,
  target: number,
  layout: Layout,
  caption = 44,
) {
  const boxes: Box[] = [];
  const gap = 9;
  width = Math.max(1, width);
  const ratio = (item: FileItem) =>
    Math.max(
      0.15,
      Math.min(6, item.width && item.height ? item.width / item.height : 1),
    );
  if (layout === "masonry") {
    const columns = Math.max(1, Math.floor(width / (target * 0.85)));
    const w = (width - gap * (columns - 1)) / columns;
    const heights = Array(columns).fill(0) as number[];
    for (const item of items) {
      const col = heights.indexOf(Math.min(...heights));
      const h = w / ratio(item);
      boxes.push({
        item,
        x: col * (w + gap),
        y: heights[col],
        width: w,
        height: h,
      });
      heights[col] += h + caption + gap;
    }
    return { boxes, height: Math.max(0, ...heights) };
  }
  if (layout === "grid") {
    const columns = Math.max(1, Math.floor(width / (target * 0.8)));
    const w = (width - gap * (columns - 1)) / columns;
    for (let i = 0; i < items.length; i++)
      boxes.push({
        item: items[i],
        x: (i % columns) * (w + gap),
        y: Math.floor(i / columns) * (w + caption + gap),
        width: w,
        height: w,
      });
    return {
      boxes,
      height: Math.ceil(items.length / columns) * (w + caption + gap),
    };
  }
  let row: FileItem[] = [];
  let sum = 0,
    y = 0;
  const flush = (last = false) => {
    const h = Math.max(
      1,
      Math.min(
        last ? target : target * 1.28,
        (width - gap * (row.length - 1)) / sum,
      ),
    );
    let x = 0;
    for (const item of row) {
      const w = ratio(item) * h;
      boxes.push({ item, x, y, width: w, height: h });
      x += w + gap;
    }
    y += h + caption + gap;
    row = [];
    sum = 0;
  };
  for (const item of items) {
    row.push(item);
    sum += ratio(item);
    if (sum * target + gap * (row.length - 1) >= width) flush();
  }
  if (row.length) flush(true);
  return { boxes, height: y };
}
export function validateFilter(filter: Filter): string | null {
  for (const [min, max, label] of [
    ["widthMin", "widthMax", "宽度"],
    ["heightMin", "heightMax", "高度"],
    ["bytesMin", "bytesMax", "文件大小"],
  ] as const) {
    if (
      (filter[min] !== undefined &&
        (!Number.isFinite(filter[min]) || filter[min]! < 0)) ||
      (filter[max] !== undefined &&
        (!Number.isFinite(filter[max]) || filter[max]! < 0))
    )
      return `${label}必须是非负数`;
    if (
      filter[min] !== undefined &&
      filter[max] !== undefined &&
      filter[min]! > filter[max]!
    )
      return `${label}下限不能大于上限`;
  }
  if (
    filter.aspect !== undefined &&
    (!Number.isFinite(filter.aspect) || filter.aspect <= 0)
  )
    return "比例必须大于0";
  return null;
}
export function composeQuery(
  filter: Filter,
  text: string,
  scope: Filter,
  sort: QueryRequest["sort"],
  stack: boolean,
): QueryRequest {
  return {
    filter: {
      ...filter,
      ...scope,
      tags: [...(filter.tags ?? []), ...(scope.tags ?? [])],
      ...(text.trim() ? { text: text.trim() } : {}),
    },
    sort: sort === "color" && !filter.color ? "added_desc" : sort,
    stackArtworks: stack,
    limit: 120,
    offset: 0,
  };
}
