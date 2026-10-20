import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FileActionResult } from "../src/api.js";
import { api } from "./client";
import { Button, Icon, Modal } from "./ui";

export type FileAction = "copy" | "paths" | "open" | "reveal" | "trash";
export const fileActionLabels: Record<FileAction, string> = {
  copy: "复制文件",
  paths: "复制路径",
  open: "用默认程序打开",
  reveal: "打开所在文件夹",
  trash: "移到回收站",
};
export function useFileOperations({
  onChanged,
  notify,
}: {
  onChanged: () => Promise<unknown>;
  notify: (text: string, undo?: () => void, kind?: "success" | "error") => void;
}) {
  const [report, setReport] = useState<FileActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const perform = async (action: FileAction, sourceIds: string[]) => {
    const ids = [...new Set(sourceIds)];
    if (!ids.length || active.current) return;
    active.current = true;
    setBusy(true);
    try {
      if (action === "open" || action === "reveal") {
        await api.invoke(action === "open" ? "files.open" : "files.reveal", {
          fileId: ids[0],
        });
        return;
      }
      const result =
        action === "trash"
          ? await api.invoke("files.trash", { fileIds: ids })
          : await api.invoke("files.copy", {
              fileIds: ids,
              format: action === "copy" ? "files" : "paths",
            });
      if (result.canceled) return;
      if (action === "trash" && result.successIds.length) await onChanged();
      if (result.failures.length) setReport(result);
      const count = result.successIds.length;
      if (count)
        notify(
          action === "trash"
            ? `已将 ${count} 个原文件移到回收站`
            : `已复制 ${count} 个${action === "copy" ? "文件，可在资源管理器粘贴" : "文件路径"}`,
        );
    } catch (e) {
      notify((e as Error).message, undefined, "error");
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return { perform, busy, report, closeReport: () => setReport(null) };
}

export function FileActionsMenu({
  menu,
  onClose,
  onAction,
  missing = false,
  extras = [],
}: {
  menu: { x: number; y: number; ids: string[] };
  onClose: () => void;
  onAction: (action: FileAction, ids: string[]) => void;
  missing?: boolean;
  extras?: { label: string; icon: string; run: () => void }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const place = () => {
      const bounds = ref.current?.getBoundingClientRect();
      if (bounds) setPosition({
        x: Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8)),
        y: Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu.x, menu.y, extras.length]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", close);
    const blur = () => onClose();
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", blur);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="if-popover if-file-menu"
      ref={ref}
      role="menu"
      aria-label={`文件操作，已选 ${menu.ids.length} 个文件`}
      style={{
        left: position.x,
        top: position.y,
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
        maxWidth: "calc(100vw - 16px)",
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || e.key === "Tab") {
          onClose();
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const rows = [
            ...(ref.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) ?? []),
          ];
          const index = rows.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          rows[
            (index + (e.key === "ArrowDown" ? 1 : -1) + rows.length) %
              rows.length
          ]?.focus();
        }
      }}
    >
      <p className="if-file-menu-count">{missing ? "原文件缺失或目录离线" : `${menu.ids.length} 个实际文件`}</p>
      {(["copy", "paths", "reveal", "open", "trash"] as FileAction[]).map(
        (action) => (
          <button
            type="button"
            role="menuitem"
            key={action}
            className={`if-menu-row ${action === "trash" ? "is-danger" : ""}`}
            disabled={missing || ((action === "open" || action === "reveal") && menu.ids.length !== 1)}
            onClick={() => {
              onAction(action, [...menu.ids]);
              onClose();
            }}
          >
            <Icon
              name={
                {
                  copy: "copy",
                  paths: "link",
                  reveal: "folder-open",
                  open: "external-link",
                  trash: "trash-2",
                }[action]
              }
              size={14}
            />
            {fileActionLabels[action]}
          </button>
        ),
      )}
      {extras.map((extra) => <button type="button" role="menuitem" className="if-menu-row" key={extra.label}
        onClick={() => { extra.run(); onClose(); }}><Icon name={extra.icon} size={14} />{extra.label}</button>)}
    </div>,
    document.querySelector(".if-app") ?? document.body,
  );
}

export function FileOperationReport({
  result,
  onClose,
  names,
}: {
  result: FileActionResult;
  onClose: () => void;
  names: Map<string, string>;
}) {
  return (
    <Modal
      title="部分文件未能完成操作"
      onClose={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <p>
        成功 {result.successIds.length} 个，失败 {result.failures.length} 个。
      </p>
      <div className="if-file-failures" role="status">
        {result.failures.map((failure) => (
          <p key={failure.fileId}>
            <strong>{names.get(failure.fileId) || failure.fileId}</strong>
            <br />
            {failure.message}
          </p>
        ))}
      </div>
    </Modal>
  );
}
