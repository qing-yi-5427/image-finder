import { useCallback, useEffect, useRef, useState } from "react";
import type { MethodMap } from "../src/api";
import type { LibraryRoot } from "../src/contracts";
import { api } from "./client";
import { DirectoryTree, directorySection } from "./DirectoryTree";
import { Button, Icon } from "./ui";
import "./SaucePanel.css";

type Notify = (
  text: string,
  undo?: () => void,
  kind?: "success" | "error",
) => void;
type SauceStatus = MethodMap["sauce.status"]["result"];
type SauceResult = MethodMap["sauce.list"]["result"][number];
const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);
const statusNames: Record<string, string> = {
  waiting: "等待识别",
  running: "正在识别",
  review: "等待人工确认",
  confirmed: "已确认",
  rejected: "已拒绝",
  no_match: "未找到匹配",
  error: "识别失败",
  uncertain: "请求结果不确定",
};
function pauseReason(reason: string | null) {
  if (!reason) return "";
  if (reason === "user") return "已手动暂停。";
  if (reason === "not_started") return "尚未开始识别。";
  if (reason.includes("key") || reason.includes("config"))
    return "请先在设置中配置 SauceNAO API 密钥。";
  if (reason.includes("limit") || reason.includes("quota"))
    return "请求额度受限，已暂停识别；请等待额度恢复后继续。";
  if (reason.includes("uncertain"))
    return "上次请求结果不确定，已暂停；请检查结果后再继续。";
  return reason;
}

