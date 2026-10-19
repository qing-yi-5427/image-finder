import { useEffect, useRef, useState, useId } from "react";
import type { LibraryRoot } from "../src/contracts";
import type {
  PixivBatchScope,
  PixivBatchPreview,
} from "../src/core/pixiv-batch-contracts";
import { api } from "./client";
import { Button } from "./ui";
import { DirectoryTree, directorySection } from "./DirectoryTree";
type Notify = (
  text: string,
  undo?: () => void,
  kind?: "success" | "error",
) => void;
export function PixivBatchPanel({
  notify,
  onQueued,
}: {
  notify: Notify;
  onQueued?: () => Promise<unknown>;
}) {
  const [roots, setRoots] = useState<LibraryRoot[]>([]),
    [selected, setSelected] = useState<{
      rootId: string;
      relativePath: string;
    } | null>(null),
    [recursive, setRecursive] = useState(true),
    [mode, setMode] = useState<PixivBatchScope["mode"]>("missing_or_failed"),
    [preview, setPreview] = useState<PixivBatchPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const group = useId();
  const alive = useRef(true);
  const version = useRef(0);
  const scope = selected ? { ...selected, recursive, mode } : null;
  const current = useRef("");
  current.current = JSON.stringify(scope);
  useEffect(() => {
    alive.current = true;
    api
      .invoke("library.list", {})
      .then((value) => {
        if (alive.current) setRoots(value);
      })
      .catch((failure) => {
        if (alive.current)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      alive.current = false;
      version.current++;
    };
  }, []);
  useEffect(() => {
    version.current++;
    setPreview(null);
    setError("");
  }, [selected?.rootId, selected?.relativePath, recursive, mode]);
  const runPreview = async () => {
    if (!scope || busy) return;
    const key = JSON.stringify(scope);
    const token = ++version.current;
    setBusy(true);
    setError("");
    try {
      const result = await api.invoke("jobs.scopePreview", scope);
      if (alive.current && token === version.current && key === current.current)
        setPreview(result);
    } catch (failure) {
      if (alive.current && token === version.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const enqueue = async (start: boolean) => {
    if (!scope || !preview || busy) return;
    const key = JSON.stringify(scope);
    setBusy(true);
    setError("");
    try {
      const result = await api.invoke("jobs.enqueueScope", {
        ...scope,
        previewToken: preview.previewToken,
        start,
      });
      if (alive.current && key === current.current) setPreview(null);
      notify(
        start
          ? result.queuedArtworkCount
            ? `已排入 ${result.queuedArtworkCount} 个作品并开始补全`
            : "已恢复来源队列，现有待办将继续运行"
          : `已排入 ${result.queuedArtworkCount} 个作品，Pixiv 队列已暂停`,
      );
      await onQueued?.();
    } catch (failure) {
      if (alive.current) {
        setPreview(null);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const root = roots.find((root) => root.id === selected?.rootId);
  return (
    <div
      className="if-pixiv-batch"
      aria-label="按目录批量补全 Pixiv"
      aria-busy={busy}
    >
      <p className="if-setting-description">
        选择一个原目录或子文件夹，先统计范围，再加入队列。多页投稿合并为一个作品任务。
      </p>
      <div className="if-pixiv-scope-tree" aria-label="选择补全目录">
        <DirectoryTree
          roots={roots}
          section={
            selected
              ? selected.relativePath
                ? directorySection(selected.rootId, selected.relativePath)
                : `root:${selected.rootId}`
              : ""
          }
          onSelect={(section) => {
            if (section.startsWith("root:"))
              setSelected({ rootId: section.slice(5), relativePath: "" });
            else if (section.startsWith("directory:")) {
              const [rootId, relativePath] = JSON.parse(section.slice(10));
              setSelected({ rootId, relativePath });
            }
          }}
        />
        {!roots.length && <p>尚无原目录，请先添加图片文件夹。</p>}
      </div>
      <p className="if-pixiv-scope-path">
        当前范围：
        <code>
          {root
            ? selected?.relativePath
              ? `${root.path} / ${selected.relativePath}`
              : root.path
            : "尚未选择目录"}
        </code>
      </p>
      <label className="if-pixiv-option">
        <input
          type="checkbox"
          checked={recursive}
          onChange={(event) => setRecursive(event.target.checked)}
        />
        包含所有子文件夹
      </label>
      <fieldset className="if-pixiv-mode">
        <legend>处理范围</legend>
        <label className="if-pixiv-option">
          <input
            type="radio"
            name={group}
            checked={mode === "missing_or_failed"}
            onChange={() => setMode("missing_or_failed")}
          />
          仅缺少来源信息或上次失败的作品
        </label>
        <label className="if-pixiv-option">
          <input
            type="radio"
            name={group}
            checked={mode === "all"}
            onChange={() => setMode("all")}
          />
          全部可补全作品（已完成的重新补全）
        </label>
      </fieldset>
      <Button disabled={busy || !selected} onClick={runPreview}>
        {busy ? "正在处理…" : "预览补全范围"}
      </Button>
      {preview && (
        <div className="if-pixiv-preview" role="status" aria-live="polite">
          <strong>
            范围内 {preview.fileCount.toLocaleString()} 张图片 ·{" "}
            {preview.artworkCount.toLocaleString()} 个已确认作品
          </strong>
          <p>
            本次可加入 {preview.eligibleArtworkCount.toLocaleString()}{" "}
            个作品，关联 {preview.eligibleFileCount.toLocaleString()}{" "}
            张范围内图片。
          </p>
          <p>
            已在队列 {preview.queuedArtworkCount} · 正在处理{" "}
            {preview.runningArtworkCount} · 已有来源而跳过{" "}
            {preview.completedArtworkCount} · 不可用而跳过{" "}
            {preview.unavailableArtworkCount} · 未绑定作品的图片{" "}
            {preview.unboundFileCount}
          </p>
          <div className="if-pixiv-batch-actions">
            <Button
              disabled={busy || preview.eligibleArtworkCount === 0}
              onClick={() => enqueue(false)}
            >
              仅加入队列（暂停）
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                preview.eligibleArtworkCount + preview.queuedArtworkCount === 0
              }
              onClick={() => enqueue(true)}
            >
              开始补全
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="if-pixiv-error">
          {error}
        </p>
      )}
      <p className="if-setting-description">
        “仅加入”会暂停整个 Pixiv
        队列；“开始补全”会继续整个来源队列，包括此前已排队的作品。权限受限或不可读取的作品会跳过，可到作品任务中逐项重试。人工标签、排除、收藏和评分保持不变。
      </p>
    </div>
  );
}
