import { api } from "./client";
import React, { useEffect, useRef, useState } from "react";
import { Button, Icon, Modal } from "./ui";
import type {
  LibraryRoot,
  LocalTaskStatus,
  ProgressEvent,
  JobStatus,
} from "../src/contracts";
import type { MethodMap, NetworkStatus, SettingsDto } from "../src/api";
import "./UtilityPages.css";
import { AiTasksPanel } from "./AiPanel";
import { AiEnvironmentSettings } from "./AiEnvironmentSettings";
import { TaskOverview } from "./TaskOverview";
import { networkSummary } from "./network-status";
import { PixivBatchPanel } from "./PixivBatchPanel";
import { QueueProgress } from "./QueueProgress";
import { PixivQueueSettingsForm } from "./PixivQueueSettings";
import { PixivJobsList } from "./PixivJobsList";
import { SauceSettings, SauceTasksPanel } from "./SaucePanel";
import { DanbooruSettings, DanbooruTasksPanel } from "./DanbooruPanel";
type Notify = (
  text: string,
  undo?: () => void,
  kind?: "success" | "error",
) => void;

const error = (e: unknown) => (e instanceof Error ? e.message : String(e));
function Status({ children }: { children: React.ReactNode }) {
  return (
    <span className="if-utility-status">
      <i />
      {children}
    </span>
  );
}
function useAction(notify: Notify) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
      } catch (e) {
        notify(error(e), undefined, "error");
      } finally {
        setBusy(false);
      }
    },
  };
}

function sourceReason(reason: string) {
  if (reason === "user") return "已手动暂停。";
  if (reason === "batch_rest") return "本批请求已用完，正在自动休息；截止后将继续下一批。";
  if (reason === "not_started") return "尚未开始来源补全。";
  if (reason.startsWith("rate_limit")) return "来源请求受限，已立即暂停全队列；冷却结束后仍需手动继续。";
  if (reason.includes("needs_login")) return "登录状态需要确认，已暂停来源队列。请在设置中检查登录。";
  if (reason.includes("restricted")) return "来源拒绝访问，已暂停队列。请检查登录状态和访问权限。";
  if (reason.includes("challenge")) return "来源返回登录或安全验证页面，已暂停队列。请在登录窗口手动处理。";
  if (reason.includes("budget") || reason.includes("batch_limit")) return "已达到本批尝试上限，队列已暂停。";
  return reason;
}

