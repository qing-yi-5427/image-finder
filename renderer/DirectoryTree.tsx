import { useEffect, useRef, useState } from "react";
import type { DirectoryItem, LibraryRoot } from "../src/contracts.js";
import { api } from "./client";
import { Icon } from "./ui";

export const directorySection = (rootId: string, relativePath: string) =>
  `directory:${JSON.stringify([rootId, relativePath])}`;

export function DirectoryTree({
  roots,
  section,
  onSelect,
  revision = 0,
}: {
  roots: LibraryRoot[];
  section: string;
  revision?: number;
  onSelect: (section: string, path: string) => void;
}) {
  return (
    <div className="if-directory-tree" aria-label="原目录文件夹">
      {roots.map((root) => (
        <DirectoryNode
          key={root.id}
          root={root}
          section={section}
          relativePath=""
          name={root.path.split(/[\\/]/).filter(Boolean).at(-1) || root.path}
          fullPath={root.path}
          depth={0}
          hasChildren
          onSelect={onSelect}
          revision={revision}
        />
      ))}
    </div>
  );
}

function DirectoryNode({
  root,
  section,
  relativePath,
  name,
  fullPath,
  depth,
  hasChildren,
  imageCount,
  onSelect,
  revision,
}: {
  root: LibraryRoot;
  section: string;
  relativePath: string;
  name: string;
  fullPath: string;
  depth: number;
  hasChildren: boolean;
  imageCount?: number;
  revision: number;
  onSelect: (section: string, path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirectoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const version = useRef(0);
  const id = relativePath
    ? directorySection(root.id, relativePath)
    : `root:${root.id}`;
  const load = async (offset = 0) => {
    const token = version.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.invoke("library.directories", {
        rootId: root.id,
        relativePath,
        offset,
        limit: 100,
      });
      if (token !== version.current) return;
      setChildren((old) => (offset ? [...old, ...result.items] : result.items));
      setTotal(result.total);
      setLoaded(true);
    } catch (e) {
      if (token === version.current) setError((e as Error).message);
    } finally {
      if (token === version.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (open && !loaded && !loading && !error) void load();
  }, [open, loaded, loading, error]);
  useEffect(() => {
    version.current++;
    setLoaded(false);
    setLoading(false);
    setError("");
    setChildren([]);
    return () => {
      version.current++;
    };
  }, [root.path, root.lastScanAt, revision]);
  return (
    <div className="if-directory-node">
      <div
        className={`if-directory-row ${section === id ? "active" : ""}`}
        style={{ paddingLeft: depth * 13 }}
      >
        <button
          className="if-directory-expand"
          aria-label={`${open ? "收起" : "展开"}文件夹 ${fullPath}`}
          aria-expanded={open}
          disabled={!hasChildren}
          onClick={() => setOpen((v) => !v)}
        >
          {hasChildren && (
            <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />
          )}
        </button>
        <button
          className="if-directory-select"
          title={fullPath}
          aria-label={`浏览文件夹 ${fullPath}`}
          aria-current={section === id ? "page" : undefined}
          onClick={() => onSelect(id, fullPath)}
        >
          <Icon name={depth ? "folder" : "hard-drive"} size={14} />
          <span className="if-nav-name">{name}</span>
          {imageCount !== undefined && (
            <small>{imageCount.toLocaleString()}</small>
          )}
        </button>
      </div>
      {open && (
        <div className="if-directory-children">
          {children.map((child) => (
            <DirectoryNode
              key={child.relativePath}
              root={root}
              section={section}
              relativePath={child.relativePath}
              name={child.name}
              fullPath={child.path}
              depth={depth + 1}
              hasChildren={child.hasChildren}
              imageCount={child.imageCount}
              onSelect={onSelect}
              revision={revision}
            />
          ))}
          {loading && (
            <span className="if-directory-note" role="status">
              正在读取文件夹…
            </span>
          )}
          {error && (
            <button className="if-directory-note" onClick={() => void load()}>
              读取失败，点击重试
            </button>
          )}
          {loaded && !children.length && (
            <span className="if-directory-note">没有子文件夹</span>
          )}
          {children.length < total && !loading && (
            <button
              className="if-directory-note"
              onClick={() => void load(children.length)}
            >
              显示更多文件夹（{total - children.length}）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
