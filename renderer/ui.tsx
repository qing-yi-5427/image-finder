import React, { useEffect, useRef, useId } from "react";

// Standalone adapter: preserve the approved Icon API without a host window.lucide.
import { Icon } from "./IconAdapter";
export { Icon } from "./IconAdapter";

export function Button({
  variant = "secondary",
  className = "",
  children,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      type={type}
      className={`if-button if-button-${variant} cursor-interaction ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label className="if-toggle-label cursor-interaction">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label || "切换设置"}
      />
      <span className="if-toggle" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Modal({
  title,
  children,
  onClose,
  footer,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const input = ref.current?.querySelector<HTMLInputElement>(
      "input:not([type=checkbox]), select, textarea, button",
    );
    input?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div
      className="if-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`if-modal ${wide ? "if-modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          if (e.key === "Tab") {
            const nodes = Array.from(
              ref.current?.querySelectorAll<HTMLElement>(
                "button:not([disabled]), input:not([disabled]), select, textarea, a[href]",
              ) || [],
            ).filter((x) => x.getClientRects().length);
            const first = nodes[0],
              last = nodes[nodes.length - 1];
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
        <div className="if-modal-head">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" aria-label="关闭弹窗" onClick={onClose}>
            <Icon name="x" />
          </Button>
        </div>
        <div className="if-modal-content">{children}</div>
        {footer && <div className="if-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Stars({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <span className="if-stars" aria-label={`评分 ${value} 星`}>
      <button
        className={`cursor-interaction if-rating-zero ${value === 0 ? "active" : ""}`}
        onClick={() => onChange(0)}
        aria-label="清除评分"
      >
        0
      </button>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={`cursor-interaction ${n <= value ? "active" : ""}`}
          onClick={() => onChange(n === value ? 0 : n)}
          aria-label={`评为 ${n} 星`}
        >
          <Icon name="star" size={16} />
        </button>
      ))}
    </span>
  );
}