export function TasksPage({ notify }: { notify: Notify }) {
  const [local, setLocal] = useState<LocalTaskStatus | null>(null),
    [jobs, setJobs] = useState<MethodMap["jobs.list"]["result"] | null>(null),
    [network, setNetwork] = useState<NetworkStatus | null>(null),
    [offset, setOffset] = useState(0),
    [ids, setIds] = useState(""),
    [jobStatus, setJobStatus] = useState<JobStatus | "">(""),
    [artworkId, setArtworkId] = useState(""),
    [search, setSearch] = useState(""),
    [jobsError, setJobsError] = useState(""),
    [jobsLoading, setJobsLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const resting = jobs?.source.reason === "batch_rest";
  const userPaused = !!jobs?.source.paused && !resting;
  const queueLabel = resting ? "批次休息中" : jobs?.source.paused ? "已暂停" : jobs && jobs.source.pause_until > now ? "间隔等待中" : "队列可运行";
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  useEffect(() => { const timer = setTimeout(() => setSearch(artworkId), 250); return () => clearTimeout(timer); }, [artworkId]);
  const { busy, run } = useAction(notify);
  const refresh = async () => {
    const token = ++request.current;
    try {
    const [l, j, n] = await Promise.all([
      api.invoke("local.status", {}),
      api.invoke("jobs.list", { offset, limit: 30, ...(jobStatus ? { statuses: [jobStatus] } : {}), ...(search ? { artworkId: search } : {}) }),
      api.invoke("network.status", {}),
    ]);
    if (!mounted.current || request.current !== token) return;
    if (offset > 0 && offset >= j.total) { setOffset(Math.max(0, Math.ceil(j.total / 30) - 1) * 30); return; }
    setLocal(l);
    setJobs(j);
    setNetwork(n);
    setJobsError("");
    } catch (failure) {
      if (mounted.current && request.current === token) setJobsError(error(failure));
    } finally {
      if (mounted.current && request.current === token) setJobsLoading(false);
    }
  };
  useEffect(() => {
    let alive = true;
    setJobsLoading(true);
    const load = () =>
      refresh().catch((e) => {
        if (alive) notify(error(e), undefined, "error");
      });
    load();
    const timer = setInterval(load, 4000);
    const off = api.onProgress((e) => {
      if (alive) setLocal(e.local);
    });
    return () => {
      alive = false;
      request.current++;
      clearInterval(timer);
      off();
    };
  }, [offset, jobStatus, search]);
  const act = (action: () => Promise<unknown>) =>
    run(async () => {
      await action();
      await refresh();
    });
  return (
    <div className="if-utilities if-tasks-page">
      <header className="if-utility-page-heading">
        <div>
          <h1 className="if-page-title">后台任务</h1>
          <p className="if-subtitle">本地处理与来源补全的实际状态。</p>
        </div>
        <Button disabled={busy} onClick={() => act(refresh)}>
          刷新
        </Button>
      </header>
      <TaskOverview notify={notify} controls={{
        pixiv: <>{jobsError && <p role="alert" className="if-task-load-error">{jobsError}</p>}        <article className="if-task-group">
          <div className="if-task-heading">
            <div className="if-task-icon">
              <Icon name="globe-2" />
            </div>
            <div className="if-task-title">
              <h2>Pixiv 信息补全</h2>
              <p>
                {networkSummary(network)}
              </p>
            </div>
            <Status>{jobs ? queueLabel : "读取中"}</Status>
            <Button
              disabled={busy || !jobs}
              onClick={() =>
                act(() =>
                  api.invoke(
                    userPaused ? "jobs.resume" : "jobs.pause",
                    userPaused && jobs ? { nextBatch: jobs.source.batch_used >= jobs.source.batchLimit } : {},
                  ),
                )
              }
            >
              {userPaused && jobs ? jobs.source.batch_used >= jobs.source.batchLimit ? "继续下一批" : "继续补全" : resting ? "暂停自动继续" : "暂停补全"}
            </Button>
            <Button
              disabled={busy || !jobs?.counts.some(row => ["failed", "needs_login"].includes(row.status) && row.count > 0)}
              onClick={() => act(() => api.invoke("jobs.retry", {}))}
            >
              重试失败
            </Button>
          </div>
          <div className="if-task-body">
            <QueueProgress counts={jobs ? Object.fromEntries(jobs.counts.map(row => [row.status, row.count])) : null} label="Pixiv 信息补全" state={jobs?.counts.some(row => row.status === "running" && row.count > 0) && !jobs.source.paused ? "正在处理" : queueLabel} />
            {jobs?.source.runScope && <div className="if-queue-note" role="status">
              当前运行目录：{jobs.source.runScope.relativePath || "图库根目录"}{jobs.source.runScope.recursive ? "（含子目录）" : "（不含子目录）"}，本范围待处理 {jobs.source.scopePending} 个作品。
              <Button disabled={busy || jobs.counts.some(row => row.status === "running" && row.count > 0)} onClick={() => act(async () => { await api.invoke("jobs.clearRunScope", {}); notify("已清除目录范围，队列保持暂停；继续补全将处理全库待办"); })}>清除范围并暂停</Button>
            </div>}
            {jobs?.source.reason && <p className="if-source-reason">{sourceReason(jobs.source.reason)}</p>}
            {jobs && <p className="if-queue-note">本批已请求 {jobs.source.batch_used} / {jobs.source.batchLimit} 次，剩余 {Math.max(0, jobs.source.batchLimit - jobs.source.batch_used)} 次。普通暂停、重启及重试不会重置计数。</p>}
            {!!jobs && jobs.source.pause_until > Date.now() && <p className="if-queue-note">最早可请求时间：{new Date(jobs.source.pause_until).toLocaleString()}。继续或重试不会跳过冷却。</p>}
            {!!jobs && jobs.source.rest_until > now && <p className="if-queue-note" role="status">批次休息剩余 {Math.ceil((jobs.source.rest_until - now) / 1000)} 秒，截止 {new Date(jobs.source.rest_until).toLocaleString()}。{resting ? "到时自动继续。" : "已停止自动继续，须手动继续；原休息截止时间仍有效。"}</p>}
            {jobs && <p className="if-queue-note">仅按作品 ID 获取文字信息，不上传图片。当前请求间隔 {jobs.source.settings.intervalMinSeconds}–{jobs.source.settings.intervalMaxSeconds} 秒，每批 {jobs.source.batchLimit} 次，{jobs.source.settings.autoRest ? `批次间自动休息 ${jobs.source.settings.restMinutes} 分钟` : "批次间手动继续"}；这些是用户设置，并非官方安全额度。</p>}
            <details className="if-pixiv-task-scope"><summary>调整 Pixiv 请求设置</summary><PixivQueueSettingsForm notify={notify} onSaved={() => void refresh()} /></details>
            <details className="if-pixiv-task-scope"><summary>手动添加作品编号</summary>
            <label className="if-utility-field">
              <span>手动添加作品编号（每次最多 20 个，以空格或逗号分隔）</span>
              <input
                className="if-input"
                value={ids}
                onChange={(e) => setIds(e.target.value)}
              />
            </label>
            <Button
              disabled={busy || !ids.trim()}
              onClick={() =>
                act(async () => {
                  const list = [
                    ...new Set(ids.split(/[\s,，]+/).filter(Boolean)),
                  ];
                  if (list.length > 20 || list.some((x) => !/^\d+$/.test(x)))
                    throw new Error("请输入最多 20 个数字作品编号");
                  const n = await api.invoke("jobs.enqueue", {
                    artworkIds: list,
                  });
                  setIds("");
                  notify(
                    `已添加 ${n} 个作品${jobs?.source.paused ? "；点击继续补全后运行" : ""}`,
                  );
                })
              }
            >
              加入队列
            </Button></details>
            <details className="if-pixiv-task-scope"><summary>按目录批量补全</summary><PixivBatchPanel notify={notify} onQueued={refresh}/></details>
          </div>
        </article>
      <PixivJobsList jobs={jobs} loading={jobsLoading} status={jobStatus} artworkId={artworkId} offset={offset} busy={busy} onStatus={value => { setJobStatus(value); setOffset(0); }} onSearch={value => { setArtworkId(value); setOffset(0); }} onOffset={setOffset} onRetry={id => { void act(() => api.invoke("jobs.retry", { jobIds: [id] })); }} /></>,
        wd: <AiTasksPanel notify={notify} onlyKind="wd" />,
        semantic: <AiTasksPanel notify={notify} onlyKind="semantic" />,
        danbooru: <DanbooruTasksPanel notify={notify} />,
        sauce: <SauceTasksPanel notify={notify} />,
        local: <section className="if-task-list">        {(["scan", "images"] as const).map((kind) => {
          const paused =
            kind === "scan" ? local?.scanPaused : local?.imagesPaused;
          return (
            <article className="if-task-group" key={kind}>
              <div className="if-task-heading">
                <div className="if-task-icon">
                  <Icon name={kind === "scan" ? "folder-search" : "images"} />
                </div>
                <div className="if-task-title">
                  <h2>{kind === "scan" ? "本地扫描" : "缩略图与颜色"}</h2>
                  <p>
                    {kind === "scan"
                      ? `已发现 ${local?.discovered ?? 0} · 待扫描目录 ${local?.pendingRoots.length ?? 0}`
                      : `待处理 ${local?.images.pending ?? 0} · 已就绪 ${local?.images.ready ?? 0} · 失败 ${local?.images.failed ?? 0}`}
                  </p>
                </div>
                <Status>
                  {paused
                    ? "已暂停"
                    : kind === "scan"
                      ? local?.activeRoot
                        ? "正在扫描"
                        : "空闲"
                      : local?.running
                        ? "处理中"
                        : "空闲"}
                </Status>
                <Button
                  disabled={busy || !local}
                  onClick={() =>
                    act(() =>
                      api.invoke(paused ? "local.resume" : "local.pause", {
                        kind,
                      }),
                    )
                  }
                >
                  {paused ? "继续" : "暂停"}
                </Button>
                {kind === "images" && (
                  <Button
                    disabled={busy}
                    onClick={() => act(() => api.invoke("local.retry", {}))}
                  >
                    重试失败图片
                  </Button>
                )}
              </div>
              {kind === "images" && local && (
                <div className="if-task-body">
                  <div className="if-utility-progress">
                    <span
                      style={{
                        width: `${(100 * local.images.ready) / Math.max(1, local.images.ready + local.images.pending + local.images.failed)}%`,
                      }}
                    />
                  </div>
                  <p>
                    已准备 {local.images.ready} /{" "}
                    {local.images.ready +
                      local.images.pending +
                      local.images.failed}{" "}
                    张
                  </p>
                </div>
              )}
              {local?.lastError && (
                <div className="if-task-body">{local.lastError}</div>
              )}
            </article>
          );
        })}
</section>,
      }} />
    </div>
  );
}
export function DirectoriesPage({
  notify,
  onBrowse,
  onChanged,
}: {
  notify: Notify;
  onBrowse?: (rootId?: string) => void;
  onChanged?: () => void;
}) {
  const [roots, setRoots] = useState<LibraryRoot[]>([]),
    [remove, setRemove] = useState<LibraryRoot | null>(null);
  const { busy, run } = useAction(notify);
  const refresh = async () => setRoots(await api.invoke("library.list", {}));
  useEffect(() => {
    refresh().catch((e) => notify(error(e), undefined, "error"));
  }, []);
  const act = (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      await refresh();
      onChanged?.();
    });
  return (
    <div className="if-utilities if-directories-page">
      <header className="if-utility-page-heading">
        <div>
          <h1 className="if-page-title">原目录</h1>
          <p className="if-subtitle">关联真实文件夹，原文件保留在原处。</p>
          <p className="if-subtitle">
            重新定位时请选择整个原目录的新位置；只浏览图片请点击“浏览图片”。
          </p>
        </div>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => act(() => api.invoke("library.add", {}))}
        >
          <Icon name="folder-plus" />
          添加目录
        </Button>
      </header>
      <section className="if-task-list">
        {roots.map((root) => (
          <article className="if-task-group" key={root.id}>
            <div className="if-task-heading">
              <div className="if-task-icon">
                <Icon name="folder" />
              </div>
              <div className="if-task-title">
                <h2>{root.path.split(/[\\/]/).filter(Boolean).at(-1)}</h2>
                <p className="if-utility-path">{root.path}</p>
              </div>
              <Status>
                {root.status === "online"
                  ? "在线"
                  : root.status === "offline"
                    ? "离线"
                    : "部分可用"}
              </Status>
            </div>
            <div className="if-task-body">
              <p>
                上次扫描：
                {root.lastScanAt
                  ? new Date(root.lastScanAt).toLocaleString()
                  : "尚未扫描"}
              </p>
              <Button onClick={() => onBrowse?.(root.id)}>浏览图片</Button>{" "}
              <Button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const r = await api.invoke("library.scan", {
                      rootId: root.id,
                    });
                    notify(
                      r.errors.length
                        ? `扫描未完成：${r.errors[0]} 原有索引已保留。`
                        : `扫描${r.complete ? "完成" : "已暂停"}：新增 ${r.added}，变化 ${r.changed}，缺失 ${r.missing}`,
                      undefined,
                      r.errors.length ? "error" : "success",
                    );
                  })
                }
              >
                扫描目录
              </Button>{" "}
              <Button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const selected = await api.invoke("library.relocate", {
                      rootId: root.id,
                    });
                    if (!selected) return;
                    const state = await api.invoke("local.status", {});
                    notify(
                      state.scanPaused
                        ? "目录已关联；扫描已排队且处于暂停状态，可点击扫描目录。"
                        : "目录已关联，已安排重新扫描；原有整理信息已保留。",
                    );
                  })
                }
              >
                重新定位
              </Button>{" "}
              <Button disabled={busy} onClick={() => setRemove(root)}>
                移除索引
              </Button>
            </div>
          </article>
        ))}
        {!roots.length && (
          <div className="if-utility-empty-small">
            <Icon name="folder-plus" />
            <strong>尚未添加原目录</strong>
            <p>添加文件夹开始建立本地图片索引。</p>
          </div>
        )}
      </section>
      {remove && (
        <Modal
          title="移除目录索引？"
          onClose={() => !busy && setRemove(null)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setRemove(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api.invoke("library.remove", { rootId: remove.id });
                    setRemove(null);
                    notify("已移除目录索引");
                  })
                }
              >
                确认移除索引
              </Button>
            </>
          }
        >
          <p>{remove.path}</p>
          <p>将移除此目录的图片索引与关联整理信息。原始图片文件不会被删除。</p>
        </Modal>
      )}
    </div>
  );
}
export function SettingsPage({
  theme,
  setTheme,
  density,
  setDensity,
  notify,
}: {
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  density: string;
  setDensity: (density: "comfortable" | "compact") => void;
  notify: Notify;
}) {
  const [settings, setSettings] = useState<SettingsDto | null>(null),
    [network, setNetwork] = useState<NetworkStatus | null>(null),
    [limit, setLimit] = useState("10"),
    [mode, setMode] = useState<"system" | "direct" | "custom">("system"),
    [proxy, setProxy] = useState(""),
    [confirm, setConfirm] = useState<"restore" | "clearCache" | null>(null);
  const [power,setPower]=useState<{enabled:boolean;active:boolean;error:string|null}|null>(null);
  const [powerBusy,setPowerBusy]=useState(false);
  const [powerError,setPowerError]=useState("");
  const [appVersion,setAppVersion]=useState<{version:string;packaged:boolean}|null>(null);
  const [versionError,setVersionError]=useState(false);
  useEffect(()=>{let alive=true;void api.invoke("app.version",{}).then(value=>{if(alive)setAppVersion(value);}).catch(()=>{if(alive)setVersionError(true);});return()=>{alive=false};},[]);
  useEffect(()=>{let alive=true;void api.invoke("power.get",{}).then(value=>{if(alive)setPower(value)}).catch(e=>{if(alive)setPowerError(error(e))});return()=>{alive=false}},[]);
  useEffect(()=>api.onAppEvent?.(event=>{if(event.type==="power"){setPower(event.status);setPowerError(event.status.error??"");}}),[]);
  const { busy, run } = useAction(notify);
  const refresh = async () => {
    const [s, n] = await Promise.all([
      api.invoke("settings.get", {}),
      api.invoke("network.status", {}),
    ]);
    setSettings(s);
    setLimit(String(s.cacheLimitBytes / 1024 ** 3));
    setNetwork(n);
    setMode(n.proxy.mode);
    setProxy(n.proxy.proxyRules || "");
  };
  useEffect(() => {
    refresh().catch((e) => notify(error(e), undefined, "error"));
  }, []);
  useEffect(()=>{let alive=true;const timer=setInterval(()=>{void api.invoke('network.status',{}).then(value=>{if(alive)setNetwork(value);}).catch(()=>{});},1500);return()=>{alive=false;clearInterval(timer);};},[]);
  const act = (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      await refresh();
    });
  return (
    <div className="if-utilities if-settings-page">
      <header className="if-utility-page-heading">
        <div>
          <h1 className="if-page-title">设置</h1>
          <p className="if-subtitle">管理显示、缓存与来源连接。</p>
          <p className="if-subtitle" aria-label="当前运行版本">{appVersion?`Image Finder ${appVersion.version}${appVersion.packaged?"":" · 开发模式"}`:versionError?"运行版本读取失败":"正在读取运行版本…"}</p>
        </div>
      </header>
      <section className="if-settings-section">
        <h2>外观</h2>
        <div className="if-setting-row">
          <label className="if-setting-copy if-setting-label" htmlFor="settings-theme">
            主题
          </label>
          <div className="if-setting-control">
            <select
              id="settings-theme"
              className="if-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value as "dark" | "light")}
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
        </div>
        <div className="if-setting-row">
          <label className="if-setting-copy if-setting-label" htmlFor="settings-density">
            界面密度
          </label>
          <div className="if-setting-control">
            <select
              id="settings-density"
              className="if-select"
              value={density}
              onChange={(e) =>
                setDensity(e.target.value as "comfortable" | "compact")
              }
            >
              <option value="comfortable">舒适</option>
              <option value="compact">紧凑</option>
            </select>
          </div>
        </div>
      </section>
      <section className="if-settings-section">
        <h2>索引与缓存</h2>
        <div className="if-setting-row">
          <div className="if-setting-copy">
            <div className="if-setting-label">数据目录</div>
            <p className="if-utility-path">
              {settings?.dataDir || "正在读取…"}
            </p>
          </div>
        </div>
        <div className="if-setting-row">
          <label className="if-setting-copy if-setting-label" htmlFor="settings-cache-limit">
            缓存容量上限（GiB）
          </label>
          <div className="if-setting-control">
            <input
              id="settings-cache-limit"
              aria-label="缓存容量 GiB"
              className="if-input"
              type="number"
              min="0.1"
              step="0.5"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
            <Button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const n = Number(limit);
                  if (!Number.isFinite(n) || n <= 0)
                    throw new Error("请输入有效缓存容量");
                  await api.invoke("settings.update", {
                    cacheLimitBytes: Math.round(n * 1024 ** 3),
                  });
                  notify("缓存容量已保存");
                })
              }
            >
              保存
            </Button>
          </div>
        </div>
        <div className="if-setting-row">
          <div className="if-setting-copy">
            预览缓存可安全重建，清理不会移除原图和整理信息
          </div>
          <Button disabled={busy} onClick={() => setConfirm("clearCache")}>
            清理缓存
          </Button>
        </div>
      </section>
      <section className="if-settings-section" aria-label="后台任务与睡眠">
        <h2>后台任务与睡眠</h2>
        <div className="if-setting-row if-power-setting-row">
          <label className="if-setting-copy" htmlFor="settings-prevent-sleep">后台任务运行时防止电脑睡眠</label>
          <input id="settings-prevent-sleep" className="if-power-switch" type="checkbox" role="switch" checked={power?.enabled??false} disabled={!power||powerBusy} onChange={event=>{const enabled=event.target.checked;setPower(value=>value?{...value,enabled}:value);setPowerBusy(true);setPowerError("");void api.invoke("power.set",{enabled}).then(setPower).catch(async e=>{setPowerError(error(e));try{setPower(await api.invoke("power.get",{}))}catch{}}).finally(()=>setPowerBusy(false));}}/>
        </div>
        <p className="if-subtitle">默认关闭。开启后仅在后台任务运行或正常批次休息时防止睡眠；无任务或保护暂停时释放。关闭后补全仍会继续，电脑按 Windows 设置睡眠。</p>
        <p role="status">{powerBusy?"正在保存…":power?.enabled?"已开启，按任务状态自动控制":"已关闭，遵循 Windows 睡眠设置"}</p>
        {(powerError||power?.error)&&<p role="alert">{powerError||power?.error}</p>}
      </section>
      <section className="if-settings-section">
        <h2>Pixiv 连接</h2>
        <p role="status" aria-live="polite">{networkSummary(network)}</p>
        {network?.checkedAt&&<p className="if-subtitle">最近验证：{new Date(network.checkedAt).toLocaleString()}</p>}
        {network?.error&&<p role="alert">{network.error.message}</p>}
        <div className="if-setting-row">
          <div className="if-setting-copy"><label htmlFor="pixiv-proxy-mode">代理设置</label></div>
          <div className="if-setting-control">
          <select
            id="pixiv-proxy-mode"
            aria-label="代理模式"
            className="if-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="system">系统代理</option>
            <option value="direct">直接连接</option>
            <option value="custom">自定义代理</option>
          </select>
          {mode === "custom" && (
            <input
              aria-label="代理地址"
              className="if-input"
              placeholder="127.0.0.1:7890"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
            />
          )}
          <Button
            disabled={busy}
            onClick={() =>
              act(async () => {
                await api.invoke(
                  "network.configure",
                  mode === "custom" ? { mode, proxyRules: proxy } : { mode },
                );
                notify("代理设置已保存");
              })
            }
          >
            保存代理
          </Button>
          </div>
        </div>
        <Button
          disabled={busy}
          onClick={() =>
            act(async () => {
              await api.invoke("network.connect", {});
              notify("已打开独立登录窗口，登录完成后会自动验证状态");
            })
          }
        >
          连接 Pixiv
        </Button>{" "}
        <Button disabled={busy} onClick={()=>run(async()=>{const value=await api.invoke('network.verify',{});setNetwork(value);notify(value.authState==='authenticated'?'Pixiv 登录验证通过':value.authState==='unauthenticated'?(value.sessionPresent?'会话已失效，请重新登录':'尚未登录 Pixiv'):(value.error?.message??'尚未完成登录验证'),undefined,value.authState==='network_error'?'error':'success');})}>
          刷新状态
        </Button>{" "}
        <Button
          disabled={busy || !network?.sessionPresent}
          onClick={() =>
            act(async () => {
              await api.invoke("network.logout", {});
              notify("已退出来源会话");
            })
          }
        >
          退出登录
        </Button>
      </section>
      <section className="if-settings-section">
        <h2>Pixiv 请求与批次</h2>
        <PixivQueueSettingsForm notify={notify} />
      </section>
      <section className="if-settings-section">
        <h2>按目录批量补全 Pixiv</h2>
        <PixivBatchPanel notify={notify}/>
      </section>
      <AiEnvironmentSettings notify={notify} />
      <SauceSettings notify={notify} />
      <DanbooruSettings />
      <section className="if-settings-section">
        <h2>数据管理</h2>
        <Button
          disabled={busy}
          onClick={() =>
            act(async () => {
              const p = await api.invoke("system.backup", {});
              if (p) notify(`备份已保存：${p}`);
            })
          }
        >
          备份索引
        </Button>{" "}
        <Button
          disabled={busy}
          onClick={() =>
            act(async () => {
              const p = await api.invoke("system.export", {});
              if (p) notify(`导出已保存：${p}`);
            })
          }
        >
          导出整理数据
        </Button>{" "}
        <Button disabled={busy} onClick={() => setConfirm("restore")}>
          从备份恢复
        </Button>
      </section>
      {confirm && (
        <Modal
          title={confirm === "restore" ? "从备份恢复？" : "清理图片缓存？"}
          onClose={() => !busy && setConfirm(null)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const result = await api.invoke(
                      confirm === "restore"
                        ? "system.restore"
                        : "system.clearCache",
                      {},
                    );
                    setConfirm(null);
                    if (result) notify("操作已完成");
                  })
                }
              >
                确认并继续
              </Button>
            </>
          }
        >
          <p>
            {confirm === "restore"
              ? "恢复会替换当前索引和整理数据。建议先备份当前数据；下一步将打开系统文件选择窗口。"
              : "将清理可重新生成的缩略图与颜色缓存，之后需要重新处理图片。"}
          </p>
        </Modal>
      )}
    </div>
  );
}