function useSauce(includeResults: boolean) {
  const [status, setStatus] = useState<SauceStatus | null>(null);
  const [results, setResults] = useState<SauceResult[]>([]);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const request = useRef(0);
  const loading = useRef(false);
  const refresh = useCallback(
    async (force = false) => {
      if (loading.current && !force) return;
      const token = ++request.current;
      loading.current = true;
      try {
        const [next, rows] = await Promise.all([
          api.invoke("sauce.status", {}),
          includeResults
            ? api.invoke("sauce.list", { limit: 500 })
            : Promise.resolve([]),
        ]);
        if (!alive.current || token !== request.current) return;
        setStatus(next);
        setResults(rows);
        setError("");
      } catch (failure) {
        if (alive.current && token === request.current)
          setError(message(failure));
      } finally {
        if (token === request.current) loading.current = false;
      }
    },
    [includeResults],
  );
  useEffect(() => {
    alive.current = true;
    void refresh(true);
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      alive.current = false;
      request.current++;
      loading.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  return { status, results, error, refresh };
}

export function SauceSettings({ notify }: { notify: Notify }) {
  const { status, error, refresh } = useSauce(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const save = async () => {
    if (busy || !keyInput.current) return;
    const apiKey = keyInput.current.value.trim();
    keyInput.current.value = "";
    setHasKey(false);
    if (!apiKey) return;
    setBusy(true);
    setSaveError("");
    try {
      await api.invoke("sauce.configure", { apiKey });
      await refresh(true);
      notify("SauceNAO 密钥已保存");
    } catch {
      // Configuration failures must never echo a key from a remote error message.
      setSaveError("密钥保存失败，请检查设置后重新输入。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="if-settings-section if-sauce-settings"
      aria-label="SauceNAO 设置"
    >
      <h2>SauceNAO 以图找来源</h2>
      <p role="status">
        {status
          ? status.configured
            ? "API 密钥已配置"
            : "尚未配置 API 密钥"
          : "正在读取配置状态…"}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="if-utility-field">
          <span>SauceNAO API 密钥</span>
          <input
            ref={keyInput}
            className="if-input"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy}
            placeholder="输入新密钥"
            onChange={(event) => setHasKey(!!event.currentTarget.value.trim())}
          />
        </label>
        <Button type="submit" disabled={busy || !hasKey}>
          {busy ? "正在保存…" : "保存密钥"}
        </Button>
        <Button
          type="button"
          disabled={busy || !status?.configured}
          onClick={() => {
            setBusy(true);
            void api
              .invoke("sauce.configure", { apiKey: "" })
              .then(() => refresh(true))
              .then(() => notify("SauceNAO 密钥已移除"))
              .catch(() => setSaveError("移除密钥失败，请重试。"))
              .finally(() => setBusy(false));
          }}
        >
          移除密钥
        </Button>
      </form>
      <p className="if-setting-description">
        密钥提交后输入框立即清空，已保存密钥不会回显。在后台任务中选择目录并开始识别；开始后会向
        SauceNAO 上传压缩预览图。
      </p>
      {(saveError || error) && (
        <p className="if-pixiv-error" role="alert">
          {saveError || error}
        </p>
      )}
    </section>
  );
}

export function SauceTasksPanel({ notify }: { notify: Notify }) {
  const { status, results, error, refresh } = useSauce(true);
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [selected, setSelected] = useState<{
    rootId: string;
    relativePath: string;
  } | null>(null);
  const [recursive, setRecursive] = useState(true);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    let alive = true;
    void api
      .invoke("library.list", {})
      .then((value) => {
        if (alive) setRoots(value);
      })
      .catch((failure) => {
        if (alive) setActionError(message(failure));
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
      await refresh(true);
    } catch (failure) {
      setActionError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  const root = roots.find((item) => item.id === selected?.rootId);
  const reviewing = results.filter((item) => item.status === "review");
  const otherResults = results.filter((item) => item.status !== "review");
  const totalResults =
    status?.counts.reduce((total, row) => total + row.count, 0) ?? 0;
  const remaining = (value: number | null | undefined) =>
    value == null ? "未知" : value.toLocaleString();
  return (
    <section
      className="if-task-group if-sauce-tasks"
      aria-label="SauceNAO 来源识别"
      aria-busy={busy}
    >
      <div className="if-task-heading">
        <div className="if-task-icon">
          <Icon name="search" />
        </div>
        <div className="if-task-title">
          <h2>SauceNAO 来源识别</h2>
          <p>为缺少 Pixiv ID 的图片寻找候选来源，由你确认关联。</p>
        </div>
        <span className="if-utility-status">
          <i />
          {status ? (status.paused ? "已暂停" : "队列可运行") : "读取中"}
        </span>
        <Button disabled={busy} onClick={() => void refresh(true)}>
          刷新
        </Button>
      </div>
      <div className="if-task-body">
        {status && !status.configured && (
          <p className="if-source-reason">
            请先在设置中保存 SauceNAO API 密钥。
          </p>
        )}
        {status?.reason && (
          <p className="if-source-reason">{pauseReason(status.reason)}</p>
        )}
        <p className="if-queue-note">
          短期剩余额度 {remaining(status?.shortRemaining)} · 长期剩余额度{" "}
          {remaining(status?.longRemaining)}
        </p>
        <p className="if-queue-counts">
          {status?.counts
            .map(
              (row) =>
                `${statusNames[row.status] || row.status} ${row.count.toLocaleString()}`,
            )
            .join(" · ") || "尚无识别任务"}
        </p>
        <details className="if-pixiv-task-scope">
          <summary>选择目录加入识别队列</summary>
          <p className="if-setting-description">
            仅将所选范围内缺少 Pixiv ID
            的图片加入队列。请先暂停队列后添加图片，点击“开始识别”时才会上传压缩预览图。
          </p>
          <div className="if-pixiv-scope-tree" aria-label="选择识别目录">
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
              checked={recursive}
              onChange={(event) => setRecursive(event.target.checked)}
            />
            包含所有子文件夹
          </label>
          <Button
            disabled={busy || !selected || !status?.paused}
            onClick={() =>
              void act(async () => {
                if (!selected) return;
                const result = await api.invoke("sauce.enqueue", {
                  ...selected,
                  recursive,
                });
                notify(
                  `已将 ${result.added} 张缺少 Pixiv ID 的图片加入识别队列`,
                );
              })
            }
          >
            仅将缺少 Pixiv ID 的图片入队
          </Button>
        </details>
        <label className="if-pixiv-option if-sauce-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          我同意开始识别后向 SauceNAO 上传队列图片的压缩预览图。
        </label>
        <div className="if-pixiv-batch-actions">
          <Button
            variant="primary"
            disabled={busy || !status?.configured || !status.paused || !consent}
            onClick={() => void act(() => api.invoke("sauce.resume", {}))}
          >
            开始识别 / 继续
          </Button>
          <Button
            disabled={busy || !status || status.paused}
            onClick={() => void act(() => api.invoke("sauce.pause", {}))}
          >
            暂停识别
          </Button>
          <Button
            disabled={busy || !status?.paused}
            onClick={() =>
              void act(async () => {
                const result = await api.invoke("sauce.importLedger", {});
                if (result)
                  notify(
                    `已导入 ${result.imported} 项识别结果，跳过 ${result.skipped} 项`,
                  );
              })
            }
          >
            导入已有识别结果 JSON
          </Button>
        </div>
        <p className="if-queue-note">
          如已通过独立识别工具完成搜索，重启新版后可手动选择结果 JSON
          导入；导入会核验对应图片，并保留人工确认步骤。
        </p>
        <p className="if-queue-note">
          开始后会处理整个 SauceNAO 队列。候选结果不会自动绑定 Pixiv
          ID；请打开官方作品页比对后确认，未知页码保持为空。
        </p>
        {(actionError || error) && (
          <p className="if-pixiv-error" role="alert">
            {actionError || error}
          </p>
        )}
        <div className="if-sauce-results" aria-label="来源识别结果">
          <h3>待确认候选（{reviewing.length}）</h3>
          <p className="if-queue-note">
            已加载 {results.length.toLocaleString()} /{" "}
            {totalResults.toLocaleString()} 项识别任务。
          </p>
          {!reviewing.length && (
            <p className="if-queue-note">当前已读取的结果中没有待确认候选。</p>
          )}
          {reviewing.map((item) => (
            <SauceReview
              key={item.fileId}
              item={item}
              busy={busy}
              onOpen={(artworkId) =>
                void act(() =>
                  api.invoke("sauce.openCandidate", {
                    fileId: item.fileId,
                    artworkId,
                  }),
                )
              }
              onReview={(artworkId, action) =>
                void act(async () => {
                  await api.invoke("sauce.review", {
                    fileId: item.fileId,
                    action,
                    ...(artworkId ? { artworkId, page: null } : {}),
                  });
                  notify(
                    action === "confirm"
                      ? "已确认 Pixiv 作品关联，页码保持未知"
                      : "已拒绝本次候选",
                  );
                })
              }
            />
          ))}
          <details className="if-pixiv-task-scope">
            <summary>其他识别结果（{otherResults.length}）</summary>
            {otherResults.map((item) => (
              <div className="if-sauce-result" key={item.fileId}>
                <strong>{item.relativePath}</strong>
                <span>{statusNames[item.status] || item.status}</span>
                {item.error && <p className="if-source-reason">{item.error}</p>}
              </div>
            ))}
            {!otherResults.length && (
              <p className="if-queue-note">暂无其他识别结果。</p>
            )}
          </details>
          <p className="if-queue-note">
            每次最多显示 500 项结果，已加载的待确认项优先列出。
          </p>
        </div>
      </div>
    </section>
  );
}

function SauceReview({
  item,
  busy,
  onOpen,
  onReview,
}: {
  item: SauceResult;
  busy: boolean;
  onOpen: (artworkId: string) => void;
  onReview: (
    artworkId: string | undefined,
    action: "confirm" | "reject",
  ) => void;
}) {
  return (
    <article className="if-sauce-result">
      <strong>{item.relativePath}</strong>
      {item.candidates.map((candidate) => {
        const url = /^\d+$/.test(candidate.artworkId)
          ? `https://www.pixiv.net/artworks/${candidate.artworkId}`
          : null;
        return (
          <div className="if-sauce-candidate" key={candidate.artworkId}>
            <div>
              <strong>
                {candidate.title || `Pixiv 作品 ${candidate.artworkId}`}
              </strong>
              <p>
                相似度{" "}
                {Number.isFinite(candidate.similarity)
                  ? `${candidate.similarity.toFixed(2)}%`
                  : "未知"}{" "}
                · ID {candidate.artworkId}
              </p>
              {url && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onOpen(candidate.artworkId)}
                >
                  打开 Pixiv 官方作品页
                </Button>
              )}
            </div>
            <Button
              disabled={busy || !url}
              onClick={() => onReview(candidate.artworkId, "confirm")}
            >
              确认此作品
            </Button>
          </div>
        );
      })}
      <Button disabled={busy} onClick={() => onReview(undefined, "reject")}>
        拒绝本次全部候选
      </Button>
    </article>
  );
}
