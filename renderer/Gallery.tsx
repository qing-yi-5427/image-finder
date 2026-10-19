import { useMemo, useState, useLayoutEffect, useEffect, useRef } from "react";
import type { FileItem } from "../src/contracts.js";
import { layoutImages, titleOf, type Layout } from "./model";
import { Art } from "./Art";
import { Button, Icon } from "./ui";
import {
  clampThumbnail,
  thumbnailWheel,
  THUMB_STEP,
} from "../src/gallery-interaction";
export function Gallery({
  items,
  total,
  selected,
  onSelect,
  onContextMenu,
  onFileDrag,
  onOpen,
  onFavorite,
  layout,
  target,
  onTargetChange,
  wheelEnabled,
  density,
  onLoadMore,
  loading,
  scrollRef,
  onViewport,
}: {
  items: FileItem[];
  total: number;
  selected: string[];
  onSelect: (item: FileItem, e: React.MouseEvent) => void;
  onContextMenu: (item: FileItem, e: React.MouseEvent) => void;
  onFileDrag: (item:FileItem)=>void;
  onOpen: (id: string, quick?: boolean) => void;
  onFavorite: (item: FileItem) => void;
  layout: Layout;
  target: number;
  onTargetChange: (value: number) => void;
  wheelEnabled: boolean;
  density: string;
  onLoadMore: () => void;
  loading: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onViewport: (index: number) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600, top: 0 });
  useLayoutEffect(() => {
    const el = scrollRef.current,
      inner = content.current;
    if (!el || !inner) return;
    const update = () => {
      const style = getComputedStyle(inner);
      setViewport({
        width:
          inner.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
        height: el.clientHeight,
        top: el.scrollTop,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(inner);
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [scrollRef]);
  const caption = density === "comfortable" ? 55 : 30;
  const geometry = useMemo(
    () => layoutImages(items, viewport.width, target, layout, caption),
    [items, viewport.width, target, layout, caption],
  );
  const reflowAnchor = useRef<{
    id: string;
    fraction: number;
    viewportY: number;
  } | null>(null);
  const lastGeometry = useRef<{
    key: string;
    geometry: typeof geometry;
  } | null>(null);
  useLayoutEffect(() => {
    const key = `${layout}:${target}:${viewport.width}:${caption}`;
    const previous = lastGeometry.current,
      el = scrollRef.current;
    if (previous && previous.key !== key && el && content.current) {
      const padding =
        parseFloat(getComputedStyle(content.current).paddingTop) || 0;
      const old = previous.geometry.boxes.find(
        (b) => b.y + b.height + caption >= el.scrollTop - padding,
      );
      const anchor =
        reflowAnchor.current ??
        (old
          ? {
              id: old.item.id,
              fraction:
                (el.scrollTop - padding - old.y) / (old.height + caption),
              viewportY: 0,
            }
          : null);
      const next = geometry.boxes.find((b) => b.item.id === anchor?.id);
      if (next && anchor) {
        el.scrollTop =
          padding +
          next.y +
          anchor.fraction * (next.height + caption) -
          anchor.viewportY;
        setViewport((value) => ({ ...value, top: el.scrollTop }));
      }
      reflowAnchor.current = null;
    }
    lastGeometry.current = { key, geometry };
  }, [geometry, layout, target, viewport.width, caption, scrollRef]);
  const wheelState = useRef({
    geometry,
    target,
    caption,
    wheelEnabled,
    onTargetChange,
  });
  wheelState.current = {
    geometry,
    target,
    caption,
    wheelEnabled,
    onTargetChange,
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let remainder = 0,
      pending = 0,
      lastTime = 0,
      frame = 0;
    const wheel = (event: WheelEvent) => {
      const state = wheelState.current;
      if (
        !event.ctrlKey ||
        !state.wheelEnabled ||
        !event.deltaY ||
        (event.target as Element)?.closest(
          'input,textarea,select,[contenteditable],.if-popover,[role="dialog"]',
        ) ||
        document.querySelector(".if-modal-overlay")
      )
        return;
      // React's delegated wheel listener is passive; this scoped native listener
      // cancels Chromium page zoom without changing normal or preview scrolling.
      event.preventDefault();
      if (event.timeStamp - lastTime > 250) remainder = 0;
      lastTime = event.timeStamp;
      const delta = thumbnailWheel(
        remainder,
        event.deltaY,
        event.deltaMode,
        el.clientHeight,
      );
      remainder = delta.remainder;
      if (!delta.steps) return;
      pending -= delta.steps * THUMB_STEP;
      if (frame) return;
      const bounds = el.getBoundingClientRect(),
        inner = content.current;
      if (inner) {
        const rect = inner.getBoundingClientRect(),
          style = getComputedStyle(inner);
        const x = event.clientX - rect.left - parseFloat(style.paddingLeft);
        const y = event.clientY - rect.top - parseFloat(style.paddingTop);
        const under =
          state.geometry.boxes.find(
            (b) =>
              x >= b.x &&
              x <= b.x + b.width &&
              y >= b.y &&
              y <= b.y + b.height + state.caption,
          ) ??
          state.geometry.boxes.find(
            (b) => y >= b.y && y <= b.y + b.height + state.caption,
          );
        if (under)
          reflowAnchor.current = {
            id: under.item.id,
            fraction: (y - under.y) / (under.height + state.caption),
            viewportY: event.clientY - bounds.top,
          };
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = clampThumbnail(wheelState.current.target + pending);
        pending = 0;
        if (next === wheelState.current.target) reflowAnchor.current = null;
        else {
          wheelState.current.target = next;
          wheelState.current.onTargetChange(next);
        }
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef]);
  useEffect(() => {
    if (
      items.length < total &&
      !loading &&
      viewport.top + viewport.height > geometry.height - 900
    )
      onLoadMore();
  }, [
    viewport.top,
    viewport.height,
    geometry.height,
    items.length,
    total,
    loading,
    onLoadMore,
  ]);
  const visible = geometry.boxes.filter(
    (b) =>
      b.y + b.height + caption >= viewport.top - 500 &&
      b.y <= viewport.top + viewport.height + 500,
  );
  const firstVisible = geometry.boxes.findIndex(
    (b) => b.y + b.height + caption >= viewport.top,
  );
  useEffect(
    () => onViewport(Math.max(0, firstVisible)),
    [firstVisible, onViewport, items.length],
  );
  return (
    <div
      className="if-gallery-scroll"
      ref={scrollRef}
      data-testid="gallery-scroll"
      data-thumbnail-size={target}
      data-layout={layout}
    >
      <div className="if-gallery" ref={content}>
        <div
          className="if-virtual-canvas"
          style={{ height: geometry.height }}
          data-total={total}
          data-loaded={items.length}
          data-rendered={visible.length}
        >
          {visible.map((b) => (
            <div
              className={`if-gallery-card ${selected.includes(b.item.id) ? "selected" : ""}`}
              key={b.item.id}
              style={{
                position: "absolute",
                top: b.y,
                left: b.x,
                width: b.width,
                height: b.height + caption,
              }}
              data-file-id={b.item.id}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(b.item, e);
              }}
            >
              <button
                className="if-card-image-button"
                style={{ height: b.height, width: "100%" }}
                aria-label={`选择 ${titleOf(b.item)}`}
                aria-pressed={selected.includes(b.item.id)}
                draggable
                onDragStart={event=>{event.preventDefault();onFileDrag(b.item);}}
                onClick={(e) => onSelect(b.item, e)}
                onDoubleClick={() => onOpen(b.item.id)}
              >
                <Art item={b.item} style={{ width: "100%", height: "100%" }} />
                {(b.item.localCount ?? 1) > 1 && (
                  <span className="if-stack-badge">
                    <Icon name="layers" size={11} />
                    {b.item.matchedCount} 匹配 / 本地 {b.item.localCount} 张
                  </span>
                )}
              </button>
              <div className="if-card-meta">
                <span title={titleOf(b.item)}>{titleOf(b.item)}</span>
                <button
                  className={`if-card-favorite ${b.item.favorite ? "active" : ""}`}
                  onClick={() => onFavorite(b.item)}
                  aria-label={b.item.favorite ? "取消收藏" : "收藏图片"}
                >
                  <Icon name="heart" size={12} />
                </button>
              </div>
              {density === "comfortable" && (
                <div className="if-card-secondary">
                  {b.item.creatorName || "作者待补全"} ·{" "}
                  {b.item.width && b.item.height
                    ? `${b.item.width} × ${b.item.height}`
                    : "尺寸待读取"}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="if-gallery-end">
        {loading ? (
          "正在读取…"
        ) : items.length < total ? (
          <Button variant="ghost" onClick={onLoadMore}>
            继续加载 ({items.length} / {total})
          </Button>
        ) : (
          <>
            <Icon name="check" size={12} />
            已加载 {total} {items.some((x) => x.localCount) ? "项" : "张"}
          </>
        )}
      </div>
    </div>
  );
}
