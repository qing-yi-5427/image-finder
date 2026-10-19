import { useEffect, useId, useRef, useState } from "react";
import type { QueryRequest } from "../src/contracts.js";
import { Icon } from "./ui";

type Sort = NonNullable<QueryRequest["sort"]>;
const choices: { value: Sort; label: string }[] = [
  { value: "added_desc", label: "最新加入" },
  { value: "name", label: "文件名称" },
  { value: "pixels_desc", label: "图片尺寸" },
  { value: "rating_desc", label: "我的评分" },
  { value: "color", label: "颜色相似度" },
];
export function SortMenu({
  value,
  onChange,
  color,
}: {
  value: Sort;
  onChange: (value: Sort) => void;
  color: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const options = choices.filter((x) => x.value !== "color" || color);
  const effective = value === "color" && !color ? "added_desc" : value;
  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const selected = anchor.current?.querySelector<HTMLButtonElement>(
      '[aria-checked="true"]',
    );
    selected?.focus();
    const outside = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="if-popover-anchor if-sort-menu"
      ref={anchor}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
        if (e.key === "Tab") close(false);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const buttons = [
            ...(anchor.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitemradio"]',
            ) ?? []),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length
          ]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="if-button if-button-ghost"
        aria-label="图库排序"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {choices.find((x) => x.value === effective)?.label}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div
          id={id}
          className="if-popover if-sort-options"
          role="menu"
          aria-label="图库排序方式"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={effective === option.value}
              tabIndex={-1}
              className={`if-menu-row ${effective === option.value ? "active" : ""}`}
              onClick={() => {
                onChange(option.value);
                close();
              }}
            >
              <span>{option.label}</span>
              {effective === option.value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
