import { api } from "./client";
import { useEffect, useState, useRef } from "react";
import type { FileDetail, FileItem } from "../src/contracts.js";
import { FileActionsMenu, type FileAction } from "./FileActions";
import { Art } from "./Art";
import { Button, Icon, Stars } from "./ui";
import { titleOf, bytes } from "./model";
import "./ImageDetails.css";
import { AiReview } from "./AiPanel";
import { DanbooruImageTags } from "./DanbooruPanel";
type Actions = {
  onFavorite: (item: FileItem) => void;
  onRate: (ids: string[], rating: number) => void;
  onTag: (
    id: string,
    tagId: string,
    mode: "add" | "exclude" | "inherit",
  ) => void;
  onBrowseTag: (id: string) => void;
  onAddTag: () => void;
  onColor: (hex: string) => void;
  notify: (s: string) => void;
  onAIChanged?: () => void;
  aiFileIds?: string[];
};
export function InfoPanel({
  item,
  onClose,
  actions,
  viewer = false,
}: {
  item: FileDetail | null;
  onClose: () => void;
  actions: Actions;
  viewer?: boolean;
}) {
  const [candidate, setCandidate] = useState(""),
    [page, setPage] = useState(0);
  useEffect(() => {
    setCandidate(item?.candidateArtworkId ?? "");
    setPage(item?.page ?? 0);
  }, [item?.id]);
  const run = (f: () => Promise<unknown>) =>
    void f().catch((e) => actions.notify(e.message));
  return (
    <aside
      className={`if-info ${viewer ? "" : "forced"}`}
      aria-label="图片信息"
    >
      <div className="if-info-head">
        <span>图片信息</span>
        <Button variant="ghost" onClick={onClose} aria-label="收起图片信息">
          <Icon name="panel-right-close" size={15} />
        </Button>
      </div>
      {!item ? (
        <div className="if-no-selection">
          <Icon name="image" size={30} />
          <h3>选择一张图片</h3>
          <p>查看颜色、标签和来源信息</p>
        </div>
      ) : (
        <div className="if-info-content">
          <header className="if-info-summary">
            <h2 className="if-info-title">{titleOf(item)}</h2>
            <p className="if-info-author">{item.creatorName || "作者待补全"}</p>
            <div className="if-info-actions">
              <Button
                aria-label={item.favorite ? "取消收藏" : "收藏图片"}
                onClick={() => actions.onFavorite(item)}
              >
                <Icon name="heart" size={14} />
                {item.favorite ? "已收藏" : "收藏"}
              </Button>
              <Stars
                value={item.rating}
                onChange={(n) => actions.onRate([item.id], n)}
              />
            </div>
          </header>
          <section className="if-info-source">
            <h3>来源</h3>
            {item.artworkId ? (
              <>
                <p>
                  Pixiv {item.artworkId} · {item.page == null ? "页码未知" : `第 ${item.page + 1} 张`}
                </p>
                {item.source ? (
                  <>
                    <details className="if-info-source-dates">
                      <summary>来源时间</summary>
                      <p className="if-info-hint">
                        发表：
                        {item.source.publishedAt
                          ? new Date(item.source.publishedAt).toLocaleString()
                          : "未知"}
                      </p>
                      <p className="if-info-hint">
                        抓取：{new Date(item.source.fetchedAt).toLocaleString()}
                      </p>
                    </details>
                    <Button
                      onClick={() =>
                        run(() =>
                          api.invoke("files.openSource", { fileId: item.id }),
                        )
                      }
                    >
                      打开 Pixiv 投稿
                    </Button>
                  </>
                ) : (
                  <p className="if-info-hint">
                    来源尚未补全，当前仅按文件名绑定。
                  </p>
                )}
                <Button
                  onClick={() =>
                    run(async () => {
                      await api.invoke("jobs.enqueue", {
                        artworkIds: [item.artworkId!],
                        priority: 10,
                      });
                      actions.notify(
                        "已加入优先补全队列；可在后台任务恢复来源。",
                      );
                    })
                  }
                >
                  优先补全
                </Button>
              </>
            ) : item.candidateArtworkId ? (
              <>
                <p className="if-info-hint">数字文件名为候选，尚未自动绑定。</p>
                <input
                  className="if-input"
                  aria-label="确认投稿ID"
                  value={candidate}
                  onChange={(e) => setCandidate(e.target.value)}
                />
                <input
                  className="if-input"
                  type="number"
                  min="0"
                  aria-label="确认页码（从0开始）"
                  value={page}
                  onChange={(e) => setPage(+e.target.value)}
                />
                <Button
                  onClick={() =>
                    run(async () => {
                      await api.invoke("files.confirmCandidate", {
                        fileId: item.id,
                        artworkId: candidate,
                        page,
                      });
                      actions.notify("来源已确认，重新选择可刷新详情");
                    })
                  }
                >
                  确认来源
                </Button>
              </>
            ) : (
              <p className="if-info-hint">未识别来源</p>
            )}
          </section>
          <section
            className="if-info-section if-info-work-tags"
            aria-label="作品标签"
          >
            <div className="if-info-section-heading">
              <h3>作品标签</h3>
              <Button
                variant="ghost"
                aria-label="添加我的标签"
                onClick={actions.onAddTag}
              >
                <Icon name="plus" size={13} />
                添加
              </Button>
            </div>
            {(["character", "franchise"] as const).map((category) => {
              const tags = item.tags.filter(
                (t) => t.category === category && t.effective,
              );
              return (
                tags.length > 0 && (
                  <div className="if-info-tag-row" key={category}>
                    <span className="if-info-tag-label">
                      {category === "character" ? "角色" : "作品"}
                    </span>
                    <div className="if-tags-wrap">
                      {tags.map((t) => (
                        <button
                          className="if-tag"
                          key={t.id}
                          title={t.aliases.join(" / ")}
                          onClick={() => actions.onBrowseTag(t.id)}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              );
            })}
            {item.tags.some((t) => t.inherited) && (
              <div className="if-info-tag-row">
                <span
                  className="if-info-tag-label"
                  title="来自整篇投稿，可对本图排除"
                >
                  来源
                </span>
                <div className="if-tags-wrap">
                  {item.tags
                    .filter((t) => t.inherited)
                    .map((t) => (
                      <span
                        className={`if-tag ${!t.effective ? "excluded" : ""}`}
                        key={t.id}
                        title={t.rawSource
                          .map((r) =>
                            [r.name, r.translation].filter(Boolean).join(" / "),
                          )
                          .join("\n")}
                      >
                        <button
                          className="if-info-tag-name"
                          onClick={() => actions.onBrowseTag(t.id)}
                        >
                          {t.name}
                        </button>
                        <button
                          className="if-info-tag-action"
                          aria-label={`${t.override === "exclude" ? "恢复" : "排除"}标签 ${t.name}`}
                          onClick={() =>
                            actions.onTag(
                              item.id,
                              t.id,
                              t.override === "exclude" ? "inherit" : "exclude",
                            )
                          }
                        >
                          <Icon
                            name={t.override === "exclude" ? "rotate-ccw" : "x"}
                            size={11}
                          />
                        </button>
                      </span>
                    ))}
                </div>
              </div>
            )}
            {item.tags.some((t) => t.override === "add") && (
              <div className="if-info-tag-row">
                <span className="if-info-tag-label">我的</span>
                <div className="if-tags-wrap">
                  {item.tags
                    .filter((t) => t.override === "add")
                    .map((t) => (
                      <span className="if-tag mine" key={t.id}>
                        <button
                          className="if-info-tag-name"
                          onClick={() => actions.onBrowseTag(t.id)}
                        >
                          {t.name}
                        </button>
                        <button
                          className="if-info-tag-action"
                          aria-label={`移除我的标签 ${t.name}`}
                          onClick={() =>
                            actions.onTag(item.id, t.id, "inherit")
                          }
                        >
                          <Icon name="x" size={11} />
                        </button>
                      </span>
                    ))}
                </div>
              </div>
            )}
            {!item.tags.some(
              (t) =>
                t.inherited ||
                t.override === "add" ||
                (t.effective &&
                  ["character", "franchise"].includes(t.category)),
            ) && (
              <p className="if-info-empty-tags">
                暂无作品标签，可添加我的标签或使用 WD 自动标签。
              </p>
            )}
          </section>
          <DanbooruImageTags key={`danbooru:${item.id}`} fileId={item.id} notify={actions.notify} />
          <AiReview
            key={item.id}
            fileId={item.id}
            notify={actions.notify}
            onChanged={actions.onAIChanged}
            reviewIds={actions.aiFileIds}
          />
          <section
            className="if-info-section if-info-technical"
            aria-label="颜色与文件"
          >
            <h3>颜色与文件</h3>
            <h4>画面颜色</h4>

            {item.palette?.length ? (
              <div className="if-palette">
                {item.palette.map((c) => (
                  <button
                    key={c.hex}
                    style={{ background: c.hex, flex: c.weight }}
                    onClick={() => actions.onColor(c.hex)}
                    title={`${c.hex} · ${Math.round(c.weight * 100)}%`}
                    aria-label={`筛选颜色 ${c.hex}`}
                  />
                ))}
              </div>
            ) : (
              <p className="if-info-hint">
                {item.processing.status === "error"
                  ? "颜色分析失败"
                  : "颜色尚未分析"}
              </p>
            )}
            <p className="if-info-hint">
              {item.processing.error ||
                {
                  pending: "等待准备预览和颜色",
                  ready: "本地图像已分析",
                  evicted: "缓存已淘汰，可按需重建",
                  error: "图片处理失败",
                }[item.processing.status]}
            </p>
            {item.processing.status === "error" && (
              <Button
                onClick={() =>
                  run(() => api.invoke("local.retry", { fileIds: [item.id] }))
                }
              >
                重试本图
              </Button>
            )}
            <h4>本地文件</h4>

            <dl className="live-properties">
              <dt>尺寸</dt>
              <dd>
                {item.width && item.height
                  ? `${item.width} × ${item.height}`
                  : "尚未读取"}
              </dd>
              <dt>大小</dt>
              <dd>{bytes(item.bytes)}</dd>
              <dt>格式</dt>
              <dd>{item.format?.toUpperCase() || "未知"}</dd>
              <dt>本地加入</dt>
              <dd>{new Date(item.addedAt).toLocaleString()}</dd>
              <dt>文件修改</dt>
              <dd>{new Date(item.mtimeMs).toLocaleString()}</dd>
              <dt>原目录</dt>
              <dd>
                {item.root.status === "online"
                  ? "在线"
                  : item.root.status === "partial"
                    ? "部分可用"
                    : "离线"}{" "}
                {item.root.path}
              </dd>
              <dt>相对路径</dt>
              <dd>{item.relativePath}</dd>
            </dl>
            {item.missing && (
              <p className="live-error">原文件缺失，索引与整理信息保留。</p>
            )}
            <Button
              onClick={() =>
                run(() => api.invoke("files.reveal", { fileId: item.id }))
              }
            >
              在文件夹中显示
            </Button>
          </section>
        </div>
      )}
    </aside>
  );
}
export function ImageViewer({
  item,
  items,
  postItems,
  onNavigate,
  onClose,
  onActivity,
  onHelp,
  actions,
  quick = false,
  onFileAction,
}: {
  item: FileDetail;
  items: FileItem[];
  postItems: FileItem[];
  onNavigate: (id: string) => void;
  onClose: () => void;
  onActivity: () => void;
  onHelp: () => void;
  actions: Actions;
  quick?: boolean;
  onFileAction: (action: FileAction, ids: string[]) => void;
}) {
  const [scale, setScale] = useState<number | null>(null),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [info, setInfo] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );
  const box = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 800, h: 700 });
  useEffect(() => {
    setScale(null);
    setPan({ x: 0, y: 0 });
    setMenu(null);
  }, [item.id]);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() =>
      setArea({
        w: box.current!.clientWidth - 50,
        h: box.current!.clientHeight - 50,
      }),
    );
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [info]);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus?.();
  }, []);
  const resetView = () => { setScale(null); setPan({ x: 0, y: 0 }); };
  const index = items.findIndex((x) => x.id === item.id);
  const move = (delta: number) => {
    const next = items[index + delta];
    if (next) onNavigate(next.id);
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector(".if-modal-overlay")) return;
      if (menu) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(null); }
        return;
      }
      if (
        e.isComposing ||
        (e.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        resetView();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "ArrowLeft") move(-1);
      if (e.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });
  const fit =
    item.width && item.height
      ? Math.min(area.w / item.width, area.h / item.height, 1)
      : 1;
  const zoom = scale ?? fit;
  return (
    <div
      className={`if-viewer ${quick ? "quick" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="图片详情"
      ref={dialogRef}
      onKeyDown={(e) => {
        if (document.querySelector(".if-modal-overlay")) return;
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Tab") {
          const nodes = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]),input:not([disabled]),select,[tabindex="0"]',
            ) ?? [],
          ).filter((x) => x.getClientRects().length);
          const first = nodes[0],
            last = nodes.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="if-viewer-top">
        <Button
          className="if-viewer-exit"
          aria-label="关闭详情"
          onClick={onClose}
        >
          <Icon name="arrow-left" size={16} />
          <span>返回图库</span>
        </Button>
        <div className="if-viewer-title">
          <strong>{titleOf(item)}</strong>
          <small>
            {index + 1} / 已加载 {items.length}
          </small>
        </div>
        <div className="if-viewer-chrome">
          <Button
            variant="ghost"
            aria-label="查看后台任务"
            onClick={onActivity}
          >
            <Icon name="activity" size={16} />
          </Button>
          <Button variant="ghost" aria-label="快捷键帮助" onClick={onHelp}>
            <Icon name="circle-help" size={16} />
          </Button>
          <Button
            variant="ghost"
            aria-label="显示或隐藏图片信息"
            aria-pressed={info}
            onClick={() => setInfo((v) => !v)}
          >
            <Icon name="panel-right-close" size={15} />
          </Button>
          <div className="if-window-controls">
            {(["minimize", "maximize", "close"] as const).map((action, i) => (
              <Button
                key={action}
                variant="ghost"
                aria-label={["最小化窗口", "最大化或还原窗口", "关闭窗口"][i]}
                onClick={() => void api.invoke("window.control", { action })}
              >
                <Icon name={["minus", "square", "x"][i]} size={14} />
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div className="if-viewer-body">
        <div
          className="if-viewer-image-area"
          ref={box}
          tabIndex={0}
          aria-label="图片预览，Shift+F10 打开图片操作"
          onKeyDown={(e) => {
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              const bounds = box.current!.getBoundingClientRect();
              setMenu({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, ids: [item.id] });
            }
          }}
          onDoubleClick={(e) => {
            // Pointer capture during panning can retarget an image click to the
            // stage. Hit-test the real point as well, so only empty background closes.
            if (
              e.target === e.currentTarget &&
              document.elementFromPoint(e.clientX, e.clientY) ===
                e.currentTarget
            )
              onClose();
          }}
          onWheel={(e) => {
            e.preventDefault();
            setScale(
              Math.max(
                0.03,
                Math.min(8, zoom * (e.deltaY > 0 ? 1 / 1.1 : 1.1)),
              ),
            );
          }}
          onDragStartCapture={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary || (e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (drag.current)
              setPan({
                x: drag.current.px + e.clientX - drag.current.x,
                y: drag.current.py + e.clientY - drag.current.y,
              });
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onLostPointerCapture={() => (drag.current = null)}
        >
      <div className="if-row if-viewer-zoom" role="group" aria-label="图片缩放控制">
        <Button
          aria-label="适应窗口并居中（空格）"
          title="适应窗口并居中 · 空格"
          onClick={resetView}
        >
          适应窗口
        </Button>
        <Button aria-label="100% 原始尺寸" title="以原始像素尺寸显示并居中" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>100%</Button>
        <Button
          aria-label="缩小"
          title="缩小图片"
          onClick={() => setScale(Math.max(0.03, zoom / 1.2))}
        >
          −
        </Button>
        <output aria-label="当前缩放比例" aria-live="polite">{Math.round(zoom * 100)}%</output>
        <Button
          aria-label="放大"
          title="放大图片"
          onClick={() => setScale(Math.min(8, zoom * 1.2))}
        >
          +
        </Button>
      </div>
          <div
            onContextMenu={(e) => {
              e.preventDefault(); e.stopPropagation();
              drag.current = null;
              box.current?.focus();
              setMenu({ x: e.clientX, y: e.clientY, ids: [item.id] });
            }}
            style={{
              width: (item.width || 600) * zoom,
              height: (item.height || 600) * zoom,
              flexShrink: 0,
              transform: `translate(${pan.x}px,${pan.y}px)`,
            }}
          >
            <Art
              item={item}
              original
              style={{ width: "100%", height: "100%" }}
            />
          </div>
          <Button
            className="live-prev"
            aria-label="上一张"
            disabled={index <= 0}
            onClick={() => move(-1)}
          >
            <Icon name="chevron-left" />
          </Button>
          <Button
            className="live-next"
            aria-label="下一张"
            disabled={index < 0 || index >= items.length - 1}
            onClick={() => move(1)}
          >
            <Icon name="chevron-right" />
          </Button>
          <span className="if-viewer-background-hint">
            空格适应并居中 · 双击空白处关闭 · Esc 返回 · ← → 切换
          </span>
        </div>
        {info && (
          <InfoPanel
            item={item}
            viewer
            onClose={() => setInfo(false)}
            actions={actions}
          />
        )}
      </div>
      {menu && <FileActionsMenu menu={menu} onClose={() => setMenu(null)} onAction={onFileAction}
        missing={item.missing || item.root.status === "offline"}
        extras={[
          { label: item.favorite ? "取消收藏" : "收藏图片", icon: "heart", run: () => actions.onFavorite(item) },
          ...(item.artworkId && item.source ? [{ label: "打开 Pixiv 投稿", icon: "external-link", run: () => {
            void api.invoke("files.openSource", { fileId: item.id }).catch((e) => actions.notify(e.message));
          } }] : []),
        ]} />}
      {postItems.length > 1 && (
        <div className="if-viewer-strip">
          <span>该投稿本地图（含不匹配项）</span>
          {postItems.map((im) => (
            <button
              key={im.id}
              aria-label={im.page == null ? "打开投稿图片（页码未知）" : `打开投稿第 ${im.page + 1} 张`}
              className={im.id === item.id ? "active" : ""}
              onClick={() => onNavigate(im.id)}
            >
              <Art item={im} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
