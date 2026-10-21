import { api } from "./client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type {
  FileItem,
  FileDetail,
  Filter,
  ProgressEvent,
  LocalTaskStatus,
  QueryRequest,
} from "../src/contracts.js";
import type { TagDto, CollectionDto } from "../src/api.js";
import { Button, Icon, Modal, Stars, Toggle } from "./ui";
import { Gallery } from "./Gallery";
import { clampThumbnail, THUMB_MIN, THUMB_MAX } from "../src/gallery-interaction";
import { DirectoryTree } from "./DirectoryTree";
import { SortMenu } from "./SortMenu";
import brandLogo from "../resources/branding/image-finder.png";
import { FileActionsMenu, FileOperationReport, useFileOperations } from "./FileActions";
import { InfoPanel, ImageViewer } from "./ImageDetails";
import { FilterPanel, COLORS } from "./FilterPanel";
import { TagManager } from "./TagManager";
import { TasksPage, DirectoriesPage, SettingsPage } from "./UtilityPages";
import { AiRunButton } from "./AiPanel";
import { composeQuery, titleOf, type Layout } from "./model";
type Screen =
  | "gallery"
  | "tags"
  | "tasks"
  | "directories"
  | "settings"
  | "collections";
type Toast = { text: string; undo?: () => void; kind: "success" | "error" };
type Route = {
  screen: Screen;
  section: string;
  title: string;
  filter: Filter;
  query: string;
  searchMode: "keyword" | "semantic";
  semanticQuery: string;
  scroll: number;
  selected?: string[];
  gallery?: { items: FileItem[]; total: number };
};
function preference<T>(name: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem(`image-finder.${name}`) || "null") ??
      fallback
    );
  } catch {
    return fallback;
  }
}

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
      preference("theme", "dark"),
    ),
    [density, setDensity] = useState(() => preference("density", "compact")),
    [layout, setLayout] = useState<Layout>(() => preference("layout", "rows")),
    [thumb, setThumb] = useState(() => clampThumbnail(preference("thumb", 208))),
    [sideWidth, setSideWidth] = useState(() => preference("sidebar", 210)),
    [collapsed, setCollapsed] = useState(false);
  const [screen, setScreen] = useState<Screen>("gallery"),
    [section, setSection] = useState("all"),
    [title, setTitle] = useState("全部图片"),
    [query, setQuery] = useState(""),
    [searchMode, setSearchMode] = useState<"keyword" | "semantic">("keyword"),
    [semanticQuery, setSemanticQuery] = useState(""),
    [semanticCoverage, setSemanticCoverage] = useState<{ indexed: number; unindexed: number } | null>(null),
    [filter, setFilter] = useState<Filter>({}),
    [sort, setSort] = useState<QueryRequest["sort"]>("added_desc"),
    [stacked, setStacked] = useState(false),
    [filterOpen, setFilterOpen] = useState(false),
    [info, setInfo] = useState(false),
    [viewMenu, setViewMenu] = useState(false),
    [quick, setQuick] = useState<string | null>(null),
    [groups, setGroups] = useState<Record<string, boolean>>({
      manual: true,
      smart: true,
      tags: true,
      sources: true,
    });
  const [items, setItems] = useState<FileItem[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(""),
    [pendingResults, setPendingResults] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<FileDetail | null>(null),
    [viewer, setViewer] = useState<{ id: string; quick: boolean } | null>(null),
    [postItems, setPostItems] = useState<FileItem[]>([]),
    [tags, setTags] = useState<TagDto[]>([]),
    [collections, setCollections] = useState<CollectionDto[]>([]),
    [stats, setStats] = useState<
      (ProgressEvent & { local: LocalTaskStatus }) | null
    >(null);
  const [modal, setModal] = useState<
      "save" | "tags" | "collection" | "rating" | "help" | null
    >(null),
    [collectionName, setCollectionName] = useState(""),
    [collectionKind, setCollectionKind] = useState<"normal" | "smart">(
      "normal",
    ),
    [editing, setEditing] = useState<string | null>(null),
    [targetCollection, setTargetCollection] = useState(""),
    [tagInput, setTagInput] = useState(""),
    [tagRemove, setTagRemove] = useState(false),
    [rating, setRating] = useState(0),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState<Toast | null>(null),
    [batchIds, setBatchIds] = useState<string[]>([]),
    [tagFocus, setTagFocus] = useState<string>();
  const [ruleEditing, setRuleEditing] = useState(false);
  const [fileMenu,setFileMenu] = useState<{x:number;y:number;ids:string[]} | null>(null);
  const [directoryRevision,setDirectoryRevision] = useState(0);
  const [historyTick, setHistoryTick] = useState(0);
  const galleryReturn = useRef<Route | null>(null);
  const history = useRef<Route[]>([]),
    future = useRef<Route[]>([]),
    scrollRef = useRef<HTMLDivElement>(null),
    searchRef = useRef<HTMLInputElement>(null),
    anchor = useRef(""),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    request = useRef(0),
    inFlight = useRef(false),
    itemsRef = useRef(items),
    conditionHistory = useRef<{ filter: Filter; query: string }[]>([]);
  itemsRef.current = items;
  const freezePages = useRef(false);
  const trayNavigate=useRef<(page:"tasks"|"settings")=>void>(()=>{});
  const notify = useCallback(
    (
      text: string,
      undo?: () => void,
      kind: "success" | "error" = "success",
    ) => {
      setToast({ text, undo, kind });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(
        () => setToast(null),
        undo ? 20000 : 7000,
      );
    },
    [],
  );
  const run = useCallback(
    async (f: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await f();
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), undefined, "error");
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );
  const refreshMeta = useCallback(async () => {
    const [s, t, c] = await Promise.all([
      api.invoke("system.stats", {}),
      api.invoke("tags.list", { limit: 100 }),
      api.invoke("collections.list", {}),
    ]);
    setStats(s);
    setTags(t);
    setCollections(c);
  }, []);
  useEffect(() => {
    void refreshMeta().catch((e) => notify(e.message, undefined, "error"));
    const unsubscribe = api.onProgress((s) => setStats(s));
    return () => {
      unsubscribe();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [refreshMeta, notify]);
  useEffect(()=>api.onAppEvent?.(event=>{if(event.type==="navigate")trayNavigate.current(event.page);}),[]);
  useEffect(() => {
    for (const [k, v] of Object.entries({
      theme,
      density,
      layout,
      thumb,
      sidebar: sideWidth,
    }))
      localStorage.setItem(`image-finder.${k}`, JSON.stringify(v));
  }, [theme, density, layout, thumb, sideWidth]);
  const collection = collections.find((c) => c.id === section);
  const directory = section.startsWith("directory:")
    ? JSON.parse(section.slice(10)) as [string, string]
    : null;
  const scope: Filter =
    section === "favorites"
      ? { favorite: true }
      : section === "recent"
        ? { addedAfter: Date.now() - 7 * 86400000 }
        : section.startsWith("root:")
          ? { rootIds: [section.slice(5)] }
          : directory
            ? { directory: { rootId: directory[0], relativePath: directory[1] } }
          : section.startsWith("tag:")
            ? { tags: [{ ids: [section.slice(4)], mode: "any" }] }
            : collection && !(ruleEditing && collection.kind === "smart")
              ? { collectionId: collection.id }
              : {};
  // A date range is stable while the user remains in the same location.
  const recentSince = useRef(Date.now() - 7 * 86400000);
  if (section === "recent") scope.addedAfter = recentSince.current;
  const scopeRoot = stats?.roots.find(r => r.id === (directory?.[0] ?? (section.startsWith("root:") ? section.slice(5) : "")));
  const locationTitle = scopeRoot ? scopeRoot.path + (directory?.[1] ? "\\" + directory[1].replaceAll("/", "\\") : "") : title;
  const queryKey = JSON.stringify(
    { ...composeQuery({missing:false,...filter}, searchMode === "keyword" ? query : "", scope, sort, stacked), ...(searchMode === "semantic" && semanticQuery.trim() ? { semantic: { query: semanticQuery.trim() } } : {}) },
  );
  const queryRef = useRef<QueryRequest>(JSON.parse(queryKey));
  queryRef.current = JSON.parse(queryKey);
  const fetchPage = useCallback(async (reset = false) => {
    if (freezePages.current && !reset) return;
    if (inFlight.current && !reset) return;
    const token = reset ? ++request.current : request.current;
    inFlight.current = true;
    setLoading(true);
    setLoadError("");
    try {
      const result = await api.invoke("files.query", {
        ...queryRef.current,
        offset: reset ? 0 : itemsRef.current.length,
      });
      if (token !== request.current) return;
      setSemanticCoverage(result.semantic ?? null);
      setItems((old) =>
        reset
          ? result.items
          : [
              ...old,
              ...result.items.filter((x) => !old.some((y) => y.id === x.id)),
            ],
      );
      setTotal(result.total);
    } catch (e) {
      if (token === request.current)
        setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === request.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    freezePages.current = false;
    setPendingResults(false);
    setSelected([]);
    setDetail(null);
    setItems([]);
    itemsRef.current = [];
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (screen === "gallery" && galleryReturn.current?.gallery) {
      const saved = galleryReturn.current;
      setItems(saved.gallery!.items);
      itemsRef.current = saved.gallery!.items;
      setTotal(saved.gallery!.total);
      setSelected(saved.selected ?? []);
      setLoading(false);
    } else if (screen === "gallery") void fetchPage(true);
    else {
      request.current++;
      inFlight.current = false;
      setLoading(false);
    }
  }, [queryKey, screen, fetchPage]);
  useEffect(() => {
    const saved = galleryReturn.current;
    if (screen !== "gallery" || !saved?.gallery || items !== saved.gallery.items) return;
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = saved.scroll;
      galleryReturn.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [screen, items]);
  const refreshFiles = useCallback(async () => {
    const keep = itemsRef.current.length;
    const token = ++request.current;
    inFlight.current = true;
    setLoading(true);
    const result: FileItem[] = [];
    try {
      let count = 0;
      do {
        const page = await api.invoke("files.query", {
          ...queryRef.current,
          offset: result.length,
          limit: Math.min(500, Math.max(120, keep - result.length)),
        });
        if (token !== request.current) return;
        result.push(...page.items);
        count = page.total;
        if (!page.items.length) break;
      } while (result.length < Math.min(keep, count));
      setItems(result);
      setTotal(count);
    } finally {
      if (token === request.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, []);
  const activeId = viewer?.id ?? selected.at(-1);
  const detailRequest = useRef(0);
  const refreshDetail = useCallback(async () => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    const token = ++detailRequest.current;
    const d = await api.invoke("files.detail", { fileId: activeId });
    if (token === detailRequest.current) setDetail(d);
  }, [activeId]);
  useEffect(() => {
    setDetail(null);
    void refreshDetail().catch((e) => notify(e.message, undefined, "error"));
    return () => {
      detailRequest.current++;
    };
  }, [refreshDetail, notify]);
  useEffect(() => {
    let active = true;
    if (!viewer || !detail?.artworkId) {
      setPostItems([]);
      return;
    }
    void api
      .invoke("files.query", {
        filter: { artworkIds: [detail.artworkId] },
        limit: 500,
        sort: "name",
      })
      .then((r) => {
        if (active) setPostItems(r.items);
      })
      .catch((e) => notify(e.message, undefined, "error"));
    return () => {
      active = false;
    };
  }, [viewer?.id, detail?.artworkId, notify]);
  const dirtyKey = JSON.stringify([
    stats?.files,
    stats?.features,
    stats?.jobs,
    stats?.roots.map((r) => [r.id, r.status, r.lastScanAt]),
  ]);
  const dirtyRef = useRef(dirtyKey);
  dirtyRef.current = dirtyKey;
  const viewportPage = useRef(0),
    pageVersions = useRef(new Map<number, string>()),
    visibleRefreshing = useRef(false);
  const totalRef = useRef(total);
  totalRef.current = total;
  const refreshVisible = useCallback(async () => {
    if (visibleRefreshing.current || inFlight.current || freezePages.current)
      return;
    visibleRefreshing.current = true;
    const token = request.current,
      version = dirtyRef.current;
    try {
      for (const offset of [...new Set([0, viewportPage.current])]) {
        if (pageVersions.current.get(offset) === version) continue;
        const page = await api.invoke("files.query", {
          ...queryRef.current,
          offset,
          limit: 120,
        });
        if (token !== request.current) return;
        const changedIds = page.items.some(
          (item, i) => itemsRef.current[offset + i]?.id !== item.id,
        );
        if (
          itemsRef.current.length &&
          (scrollRef.current?.scrollTop ?? 0) > 50 &&
          (page.total !== totalRef.current || changedIds)
        ) {
          freezePages.current = true;
          setPendingResults(true);
          return;
        }
        // Insertions and changed ordering invalidate offset pages. Re-anchor at the
        // first page rather than joining new offsets onto a stale result cache.
        if (
          offset === 0 &&
          itemsRef.current.length &&
          (page.total !== totalRef.current || changedIds)
        ) {
          setItems(page.items);
          itemsRef.current = page.items;
          setTotal(page.total);
          viewportPage.current = 0;
          pageVersions.current.clear();
          pageVersions.current.set(0, version);
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
          notify("图库结果已更新，已回到结果开头");
          return;
        }
        setItems((old) => {
          const next = old.slice(0, page.total);
          if (offset > next.length) return next;
          next.splice(
            offset,
            Math.min(120, next.length - offset),
            ...page.items,
          );
          return next;
        });
        setTotal(page.total);
        pageVersions.current.set(offset, version);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), undefined, "error");
    } finally {
      visibleRefreshing.current = false;
    }
  }, [notify]);
  const onViewport = useCallback(
    (index: number) => {
      viewportPage.current = Math.floor(index / 120) * 120;
      void refreshVisible();
    },
    [refreshVisible],
  );
  const detailRefreshRef = useRef(refreshDetail);
  detailRefreshRef.current = refreshDetail;
  useEffect(() => {
    pageVersions.current.clear();
  }, [queryKey]);
  useEffect(() => {
    if (screen !== "gallery") return;
    let previous = "";
    const timer = setInterval(() => {
      if (previous === dirtyRef.current) return;
      previous = dirtyRef.current;
      void refreshVisible();
      void detailRefreshRef
        .current()
        .catch((e) => notify(e.message, undefined, "error"));
    }, 1500);
    return () => clearInterval(timer);
  }, [screen, refreshVisible, notify]);
  const current = (): Route => ({
    screen,
    section,
    title,
    filter,
    query,
    searchMode,
    semanticQuery,
    scroll: scrollRef.current?.scrollTop ?? 0,
  });
  const restore = (r: Route) => {
    galleryReturn.current = r.gallery ? r : null;
    setScreen(r.screen);
    setSection(r.section);
    setTitle(r.title);
    setFilter(r.filter);
    setQuery(r.query);
    setSearchMode(r.searchMode);
    setSemanticQuery(r.semanticQuery);
    setViewer(null);
    setSelected(r.selected ?? []);
    if (!r.gallery) setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = r.scroll;
    }, 200);
  };
  const navigate = (s: Screen, sec = "all", name = "", preserveSelection = false) => {
    history.current.push({ ...current(), ...(preserveSelection ? { selected: [...selected], gallery: { items, total } } : {}) });
    future.current = [];
    setHistoryTick((n) => n + 1);
    setScreen(s);
    setSection(sec);
    setTitle(
      name ||
        {
          gallery: "全部图片",
          tags: "标签管理",
          tasks: "后台任务",
          directories: "原目录",
          settings: "设置",
          collections: "所有集合",
        }[s],
    );
    setQuery("");
    setSemanticQuery("");
    setFilter({});
    setSelected([]);
    setViewer(null);
    setRuleEditing(false);
    setFilterOpen(false);
    setQuick(null);
  };
  trayNavigate.current = page => navigate(page);
  const travel = (back: boolean) => {
    const from = back ? history : future,
      to = back ? future : history;
    const r = from.current.pop();
    if (r) {
      to.current.push(current());
      restore(r);
      setHistoryTick((n) => n + 1);
    }
  };
  const changeFilter = (next: Filter) => {
    conditionHistory.current.push({ filter, query });
    setFilter(next);
    if (selected.length) notify(`筛选已更新，已清空 ${selected.length} 张选择`);
    setSelected([]);
  };
  const changeQuery = (next: string) => {
    conditionHistory.current.push({ filter, query });
    setQuery(next);
    if (!next.trim()) setSemanticQuery("");
    if (screen !== "gallery") setScreen("gallery");
    setSelected([]);
  };
  const clear = () => {
    conditionHistory.current.push({ filter, query });
    setFilter({});
    setQuery("");
    setSemanticQuery("");
  };
  const removeLast = () => {
    const previous = conditionHistory.current.pop();
    if (previous) {
      setFilter(previous.filter);
      setQuery(previous.query);
    }
  };
  const refreshAfter = async () => {
    await Promise.all([refreshFiles(), refreshDetail(), refreshMeta()]);
  };
  const fileOperations = useFileOperations({onChanged:async()=>{setSelected([]);setDirectoryRevision(value=>value+1);await refreshAfter();},notify});
  const favorite = (file: FileItem) =>
    void organize([file.id], "favorite", !file.favorite);
  const undoOrganization = (undoId: string) =>
    void run(async () => {
      await api.invoke("organization.undo", { undoId });
      await refreshAfter();
      notify("已撤销整理操作");
    });
  const organize = async (
    ids: string[],
    field: "favorite" | "rating",
    value: boolean | number,
  ) =>
    run(async () => {
      const result = await api.invoke("organization.apply", {
        fileIds: ids,
        ...(field === "favorite"
          ? { favorite: value as boolean }
          : { rating: value as number }),
      });
      await refreshAfter();
      notify(
        `已为 ${ids.length} 张图片保存${field === "favorite" ? "收藏状态" : "评分"}`,
        () => undoOrganization(result.undoId),
      );
    });
  const tagAction = (
    fileId: string,
    tagId: string,
    mode: "add" | "exclude" | "inherit",
  ) =>
    void run(async () => {
      const result = await api.invoke("organization.apply", {
        fileIds: [fileId],
        tags: [{ tagId, mode }],
      });
      await refreshAfter();
      notify("已保存单图标签覆盖", () => undoOrganization(result.undoId));
    });
  const openBatch = (name: "tags" | "rating" | "collection") => {
    setBatchIds([...selected]);
    setModal(name);
    setTagInput("");
    setTagRemove(false);
    setTargetCollection(collections.find((c) => c.kind === "normal")?.id ?? "");
  };
  const addTags = () =>
    void run(async () => {
      const names = [
        ...new Set(
          tagInput
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      if (names.length > 30) throw new Error("每次最多编辑30个标签");
      const result = await api.invoke("organization.apply", {
        fileIds: batchIds,
        tags: names.map((name) => ({
          name,
          mode: tagRemove ? ("inherit" as const) : ("add" as const),
        })),
      });
      setModal(null);
      await refreshAfter();
      notify(`已为 ${batchIds.length} 张图片保存标签`, () =>
        undoOrganization(result.undoId),
      );
    });
  const enqueue = (ids: string[]) =>
    void run(async () => {
      const rows = await Promise.all(
        ids.map((fileId) => api.invoke("files.detail", { fileId })),
      );
      const artworkIds = [
        ...new Set(rows.flatMap((x) => (x.artworkId ? [x.artworkId] : []))),
      ];
      if (!artworkIds.length) throw new Error("选中图片尚未绑定来源");
      const n = await api.invoke("jobs.enqueue", { artworkIds, priority: 10 });
      notify(`已加入 ${n} 个投稿任务；来源是否运行可在后台任务控制`);
    });
  const select = (file: FileItem, e: React.MouseEvent) => {
    if (e.shiftKey) {
      const a = items.findIndex((x) => x.id === anchor.current),
        b = items.findIndex((x) => x.id === file.id);
      if (a >= 0) {
        const ids = items
          .slice(Math.min(a, b), Math.max(a, b) + 1)
          .map((x) => x.id);
        setSelected(
          e.ctrlKey || e.metaKey ? [...new Set([...selected, ...ids])] : ids,
        );
        return;
      }
    }
    setSelected(
      e.ctrlKey || e.metaKey
        ? selected.includes(file.id)
          ? selected.filter((x) => x !== file.id)
          : [...selected, file.id]
        : [file.id],
    );
    anchor.current = file.id;
  };
  const saveDialog = (kind: "normal" | "smart", edit = false) => {
    setCollectionKind(kind);
    setEditing(edit && ruleEditing ? (collection?.id ?? null) : null);
    setCollectionName(edit && ruleEditing ? (collection?.name ?? "") : "");
    setModal("save");
  };
  const saveCollection = () =>
    void run(async () => {
      const name = collectionName.trim();
      let id = editing;
      const rules = composeQuery(
        filter,
        searchMode === "keyword" ? query : "",
        editing ? {} : scope,
        sort,
        stacked,
      ).filter!;
      if (editing)
        await api.invoke("collections.update", {
          collectionId: editing,
          name,
          ...(collectionKind === "smart" && ruleEditing
            ? { filter: rules }
            : {}),
        });
      else {
        id = await api.invoke("collections.create", {
          name,
          kind: collectionKind,
          ...(collectionKind === "smart" ? { filter: rules } : {}),
        });
        if (collectionKind === "normal" && selected.length)
          await api.invoke("collections.add", {
            collectionId: id,
            fileIds: [...selected],
          });
      }
      setModal(null);
      await refreshMeta();
      notify(
        "集合已保存",
        !editing
          ? () =>
              void run(async () => {
                await api.invoke("collections.delete", { collectionId: id! });
                await refreshMeta();
                if (section === id) navigate("gallery");
                notify("已撤销创建集合");
              })
          : undefined,
      );
    });
  const browseTag = (id: string) => {
    const name =
      tags.find((t) => t.id === id)?.name ??
      detail?.tags.find((t) => t.id === id)?.name ??
      "标签";
    navigate("gallery", `tag:${id}`, name);
  };
  const actions = {
    aiFileIds: selected,
    onAIChanged: () => { void refreshDetail(); void refreshMeta(); void refreshFiles(); },
    onFavorite: favorite,
    onRate: (ids: string[], r: number) => void organize(ids, "rating", r),
    onTag: tagAction,
    onBrowseTag: browseTag,
    onAddTag: () => {
      setBatchIds(activeId ? [activeId] : []);
      setTagInput("");
      setModal("tags");
    },
    onColor: (hex: string) => {
      setViewer(null);
      changeFilter({
        ...filter,
        color: {
          hex,
          tolerance: 35,
          minWeight: 0.08,
          restrict: true,
          includeUnanalyzed: true,
        },
      });
    },
    notify,
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        if (modal || viewer) return;
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (target?.closest("input,textarea,select,[contenteditable]")) return;
      if (modal || viewer || fileOperations.report || fileMenu || document.querySelector('[role="dialog"]')) return;
      if (e.key === "Escape") {
        if (quick) {
          setQuick(null);
          return;
        }
        if (viewMenu) {
          setViewMenu(false);
          return;
        }
        if (filterOpen) {
          setFilterOpen(false);
          return;
        }
        setSelected([]);
        return;
      }
      if (screen !== "gallery") return;
      if (e.key === "Delete" && selected.length) {
        e.preventDefault(); void fileOperations.perform("trash",[...selected]); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(items.map((x) => x.id));
        notify(`已选择当前已加载的 ${items.length} 张图片`);
      }
      if ((e.key === "Enter" || e.code === "Space") && selected.length === 1) {
        e.preventDefault();
        setViewer({ id: selected[0], quick: e.code === "Space" });
      }
      if (/^[0-5]$/.test(e.key) && selected.length)
        void organize([...selected], "rating", +e.key);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const nav = (
    name: string,
    icon: string,
    s: Screen,
    sec = "all",
    count?: number,
  ) => (
    <button
      className={`if-nav-item ${screen === s && section === sec ? "active" : ""}`}
      key={sec + name}
      title={name}
      aria-label={name}
      onClick={() => navigate(s, sec, name)}
    >
      <Icon name={icon} size={15} />
      <span className="if-nav-name">{name}</span>
      {count !== undefined && (
        <span className="if-nav-count">{count.toLocaleString()}</span>
      )}
    </button>
  );
  const group = (
    id: string,
    name: string,
    children: React.ReactNode,
    add?: () => void,
  ) => (
    <section
      className={`if-nav-section ${id === "sources" ? "if-source-nav" : ""}`}
    >
      <div className="if-nav-section-head">
        <button
          className="if-nav-section-toggle"
          aria-expanded={groups[id]}
          onClick={() => setGroups({ ...groups, [id]: !groups[id] })}
        >
          <Icon
            name={groups[id] ? "chevron-down" : "chevron-right"}
            size={12}
          />
          <span>{name}</span>
        </button>
        {add && (
          <Button variant="ghost" aria-label={`新建${name}`} onClick={add}>
            <Icon name="plus" size={13} />
          </Button>
        )}
      </div>
      <div className="if-nav-tree" hidden={!groups[id]}>
        {children}
      </div>
    </section>
  );
  const chipEntries = Object.entries(filter).filter(
    ([k, v]) =>
      v !== undefined && !(Array.isArray(v) && !v.length) && k !== "tags",
  );
  const count =
    chipEntries.length +
    (filter.tags?.filter((g) => g.ids.length).length ?? 0) +
    (query ? 1 : 0);
  return (
    <div className="if-app" data-theme={theme} data-testid="image-finder-app">
      <header className="if-titlebar">
        <div className="if-brand">
          <img className="if-brand-logo" src={brandLogo} alt="" aria-hidden="true" />
          <span className="if-brand-name">Image Finder</span>
        </div>
        <div className="if-history">
          <Button
            variant="ghost"
            aria-label="返回上一个位置"
            disabled={!history.current.length}
            onClick={() => travel(true)}
          >
            <Icon name="chevron-left" size={17} />
          </Button>
          <Button
            variant="ghost"
            aria-label="前进到下一个位置"
            disabled={!future.current.length}
            onClick={() => travel(false)}
          >
            <Icon name="chevron-right" size={17} />
          </Button>
        </div>
        <Button className="if-search-mode" aria-label="切换关键词或语义搜索" aria-pressed={searchMode === "semantic"} onClick={() => { setSearchMode(value => value === "keyword" ? "semantic" : "keyword"); setSemanticQuery(""); setQuery(""); }}>{searchMode === "keyword" ? "关键词" : "中文语义"}</Button>
        <label className="if-search">
          <Icon name="search" size={15} />
          <input
            ref={searchRef}
            aria-label="全局搜索"
            placeholder={searchMode === "keyword" ? "搜索标题、作者、标签…" : "描述画面，例如：海边的蓝发女孩，按 Enter 搜索"}
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onKeyDown={e => { if (searchMode === "semantic" && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); setSemanticQuery(query); } }}
          />
          <kbd>Ctrl K</kbd>
        </label>
        <div className="if-title-spacer" />
        <Button
          variant="ghost"
          aria-label="查看后台任务"
          onClick={() => navigate("tasks")}
        >
          <Icon name="activity" size={16} />
        </Button>
        <Button
          variant="ghost"
          aria-label="快捷键帮助"
          onClick={() => setModal("help")}
        >
          <Icon name="circle-help" size={16} />
        </Button>
        <div className="if-window-controls">
          <Button
            variant="ghost"
            aria-label="收起或展开导航"
            onClick={() => setCollapsed((v) => !v)}
          >
            <Icon name="panel-left-close" size={15} />
          </Button>
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
      </header>
      <div className="if-workspace">
        <aside
          className={`if-sidebar ${collapsed ? "if-sidebar-collapsed" : ""}`}
          style={{ width: sideWidth }}
          aria-label="主要导航"
        >
          <div className="if-sidebar-scroll">
            <div className="if-library-heading">
              <span className="if-library-emblem">
                <Icon name="library" size={21} />
              </span>
              <div className="if-library-copy">
                <strong>插画资料库</strong>
                <small>
                  {(stats?.files ?? 0).toLocaleString()} 张图片 · 本地
                </small>
              </div>
            </div>
            {nav("全部图片", "images", "gallery", "all", stats?.files)}
            {nav("最近加入", "clock-3", "gallery", "recent")}
            {nav("收藏", "heart", "gallery", "favorites")}
            {nav("标签管理", "tags", "tags")}
            {group(
              "manual",
              "手动集合",
              collections
                .filter((c) => c.kind === "normal")
                .map((c) => nav(c.name, "folder", "gallery", c.id)),
              () => saveDialog("normal"),
            )}
            {group(
              "smart",
              "智能集合",
              collections
                .filter((c) => c.kind === "smart")
                .map((c) => nav(c.name, "folder-search", "gallery", c.id)),
              () => saveDialog("smart"),
            )}
            <button
              className="if-nav-manage"
              onClick={() => navigate("collections")}
            >
              <Icon name="folders" size={13} />
              <span>所有集合</span>
              <Icon name="chevron-right" size={11} />
            </button>
            {group(
              "tags",
              "常用标签",
              tags
                .slice()
                .sort((a, b) => b.usageCount - a.usageCount)
                .slice(0, 8)
                .map((t) =>
                  nav(t.name, "tag", "gallery", `tag:${t.id}`, t.usageCount),
                ),
            )}
            {group(
              "sources",
              "原目录",
              <>
                <DirectoryTree roots={stats?.roots ?? []} section={section} revision={directoryRevision}
                  onSelect={(sec, path) => navigate("gallery", sec, path)} />
                {nav("管理原目录", "folder-cog", "directories")}
              </>,
            )}
          </div>
          <div className="if-sidebar-bottom">
            {nav("后台任务", "list-todo", "tasks")}
            {nav("设置", "settings-2", "settings")}
            <div className="if-library-foot">
              <span className="if-status-dot" />
              {stats?.local.running ? "本地任务处理中" : "本地浏览可用"}
            </div>
          </div>
          <div
            className="if-sidebar-resize"
            onPointerDown={(e) => {
              const start = e.clientX,
                old = sideWidth,
                el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              const move = (ev: PointerEvent) =>
                setSideWidth(
                  Math.max(174, Math.min(260, old + ev.clientX - start)),
                );
              const end = () => {
                el.removeEventListener("pointermove", move);
                el.removeEventListener("pointerup", end);
              };
              el.addEventListener("pointermove", move);
              el.addEventListener("pointerup", end);
            }}
          />
        </aside>
        <main className="if-main">
          {screen === "gallery" && (
            <>
              <div className="if-toolbar">
                <div className="if-location">
                  <span className="if-location-parent">
                    {collection
                      ? collection.kind === "smart"
                        ? "智能集合"
                        : "手动集合"
                      : section.startsWith("tag:")
                        ? "标签"
                        : section.startsWith("root:") || directory
                          ? "原目录"
                          : "资料库"}
                  </span>
                  <Icon name="chevron-right" size={12} />
                  <h1 title={locationTitle}>{locationTitle}</h1>
                  <small>
                    {total.toLocaleString()} {stacked ? "组" : "张"}
                  </small>
                  {(section.startsWith("root:") || directory) && <span className="if-directory-scope">含子文件夹</span>}
                </div>
                <div className="if-toolbar-actions">
                  <AiRunButton ids={selected} filter={queryRef.current.filter ?? {}} scopeLabel={locationTitle} notify={notify} />
                  <Button
                    onClick={() => {
                      setFilterOpen((v) => !v);
                      setInfo(false);
                    }}
                    aria-label="组合筛选"
                  >
                    <Icon name="sliders-horizontal" size={14} />
                    筛选{count > 0 && <span className="if-badge">{count}</span>}
                  </Button>
                  {searchMode === "semantic" && semanticQuery.trim() ? <span className="if-semantic-hint">语义相关度</span> : <SortMenu value={sort ?? "added_desc"} onChange={setSort} color={!!filter.color} />}
                  <div className="if-popover-anchor">
                    <Button
                      variant="ghost"
                      aria-label="图库显示选项"
                      onClick={() => setViewMenu((v) => !v)}
                    >
                      <Icon name="gallery-horizontal-end" size={15} />
                      显示
                      <Icon name="chevron-down" size={12} />
                    </Button>
                    {viewMenu && (
                      <div className="if-popover">
                        <h3>图库布局</h3>
                        {(["rows", "masonry", "grid"] as const).map((v, i) => (
                          <button
                            key={v}
                            className={`if-menu-row ${layout === v ? "active" : ""}`}
                            onClick={() => {
                              setLayout(v);
                              setViewMenu(false);
                            }}
                          >
                            {
                              [
                                "完整画面 · 等高行",
                                "完整画面 · 瀑布流",
                                "紧凑网格 · 保留全图",
                              ][i]
                            }
                          </button>
                        ))}
                        <div className="if-view-option">
                          <label>
                            缩略图大小 {thumb} px
                            <input
                              aria-label="缩略图大小"
                              type="range"
                              min={THUMB_MIN}
                              max={THUMB_MAX}
                              step={1}
                              value={thumb}
                              onChange={(e) => setThumb(+e.target.value)}
                            />
                          </label>
                        </div>
                        <div className="if-view-option">
                          <Toggle
                            label="同一投稿叠放"
                            checked={stacked}
                            onChange={setStacked}
                          />
                        </div>
                        <div className="if-view-option">
                          <Toggle
                            label="显示作者与尺寸"
                            checked={density === "comfortable"}
                            onChange={(v) =>
                              setDensity(v ? "comfortable" : "compact")
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    aria-label="显示或隐藏图片信息"
                    onClick={() => {
                      setInfo((v) => !v);
                      setFilterOpen(false);
                    }}
                  >
                    <Icon name="panel-right" size={16} />
                  </Button>
                </div>
              </div>
              {searchMode === "semantic" && <div className="if-semantic-banner" role="status" title="按画面描述的相似度排序，描述中的每个细节不一定都匹配。目录、尺寸、标签等严格条件请使用组合筛选。">{semanticQuery ? `语义相关度排序 · 已索引 ${semanticCoverage?.indexed ?? 0} · 未索引 ${semanticCoverage?.unindexed ?? 0}` : "输入中文画面描述，按 Enter 搜索已建立语义索引的图片"}</div>}
              <div className="if-subtoolbar">
                <div className="if-quick-filters">
                  {[
                    ["color", "palette", "颜色"],
                    ["tag", "tag", "标签"],
                    ["size", "scan", "尺寸"],
                  ].map(([id, icon, name]) => (
                    <div className="if-popover-anchor" key={id}>
                      <Button
                        variant="ghost"
                        aria-expanded={quick === id}
                        onClick={() => setQuick(quick === id ? null : id)}
                      >
                        <Icon name={icon} size={13} />
                        {name}
                        <Icon name="chevron-down" size={11} />
                      </Button>
                      {quick === id && (
                        <div className="if-popover if-quick-popover">
                          {id === "color" ? (
                            Object.entries(COLORS).map(([n, hex]) => (
                              <button
                                className="if-menu-row"
                                key={hex}
                                onClick={() => {
                                  changeFilter({
                                    ...filter,
                                    color: {
                                      hex,
                                      tolerance: 35,
                                      minWeight: 0.08,
                                      includeUnanalyzed: true,
                                      restrict: true,
                                    },
                                  });
                                  setQuick(null);
                                }}
                              >
                                <span
                                  className="if-swatch-tiny"
                                  style={{ background: hex }}
                                />
                                {n}
                              </button>
                            ))
                          ) : id === "tag" ? (
                            <>
                              {tags.slice(0, 10).map((t) => (
                                <button
                                  className="if-menu-row"
                                  key={t.id}
                                  onClick={() => {
                                    changeFilter({
                                      ...filter,
                                      tags: [
                                        ...(filter.tags ?? []),
                                        { ids: [t.id], mode: "any" },
                                      ],
                                    });
                                    setQuick(null);
                                  }}
                                >
                                  {t.name}
                                  <small>{t.usageCount}</small>
                                </button>
                              ))}
                              {!tags.length && <p>尚无标签</p>}
                              <Button
                                onClick={() => {
                                  setFilterOpen(true);
                                  setInfo(false);
                                  setQuick(null);
                                }}
                              >
                                全部标签与组合条件
                              </Button>
                            </>
                          ) : (
                            <>
                              <button
                                className="if-menu-row"
                                onClick={() => {
                                  changeFilter({ ...filter, heightMin: 2560 });
                                  setQuick(null);
                                }}
                              >
                                高清图片<small>高度 ≥ 2560 px</small>
                              </button>
                              {(
                                ["portrait", "landscape", "square"] as const
                              ).map((o, i) => (
                                <button
                                  className="if-menu-row"
                                  key={o}
                                  onClick={() => {
                                    changeFilter({ ...filter, orientation: o });
                                    setQuick(null);
                                  }}
                                >
                                  {["竖向图片", "横向图片", "方形图片"][i]}
                                </button>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {count > 0 && (
                    <Button variant="ghost" onClick={clear}>
                      清空
                    </Button>
                  )}
                  {collection && (
                    <span className="if-location-note">
                      {collection.kind === "smart"
                        ? "按规则自动更新"
                        : "手动添加图片"}
                    </span>
                  )}
                </div>
                <div className="if-row">
                  {collection?.kind === "smart" && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const { text, ...rest } = collection.filter ?? {};
                        setFilter(rest);
                        setQuery(text ?? "");
                        setRuleEditing(true);
                        setFilterOpen(true);
                      }}
                    >
                      修改规则
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSelected(
                        selected.length ? [] : items.map((x) => x.id),
                      );
                      notify(`选择范围：当前已加载 ${items.length} 张图片`);
                    }}
                  >
                    多选
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label="保存为智能集合"
                    onClick={() =>
                      saveDialog("smart", collection?.kind === "smart")
                    }
                  >
                    保存智能集合
                  </Button>
                </div>
              </div>
              {count > 0 && (
                <div className="if-conditions">
                  {query && (
                    <span className="if-condition">
                      搜索：{query}
                      <button
                        onClick={() => changeQuery("")}
                        aria-label="移除搜索条件"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {filter.tags?.flatMap((g, i) =>
                    g.ids.map((id) => (
                      <span className="if-condition" key={`${i}-${id}`}>
                        标签：{tags.find((t) => t.id === id)?.name ?? id}
                        <button
                          aria-label="移除标签条件"
                          onClick={() =>
                            changeFilter({
                              ...filter,
                              tags: filter.tags?.map((x, n) =>
                                n === i
                                  ? { ...x, ids: x.ids.filter((y) => y !== id) }
                                  : x,
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </span>
                    )),
                  )}
                  {chipEntries.map(([k, v]) => (
                    <span className="if-condition" key={k}>
                      {(
                        {
                          heightMin: "高度 ≥",
                          heightMax: "高度 ≤",
                          widthMin: "宽度 ≥",
                          widthMax: "宽度 ≤",
                          color: "颜色",
                          orientation: "方向",
                          favorite: "收藏",
                          tone: "色调",
                          creatorIds: "作者",
                          excludeTagIds: "排除",
                          ratingMin: "最低评分",
                          bytesMin: "最小字节",
                          bytesMax: "最大字节",
                        } as Record<string, string>
                      )[k] ?? k}
                      ：
                      {typeof v === "object"
                        ? k === "color"
                          ? (v as Filter["color"])?.hex
                          : Array.isArray(v)
                            ? `${v.length} 项`
                            : "已设置"
                        : String(v)}
                      <button
                        aria-label={`移除筛选 ${k}`}
                        onClick={() => {
                          const f = { ...filter };
                          delete (f as Record<string, unknown>)[k];
                          changeFilter(f);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <Button variant="ghost" onClick={clear}>
                    清空
                  </Button>
                </div>
              )}
              {pendingResults && (
                <div className="if-notice">
                  <Icon name="refresh-cw" size={14} />
                  <span>图库有新结果，当前浏览位置已保留。</span>
                  <Button
                    onClick={() => {
                      freezePages.current = false;
                      setPendingResults(false);
                      pageVersions.current.clear();
                      setSelected([]);
                      if (scrollRef.current) scrollRef.current.scrollTop = 0;
                      void fetchPage(true);
                    }}
                  >
                    点击更新结果
                  </Button>
                </div>
              )}
              <div className="if-gallery-body">
                {loadError ? (
                  <div className="if-empty">
                    <h2>读取图库失败</h2>
                    <p>{loadError}</p>
                    <Button onClick={() => void fetchPage(true)}>重试</Button>
                  </div>
                ) : !loading && !total ? (
                  <div className="if-empty" style={{ flex: 1 }}>
                    <div className="if-empty-symbol">
                      <Icon
                        name={stats?.roots.length ? "search-x" : "folder-plus"}
                        size={30}
                      />
                    </div>
                    <h2>
                      {stats?.roots.length
                        ? "暂时没有匹配的图片"
                        : "让喜欢的图片，有迹可循"}
                    </h2>
                    <p>
                      {stats?.roots.length
                        ? "筛选条件已保留，可以放宽最近添加的条件。"
                        : "添加本地原目录，开始浏览和整理。原图留在原处。"}
                    </p>
                    <div className="if-row">
                      {stats?.roots.length ? (
                        <>
                          <Button onClick={removeLast}>移除最后一个条件</Button>
                          <Button onClick={clear}>清空筛选</Button>
                        </>
                      ) : (
                        <Button
                          variant="primary"
                          onClick={() => navigate("directories")}
                        >
                          选择文件夹
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <Gallery
                    items={items}
                    total={pendingResults ? items.length : total}
                    selected={selected}
                    onSelect={select}
                    onFileDrag={item=>{const ids=selected.includes(item.id)?[...selected]:[item.id];if(!selected.includes(item.id))setSelected(ids);void api.invoke("files.drag",{fileIds:ids}).catch(error=>notify(error.message,undefined,"error"));}}
                    onContextMenu={(item,e)=>{
                      setViewMenu(false); setQuick(null);
                      const ids=selected.includes(item.id)?[...selected]:[item.id];
                      if(!selected.includes(item.id))setSelected(ids);
                      setFileMenu({x:e.clientX,y:e.clientY,ids});
                    }}
                    onOpen={(id, quick = false) => {
                      setSelected([id]);
                      setViewer({ id, quick });
                    }}
                    onFavorite={favorite}
                    layout={layout}
                    target={thumb}
                    onTargetChange={setThumb}
                    wheelEnabled={!viewer && !modal && !fileOperations.report}
                    density={density}
                    loading={loading}
                    onLoadMore={() => void fetchPage()}
                    scrollRef={scrollRef}
                    onViewport={onViewport}
                  />
                )}
                {filterOpen ? (
                  <div className="if-filter-shell pinned">
                    <FilterPanel
                      value={filter}
                      onChange={changeFilter}
                      onClose={() => setFilterOpen(false)}
                      onSave={() =>
                        saveDialog("smart", collection?.kind === "smart")
                      }
                      onSortColor={() => setSort("color")}
                    />
                  </div>
                ) : (
                  info && (
                    <InfoPanel
                      item={detail}
                      onClose={() => setInfo(false)}
                      actions={actions}
                    />
                  )
                )}
                {selected.length > 0 && (
                  <div className="if-batchbar">
                    <strong>已选 {selected.length} 张</strong>
                    <Button variant="primary" onClick={() => openBatch("tags")}>
                      添加标签
                    </Button>
                    <Button onClick={() => openBatch("collection")}>
                      加入集合
                    </Button>
                    <Button
                      onClick={() =>
                        void organize([...selected], "favorite", true)
                      }
                    >
                      收藏
                    </Button>
                    <Button onClick={() => openBatch("rating")}>评分</Button>
                    <Button onClick={() => enqueue([...selected])}>
                      优先补全
                    </Button>
                    <Button disabled={fileOperations.busy} aria-label="所选文件操作" onClick={e=>{
                      const rect=e.currentTarget.getBoundingClientRect();
                      setFileMenu({x:rect.left,y:rect.bottom+5,ids:[...selected]});
                    }}><Icon name="file" size={13}/>文件<Icon name="chevron-down" size={11}/></Button>
                    {collection?.kind === "normal" && (
                      <Button
                        onClick={() =>
                          void run(async () => {
                            const result = await api.invoke(
                              "organization.apply",
                              {
                                fileIds: [...selected],
                                collection: {
                                  collectionId: collection.id,
                                  mode: "remove",
                                },
                              },
                            );
                            setSelected([]);
                            await refreshFiles();
                            notify("已移出集合", () =>
                              undoOrganization(result.undoId),
                            );
                          })
                        }
                      >
                        移出集合
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      aria-label="取消全部选择"
                      onClick={() => setSelected([])}
                    >
                      <Icon name="x" size={14} />
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
          {screen === "tags" && (
            <TagManager
              notify={notify}
              initialTag={tagFocus}
              onBrowseTag={browseTag}
              onChanged={() => void refreshMeta()}
            />
          )}
          {screen === "tasks" && <TasksPage notify={notify} />}{" "}
          {screen === "directories" && (
            <DirectoriesPage
              notify={notify}
              onChanged={() => void refreshMeta()}
              onBrowse={(id) =>
                navigate(
                  "gallery",
                  id ? `root:${id}` : "all",
                  id ? "原目录" : "全部图片",
                )
              }
            />
          )}{" "}
          {screen === "settings" && (
            <SettingsPage
              theme={theme}
              setTheme={setTheme}
              density={density}
              setDensity={setDensity}
              notify={notify}
            />
          )}
          {screen === "collections" && (
            <div className="if-collections">
              <div className="if-collections-head">
                <div>
                  <h1 className="if-page-title">集合</h1>
                  <p className="if-subtitle">
                    手动整理，或按保存的规则自动查找
                  </p>
                </div>
                <Button variant="primary" onClick={() => saveDialog("normal")}>
                  新建集合
                </Button>
              </div>
              <div className="if-collection-grid">
                {collections.map((c) => (
                  <div className="if-collection-card" key={c.id}>
                    <button
                      className="live-collection-open"
                      onClick={() => navigate("gallery", c.id, c.name)}
                    >
                      <div className="if-collection-cover">
                        <Icon
                          name={c.kind === "smart" ? "folder-search" : "folder"}
                          size={35}
                        />
                      </div>
                      <div className="if-collection-label">{c.name}</div>
                      <div className="if-collection-type">
                        {c.kind === "smart"
                          ? "智能集合 · 按规则自动更新"
                          : "手动集合"}
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setRuleEditing(false);
                        setCollectionName(c.name);
                        setCollectionKind(c.kind);
                        setEditing(c.id);
                        setModal("save");
                      }}
                    >
                      重命名
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void run(async () => {
                          if (
                            !window.confirm(
                              `删除集合「${c.name}」？只删除集合和关联，原图保留。`,
                            )
                          )
                            return;
                          await api.invoke("collections.delete", {
                            collectionId: c.id,
                          });
                          await refreshMeta();
                          notify("集合已删除");
                        })
                      }
                    >
                      删除集合
                    </Button>
                  </div>
                ))}
              </div>
              {!collections.length && (
                <div className="if-empty">
                  <h2>还没有集合</h2>
                  <p>创建手动集合，或在图库保存筛选规则。</p>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
      <footer className="if-statusbar">
        <div className="if-row">
          <span className="if-status-dot" />
          <span>
            {selected.length ? `已选 ${selected.length} 张` : "本地浏览可用"}
          </span>
          <span>·</span>
          <span>
            {loading
              ? "正在读取图库"
              : `已加载 ${items.length} / ${total} ${stacked ? "组" : "张"}`}
          </span>
        </div>
        <div className="if-row">
          <span>
            {stats
              ? `预览与颜色 ${stats.features.toLocaleString()} / ${stats.files.toLocaleString()}`
              : "正在连接索引…"}
          </span>
          <Button
            variant="ghost"
            aria-label="切换深色和浅色"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={12} />
          </Button>
        </div>
      </footer>
      {viewer && detail?.id === viewer.id && (
        <ImageViewer
          item={detail}
          items={items}
          postItems={postItems}
          onNavigate={(id) => {
            setViewer({ ...viewer, id });
            setSelected([id]);
          }}
          onClose={() => setViewer(null)}
          onActivity={() => { setViewer(null); navigate("tasks", "all", "", true); }}
          onHelp={() => setModal("help")}
          actions={actions}
          quick={viewer.quick}
          onFileAction={(action, ids) => void fileOperations.perform(action, ids)}
        />
      )}
      {modal === "save" && (
        <Modal
          title={
            editing
              ? "更新集合"
              : collectionKind === "smart"
                ? "保存智能集合"
                : "新建集合"
          }
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button
                disabled={busy || !collectionName.trim() || (collectionKind === "smart" && searchMode === "semantic" && !!semanticQuery.trim())}
                variant="primary"
                onClick={saveCollection}
              >
                保存集合
              </Button>
            </>
          }
        >
          <p className="if-dialog-note">
            {searchMode === "semantic" && semanticQuery.trim() && "语义结果可选图保存为手动集合；智能集合当前只保存结构化筛选，请先切回关键词模式。"}
            {collectionKind === "smart"
              ? "保存当前组合筛选规则，符合规则的图片自动出现。"
              : "集合保存图片关联，原图保留在原目录。"}
          </p>
          <label className="if-label">
            集合名称
            <input
              className="if-input"
              aria-label="集合名称"
              value={collectionName}
              onChange={(e) => setCollectionName(e.target.value)}
            />
          </label>
          {!editing && (
            <div className="if-dialog-options">
              <Button onClick={() => setCollectionKind("normal")}>
                手动集合
              </Button>
              <Button onClick={() => setCollectionKind("smart")}>
                智能集合
              </Button>
            </div>
          )}
          <p className="if-dialog-example">
            {collectionKind === "normal"
              ? `添加当前选中的 ${selected.length} 张图片`
              : `当前共有 ${total} 项匹配；保存规则不依赖已加载图片`}
          </p>
        </Modal>
      )}
      {modal === "tags" && (
        <Modal
          title={tagRemove ? "移除我的标签" : "添加我的标签"}
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button
                variant="primary"
                disabled={busy || !tagInput.trim() || !batchIds.length}
                onClick={addTags}
              >
                应用到 {batchIds.length} 张图片
              </Button>
            </>
          }
        >
          <p className="if-dialog-note">
            本次仅影响明确选中的 {batchIds.length} 张。来源标签单独保留。
          </p>
          <label className="if-label">
            我的标签 · 逗号分隔
            <input
              className="if-input"
              aria-label="我的标签"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
          </label>
          <Toggle
            checked={tagRemove}
            onChange={setTagRemove}
            label="改为移除我的标签"
          />
        </Modal>
      )}
      {modal === "rating" && (
        <Modal
          title="为选中的图片评分"
          onClose={() => setModal(null)}
          footer={
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void organize(batchIds, "rating", rating);
                setModal(null);
              }}
            >
              应用评分
            </Button>
          }
        >
          <Stars value={rating} onChange={setRating} />
          <p>0 可清除评分，本次影响 {batchIds.length} 张。</p>
        </Modal>
      )}
      {modal === "collection" && (
        <Modal
          title="加入集合"
          onClose={() => setModal(null)}
          footer={
            <Button
              variant="primary"
              disabled={busy || !targetCollection}
              onClick={() =>
                void run(async () => {
                  const result = await api.invoke("organization.apply", {
                    fileIds: [...batchIds],
                    collection: { collectionId: targetCollection, mode: "add" },
                  });
                  setModal(null);
                  await refreshFiles();
                  notify(`已将 ${batchIds.length} 张图片加入集合`, () =>
                    undoOrganization(result.undoId),
                  );
                })
              }
            >
              加入集合
            </Button>
          }
        >
          <p className="if-dialog-note">只保存图片关联，原图保留。</p>
          <select
            className="if-select"
            aria-label="选择手动集合"
            value={targetCollection}
            onChange={(e) => setTargetCollection(e.target.value)}
          >
            <option value="">请选择手动集合</option>
            {collections
              .filter((c) => c.kind === "normal")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Modal>
      )}
      {modal === "help" && (
        <Modal title="浏览更顺手" onClose={() => setModal(null)}>
          <div className="if-keyboard-help">
            {[
              ["单击 / Ctrl 单击", "选中 / 增减选择"],
              ["Shift 单击", "选择已加载结果中的连续区间"],
              ["Ctrl A", "选择当前已加载的图片"],
              ["Ctrl + 滚轮", "在图库内调整缩略图大小"],
              ["Enter / Space", "单选图片后打开大图 / 快速预览"],
              ["← / →", "预览中切换上一张 / 下一张已加载图片"],
              ["双击预览空白处", "关闭大图或快速预览"],
              ["0–5", "清除 / 设置评分"],
              ["Delete", "图库中将所选原文件移到回收站，操作前确认数量"],
              ["Ctrl K", "聚焦搜索"],
              ["Esc", "关闭浮层 / 取消选择"],
            ].map(([a, b]) => (
              <div key={a}>
                <kbd>{a}</kbd><span>{b}</span>
              </div>
            ))}
          </div>
          <p className="if-dialog-example">
            输入文字和中文组合输入期间不执行图片快捷键。最近加入指最近7天。
          </p>
        </Modal>
      )}
      {toast && (
        <div
          className={`if-toast ${toast.kind === "error" ? "is-error" : ""}`}
          role={toast.kind === "error" ? "alert" : "status"}
          aria-live={toast.kind === "error" ? "assertive" : "polite"}
        >
          <Icon
            name={toast.kind === "error" ? "circle-alert" : "check-circle-2"}
            size={16}
          />
          <span>{toast.text}</span>
          {toast.undo && (
            <Button
              variant="ghost"
              onClick={() => {
                const undo = toast.undo;
                setToast(null);
                undo?.();
              }}
            >
              撤销
            </Button>
          )}
          <Button
            variant="ghost"
            aria-label="关闭提示"
            onClick={() => setToast(null)}
          >
            <Icon name="x" size={12} />
          </Button>
        </div>
      )}
      {fileMenu && <FileActionsMenu menu={fileMenu} missing={fileMenu.ids.length === 1 && items.some(item=>item.id === fileMenu.ids[0] && (item.missing || stats?.roots.some(root=>root.id === item.rootId && root.status === "offline")))} onClose={()=>setFileMenu(null)}
        onAction={(action,ids)=>void fileOperations.perform(action,ids)}/>}
      {fileOperations.report && <FileOperationReport result={fileOperations.report} onClose={fileOperations.closeReport}
        names={new Map(items.map(item=>[item.id,item.relativePath]))}/>}
    </div>
  );
}
