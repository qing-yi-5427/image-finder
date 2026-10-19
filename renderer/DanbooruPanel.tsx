import { useCallback, useEffect, useRef, useState } from "react";
import type { MethodMap } from "../src/api";
import type { LibraryRoot } from "../src/contracts";
import { api } from "./client";
import { DirectoryTree, directorySection } from "./DirectoryTree";
import { Button, Icon } from "./ui";
import "./SaucePanel.css";

type Notify = (text: string) => void;
type Status = MethodMap["danbooru.status"]["result"];
type Result = MethodMap["danbooru.list"]["result"][number];
type Tag = MethodMap["danbooru.tags"]["result"][number];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const statusName: Record<string, string> = {
  waiting: "等待匹配",
  running: "正在匹配",
  matched: "MD5 精确匹配",
  confirmed: "MD5 精确匹配",
  done: "已完成",
  no_match: "没有精确匹配",
  unavailable: "来源不可用，已跳过",
  candidate: "仅候选，未绑定",
  review: "仅候选，未绑定",
  error: "匹配失败",
  cancelled: "已取消",
};
function reasonText(reason: string | null) {
  if (!reason) return "";
  if (reason === "user") return "已手动暂停。";
  if (reason === "restart") return "重新打开后已暂停，请手动继续。";
  if (reason === "completed") return "当前队列已完成。";
  if (reason === "cancelled") return "等待和当前匹配任务已取消。";
  if (reason === "not_started") return "默认暂停，请选择范围后手动开始。";
  if (/403|429|rate|limit|access_restricted/.test(reason))
    return "服务拒绝请求或限制访问，已暂停；请检查网络并等待后再继续。";
  return reason;
}
function useDanbooru(includeResults: boolean) {
  const [status, setStatus] = useState<Status | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    try {
      const [next, rows] = await Promise.all([
        api.invoke("danbooru.status", {}),
        includeResults
          ? api.invoke("danbooru.list", { limit: 500 })
          : Promise.resolve([]),
      ]);
      if (token !== generation.current) return;
      setStatus(next);
      setResults(rows);
      setError("");
    } catch (e) {
      if (token === generation.current) setError(errorText(e));
    }
  }, [includeResults]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  return { status, results, error, refresh };
}
export function DanbooruSettings() {
  return (
    <section className="if-settings-section" aria-label="Danbooru 设置">
      <h2>Danbooru 精确匹配与标签</h2>
      <p className="if-setting-description">
        使用图片 MD5 查询
        Danbooru，仅发送文件哈希，不上传图片。默认暂停，需在后台任务手动开始；单并发请求，间隔至少
        3 秒，遇到 403 / 429 自动暂停。
      </p>
      <p className="if-setting-description">
        仅 MD5 精确命中可关联标签。本功能不使用 Pixiv 作品 ID 推断匹配。Danbooru
        标签单独展示，保留原始标签和来源。
      </p>
    </section>
  );
}
export function DanbooruTasksPanel({ notify }: { notify: Notify }) {
  const { status, results, error, refresh } = useDanbooru(true);
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [selected, setSelected] = useState<{
    rootId: string;
    relativePath: string;
  } | null>(null);
  const [recursive, setRecursive] = useState(true);
  const [preview, setPreview] = useState<{
    total: number;
    eligible: number;
  } | null>(null);
  const [resultFilter, setResultFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    let alive = true;
    void api
      .invoke("library.list", {})
      .then((rows) => {
        if (alive) setRoots(rows);
      })
      .catch((e) => {
        if (alive) setActionError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const root = roots.find((row) => row.id === selected?.rootId);
  const waiting =
    status?.counts.find((row) => row.status === "waiting")?.count ?? 0;
  const count = (name: string) =>
    status?.counts.find((row) => row.status === name)?.count ?? 0;
  const runnable = waiting + count("error");
  const cancellable = waiting + count("running");
  const total = status?.counts.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const processed = [
    "done",
    "no_match",
    "unavailable",
    "error",
    "cancelled",
  ].reduce((sum, name) => sum + count(name), 0);
  return (
    <section
      className="if-task-group"
      aria-label="Danbooru 精确匹配"
      aria-busy={busy}
    >
      <div className="if-task-heading">
        <div className="if-task-icon">
          <Icon name="search" />
        </div>
        <div className="if-task-title">
          <h2>Danbooru 精确匹配</h2>
          <p>以文件哈希查找精确来源，并读取独立的 Danbooru 标签。</p>
        </div>
        <span className="if-utility-status">
          <i />
          {status ? (status.paused ? "已暂停" : "队列可运行") : "读取中"}
        </span>
        <Button disabled={busy} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>
      <div className="if-task-body">
        <p className="if-queue-note">
          仅发送 MD5，不上传图片 · 单并发 · 请求间隔至少 3 秒 · 403 / 429
          自动暂停
        </p>
        {status?.reason && (
          <p className="if-source-reason">{reasonText(status.reason)}</p>
        )}
        <p className="if-queue-counts">
          {status?.counts
            .map(
              (row) =>
                `${statusName[row.status] || row.status} ${row.count.toLocaleString()}`,
            )
            .join(" · ") || "尚无匹配任务"}
        </p>
        <div className="if-queue-progress" aria-label="Danbooru 队列进度">
          <div className="if-queue-progress-label">
            <strong>
              已处理 {processed.toLocaleString()} / {total.toLocaleString()}
            </strong>
            <span>
              {total
                ? `${((processed / total) * 100).toFixed(1)}%`
                : "尚无任务"}
            </span>
          </div>
          {total > 0 && (
            <div
              className="if-queue-track"
              role="progressbar"
              aria-label="Danbooru 已处理比例"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={processed}
            >
              <span style={{ width: `${(processed / total) * 100}%` }} />
            </div>
          )}
          <p className="if-queue-note">
            已处理包含精确匹配、无匹配、来源不可用、失败及取消；新增任务或重试会改变进度。
          </p>
        </div>
        <details className="if-pixiv-task-scope">
          <summary>选择目录并预览匹配范围</summary>
          <div
            className="if-pixiv-scope-tree"
            aria-label="选择 Danbooru 匹配目录"
          >
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
                if (busy) return;
                setPreview(null);
                if (section.startsWith("root:"))
                  setSelected({ rootId: section.slice(5), relativePath: "" });
                else if (section.startsWith("directory:")) {
                  const [rootId, relativePath] = JSON.parse(
                    section.slice(10),
                  ) as [string, string];
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
                ? `${root.path}${selected?.relativePath ? ` / ${selected.relativePath}` : ""}`
                : "尚未选择目录"}
            </code>
          </p>
          <label className="if-pixiv-option">
            <input
              type="checkbox"
              disabled={busy}
              checked={recursive}
              onChange={(event) => {
                setRecursive(event.target.checked);
                setPreview(null);
              }}
            />
            包含所有子文件夹
          </label>
          <div className="if-pixiv-batch-actions">
            <Button
              disabled={busy || !selected}
              onClick={() =>
                void act(async () => {
                  if (selected)
                    setPreview(
                      await api.invoke("danbooru.preview", {
                        ...selected,
                        recursive,
                      }),
                    );
                })
              }
            >
              预览范围
            </Button>
            <Button
              disabled={
                busy || !selected || !status?.paused || !preview?.eligible
              }
              onClick={() =>
                void act(async () => {
                  if (!selected) return;
                  const result = await api.invoke("danbooru.enqueue", {
                    ...selected,
                    recursive,
                  });
                  setPreview(null);
                  notify(`已将 ${result.added} 张图片加入 Danbooru 队列`);
                })
              }
            >
              加入队列
            </Button>
          </div>
          {preview && (
            <p role="status" className="if-queue-note">
              范围内共 {preview.total.toLocaleString()} 张，可加入{" "}
              {preview.eligible.toLocaleString()} 张。加入队列后仍需手动开始。
            </p>
          )}
        </details>
        <div className="if-pixiv-batch-actions">
          <Button
            variant="primary"
            disabled={busy || !status?.paused || !runnable}
            onClick={() => void act(() => api.invoke("danbooru.resume", {}))}
          >
            开始匹配 / 继续
          </Button>
          <Button
            disabled={busy || !status || status.paused}
            onClick={() => void act(() => api.invoke("danbooru.pause", {}))}
          >
            暂停匹配
          </Button>
          <Button
            disabled={busy || !cancellable}
            onClick={() =>
              void act(async () => {
                await api.invoke("danbooru.cancel", {});
                notify("已取消等待和当前匹配任务，已完成结果保留");
              })
            }
          >
            取消等待和当前任务
          </Button>
        </div>
        <p className="if-queue-note">
          开始后处理整个 Danbooru 队列。仅 MD5
          精确命中绑定标签，不使用作品页或页码推断匹配。
        </p>
        {(actionError || error) && (
          <p className="if-pixiv-error" role="alert">
            {actionError || error}
          </p>
        )}
        <details className="if-sauce-results">
          <summary>匹配结果（最近最多 500 项）</summary>
          <select
            aria-label="筛选 Danbooru 匹配结果"
            className="if-select"
            value={resultFilter}
            onChange={(event) => setResultFilter(event.target.value)}
          >
            <option value="all">全部状态</option>
            {Object.entries(statusName)
              .filter(([key]) =>
                [
                  "waiting",
                  "running",
                  "done",
                  "no_match",
                  "unavailable",
                  "error",
                  "cancelled",
                ].includes(key),
              )
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
          {results
            .filter(
              (row) => resultFilter === "all" || row.status === resultFilter,
            )
            .map((row) => (
              <div className="if-sauce-result" key={row.fileId}>
                <strong>{row.relativePath}</strong>
                <span>
                  {statusName[row.status] || row.status}
                  {row.postId ? ` · Danbooru #${row.postId}` : ""}
                  {row.matchedBy ? ` · ${row.matchedBy}` : ""}
                </span>
                {row.error && (
                  <p className="if-source-reason">
                    {row.error === "post_banned"
                      ? "帖子已被 Danbooru 禁用，未导入标签"
                      : row.error === "post_deleted"
                        ? "帖子已删除，未导入标签"
                        : row.error}
                  </p>
                )}
              </div>
            ))}
          {!results.length && <p className="if-queue-note">暂无匹配结果。</p>}
        </details>
      </div>
    </section>
  );
}
export function DanbooruImageTags({
  fileId,
  notify,
}: {
  fileId: string;
  notify: Notify;
}) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setTags([]);
    setError("");
    void api
      .invoke("danbooru.tags", { fileId })
      .then((rows) => {
        if (alive) setTags(rows);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [fileId, refresh]);
  const categories: Record<string, string> = {
    "0": "通用",
    "1": "画师",
    "3": "作品",
    "4": "角色",
    "5": "元信息",
    general: "通用",
    artist: "画师",
    copyright: "作品",
    character: "角色",
    meta: "元信息",
  };
  return (
    <section className="if-info-section" aria-label="Danbooru 标签">
      <div className="if-info-section-heading">
        <h3>Danbooru 标签</h3>
        <Button
          variant="ghost"
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新
        </Button>
      </div>
      <p className="if-info-hint">独立来源标签，仅 MD5 精确匹配自动关联。</p>
      {(["character", "copyright", "artist", "general", "meta"] as const).map(
        (category) => {
          const group = tags.filter((tag) => tag.category === category);
          return (
            group.length > 0 && (
              <div className="if-info-tag-row" key={category}>
                <span
                  className="if-info-tag-label"
                  style={{
                    minWidth: "3em",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {categories[category]}
                </span>
                <div className="if-tags-wrap">
                  {group.map((tag) => (
                    <span
                      className="if-tag"
                      key={`${tag.postId}:${tag.name}`}
                      title={`${tag.name} · Danbooru #${tag.postId} · ${tag.matchedBy}`}
                    >
                      {tag.displayName || tag.name}
                    </span>
                  ))}
                </div>
              </div>
            )
          );
        },
      )}
      {!tags.length && <p className="if-info-hint">尚无 Danbooru 标签。</p>}
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void api
            .invoke("danbooru.enqueueFile", { fileId })
            .then((result) =>
              notify(
                result.added
                  ? "本图已加入 Danbooru 队列；运行中将随后执行，暂停时请在后台任务手动开始"
                  : "本图已在队列中或无需重复匹配",
              ),
            )
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      >
        本图加入 Danbooru 队列
      </Button>
      <p className="if-info-hint">仅发送文件哈希，不上传图片。</p>
      {error && (
        <p className="if-pixiv-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
