import { api } from "./client";
import { useEffect, useState } from "react";
import type { Filter, TagCategory, TagGroup } from "../src/contracts.js";
import type { TagDto, AuthorDto } from "../src/api.js";
import { Button, Icon, Toggle } from "./ui";
import { validateFilter,updateTagGroup } from "./model";
import "./FilterPanel.css";
export const COLORS: Record<string, string> = {
  红色: "#dd6c72",
  橙色: "#dfa060",
  黄色: "#e3c86f",
  绿色: "#78ac85",
  青色: "#6eb6ba",
  蓝色: "#648ddd",
  紫色: "#ad8dd4",
  粉色: "#d697b6",
  灰色: "#9197a2",
};
function EntityPicker({
  category,
  ids,
  onChange,
  authors = false,
}: {
  category?: TagCategory;
  ids: string[];
  onChange: (ids: string[]) => void;
  authors?: boolean;
}) {
  const [text, setText] = useState(""),
    [rows, setRows] = useState<(TagDto | AuthorDto)[]>([]),
    [known, setKnown] = useState<Record<string, string>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const t = setTimeout(() => {
      const request = authors
        ? api.invoke("authors.list", { text, limit: 100 })
        : api.invoke("tags.list", { text, category, limit: 100 });
      void request
        .then((items) => {
          if (active) {
            setRows(items);
            setError("");
            setKnown((k) => ({
              ...k,
              ...Object.fromEntries(items.map((x) => [x.id, x.name])),
            }));
          }
        })
        .catch((e) => active && setError(String(e.message)));
    }, 180);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [text, category, authors]);
  return (
    <div className="if-filter-picker">
      <div className="if-filter-selected">
        {ids.map((id) => (
          <Button
            key={id}
            variant="ghost"
            onClick={() => onChange(ids.filter((x) => x !== id))}
          >
            {known[id] || id}
            <Icon name="x" size={11} />
          </Button>
        ))}
      </div>
      <input
        className="if-input"
        aria-label={`搜索${authors ? "作者" : "标签"}`}
        placeholder="输入名称或别名查找…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <div className="live-picker-options">
        {rows.map((row) => (
          <button
            key={row.id}
            className={`if-menu-row ${ids.includes(row.id) ? "active" : ""}`}
            onClick={() =>
              onChange(
                ids.includes(row.id)
                  ? ids.filter((x) => x !== row.id)
                  : [...ids, row.id],
              )
            }
          >
            <Icon
              name={ids.includes(row.id) ? "square-check" : "square"}
              size={12}
            />
            {row.name}
            <small>{row.usageCount}</small>
          </button>
        ))}
        {!rows.length && <small>没有匹配项</small>}
        {rows.length === 100 && <small>显示前100项，请输入名称缩小范围</small>}
      </div>
    </div>
  );
}
export function FilterPanel({
  value,
  onChange,
  onClose,
  onSave,
  onSortColor,
}: {
  value: Filter;
  onChange: (f: Filter) => void;
  onClose: () => void;
  onSave: () => void;
  onSortColor: () => void;
}) {
  const [draft, setDraft] = useState(value),
    [error, setError] = useState("");
  useEffect(() => setDraft(value), [value]);
  const put = (p: Partial<Filter>) => setDraft({ ...draft, ...p });
  const group = (i: number): TagGroup =>
    draft.tags?.[i] ?? { ids: [], mode: "any" };
  const updateGroup = (i: number, p: Partial<TagGroup>) => {
    put({ tags: updateTagGroup(draft.tags,i,p) });
  };
  const apply = () => {
    const e = validateFilter(draft);
    setError(e || "");
    if (!e) onChange(draft);
  };
  const [sizeUnit, setSizeUnit] = useState<"MiB" | "KiB">("MiB");
  const number = (
    key: keyof Filter,
    label: string,
    unit = "px",
    multiplier = 1,
  ) => (
    <label className="live-number-field">
      {label}
      <input
        className="if-input"
        type="number"
        min="0"
        aria-label={label}
        value={
          typeof draft[key] === "number"
            ? (draft[key] as number) / multiplier
            : ""
        }
        onChange={(e) =>
          put({
            [key]:
              e.target.value === ""
                ? undefined
                : Number(e.target.value) * multiplier,
          })
        }
      />
      <small>{unit}</small>
    </label>
  );
  return (
    <aside className="if-filter-panel">
      <div className="if-filter-header">
        <h2>组合筛选</h2>
        <Button variant="ghost" aria-label="关闭筛选" onClick={onClose}>
          <Icon name="x" size={15} />
        </Button>
      </div>
      <div className="if-filter-content">
        {(["角色", "作品", "内容与风格标签", "其他标签"] as const).map(
          (name, i) => (
            <section className="if-filter-section" key={name}>
              <div className="if-filter-section-title">
                <h3>{name}</h3>
                <select
                  className="if-select"
                  aria-label={`${name}匹配逻辑`}
                  value={group(i).mode ?? "any"}
                  onChange={(e) =>
                    updateGroup(i, { mode: e.target.value as "any" | "all" })
                  }
                >
                  <option value="any">任意一个</option>
                  <option value="all">全部包含</option>
                </select>
              </div>
              <EntityPicker
                category={
                  (
                    [
                      "character",
                      "franchise",
                      undefined,
                      "uncategorized",
                    ] as const
                  )[i]
                }
                ids={group(i).ids}
                onChange={(ids) => updateGroup(i, { ids })}
              />
            </section>
          ),
        )}
        <section className="if-filter-section">
          <h3>作者 · 任意一个</h3>
          <EntityPicker
            authors
            ids={draft.creatorIds ?? []}
            onChange={(creatorIds) => put({ creatorIds })}
          />
        </section>
        <section className="if-filter-section">
          <h3>排除标签</h3>
          <EntityPicker
            ids={draft.excludeTagIds ?? []}
            onChange={(excludeTagIds) => put({ excludeTagIds })}
          />
        </section>
        <section className="if-filter-section">
          <h3>画面颜色</h3>
          <div className="if-color-options">
            {Object.entries(COLORS).map(([name, hex]) => (
              <button
                key={hex}
                aria-label={name}
                title={name}
                className={draft.color?.hex === hex ? "active" : ""}
                style={{
                  background: hex,
                  width: 24,
                  height: 24,
                  borderRadius: 20,
                  border:
                    draft.color?.hex === hex
                      ? "2px solid white"
                      : "1px solid transparent",
                }}
                onClick={() =>
                  put({
                    color: {
                      hex,
                      tolerance: 35,
                      minWeight: 0.08,
                      restrict: true,
                      includeUnanalyzed: true,
                    },
                  })
                }
              />
            ))}
          </div>
          <label className="live-number-field">
            自定义颜色
            <input
              type="color"
              value={draft.color?.hex ?? "#648ddd"}
              onChange={(e) =>
                put({ color: { ...draft.color, hex: e.target.value } })
              }
            />
          </label>
          {draft.color && (
            <>
              <Toggle
                checked={draft.color.restrict !== false}
                onChange={(restrict) =>
                  put({ color: { ...draft.color!, restrict } })
                }
                label="只显示相近颜色"
              />
              <label className="if-label">
                色差容许值（Lab距离） {draft.color.tolerance ?? 35}
                <input
                  type="range"
                  min="0"
                  max="150"
                  value={draft.color.tolerance ?? 35}
                  onChange={(e) =>
                    put({
                      color: { ...draft.color!, tolerance: +e.target.value },
                    })
                  }
                />
              </label>
              <small>数值越大，允许的颜色差异越大。</small>
              <label className="if-label">
                主色最低占比 {Math.round((draft.color.minWeight ?? 0.08) * 100)}
                %
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={(draft.color.minWeight ?? 0.08) * 100}
                  onChange={(e) =>
                    put({
                      color: {
                        ...draft.color!,
                        minWeight: +e.target.value / 100,
                      },
                    })
                  }
                />
              </label>
              <Toggle
                checked={!!draft.color.includeUnanalyzed}
                onChange={(includeUnanalyzed) =>
                  put({ color: { ...draft.color!, includeUnanalyzed } })
                }
                label="包含尚未分析的图片"
              />
              <div className="if-row">
                <Button
                  onClick={() => {
                    const e = validateFilter(draft);
                    if (e) {
                      setError(e);
                      return;
                    }
                    onChange(draft);
                    onSortColor();
                  }}
                >
                  按颜色相似度排序
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => put({ color: undefined })}
                >
                  清除颜色
                </Button>
              </div>
            </>
          )}
        </section>
        <section className="if-filter-section">
          <h3>冷暖、明暗与饱和度</h3>
          <select
            className="if-select"
            aria-label="色调"
            value={draft.tone?.warmth ?? ""}
            onChange={(e) =>
              put({
                tone: {
                  ...draft.tone,
                  warmth: (e.target.value || undefined) as
                    | "warm"
                    | "cool"
                    | "neutral"
                    | undefined,
                },
              })
            }
          >
            <option value="">不限冷暖</option>
            <option value="cool">冷色调</option>
            <option value="warm">暖色调</option>
            <option value="neutral">中性色调</option>
          </select>
          <select
            className="if-select"
            aria-label="明暗"
            value={
              draft.tone?.brightnessMax !== undefined
                ? "dark"
                : draft.tone?.brightnessMin !== undefined
                  ? "light"
                  : ""
            }
            onChange={(e) =>
              put({
                tone: {
                  ...draft.tone,
                  brightnessMin: e.target.value === "light" ? 0.65 : undefined,
                  brightnessMax: e.target.value === "dark" ? 0.35 : undefined,
                },
              })
            }
          >
            <option value="">不限明暗</option>
            <option value="light">明亮 ≥ 0.65</option>
            <option value="dark">暗调 ≤ 0.35</option>
          </select>
          <select
            className="if-select"
            aria-label="饱和度"
            value={
              draft.tone?.saturationMax === 0.12
                ? "mono"
                : draft.tone?.saturationMax !== undefined
                  ? "low"
                  : draft.tone?.saturationMin !== undefined
                    ? "high"
                    : ""
            }
            onChange={(e) =>
              put({
                tone: {
                  ...draft.tone,
                  saturationMin: e.target.value === "high" ? 0.65 : undefined,
                  saturationMax:
                    e.target.value === "mono"
                      ? 0.12
                      : e.target.value === "low"
                        ? 0.35
                        : undefined,
                },
              })
            }
          >
            <option value="">不限饱和度</option>
            <option value="high">高饱和 ≥ 0.65</option>
            <option value="low">低饱和 ≤ 0.35</option>
            <option value="mono">近似黑白 ≤ 0.12</option>
          </select>
          <small>色调条件只匹配已分析项。</small>
        </section>
        <section className="if-filter-section">
          <h3>本地尺寸与大小</h3>
          <select
            className="if-select"
            aria-label="方向"
            value={draft.orientation ?? ""}
            onChange={(e) =>
              put({
                orientation: (e.target.value ||
                  undefined) as Filter["orientation"],
              })
            }
          >
            <option value="">不限方向</option>
            <option value="portrait">竖图</option>
            <option value="landscape">横图</option>
            <option value="square">方图</option>
          </select>
          {number("widthMin", "最小宽度")}
          {number("widthMax", "最大宽度")}
          {number("heightMin", "最小高度")}
          {number("heightMax", "最大高度")}
          <label className="live-number-field">
            文件大小单位
            <select
              className="if-select"
              aria-label="文件大小单位"
              value={sizeUnit}
              onChange={(e) => setSizeUnit(e.target.value as "MiB" | "KiB")}
            >
              <option value="MiB">MB（1024²字节）</option>
              <option value="KiB">KB（1024字节）</option>
            </select>
          </label>
          {number(
            "bytesMin",
            "最小文件大小",
            sizeUnit,
            sizeUnit === "MiB" ? 1024 ** 2 : 1024,
          )}
          {number(
            "bytesMax",
            "最大文件大小",
            sizeUnit,
            sizeUnit === "MiB" ? 1024 ** 2 : 1024,
          )}
          <label className="live-number-field">
            常用比例
            <select
              className="if-select"
              aria-label="常用宽高比例"
              value={
                [1, 16 / 9, 9 / 16, 4 / 3, 3 / 4].includes(draft.aspect ?? 0)
                  ? String(draft.aspect)
                  : draft.aspect
                    ? "custom"
                    : ""
              }
              onChange={(e) => {
                if (e.target.value !== "custom")
                  put({
                    aspect: e.target.value ? Number(e.target.value) : undefined,
                    aspectTolerance: 0.05,
                  });
              }}
            >
              <option value="">不限比例</option>
              <option value="1">1:1</option>
              <option value={16 / 9}>16:9</option>
              <option value={9 / 16}>9:16</option>
              <option value={4 / 3}>4:3</option>
              <option value={3 / 4}>3:4</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          {number("aspect", "宽高比", "宽 ÷ 高")}
          {number("aspectTolerance", "比例容差", "绝对差")}
          <small>数值包含边界，MB/KB采用1024进制，内部以字节保存。</small>
        </section>
        <section className="if-filter-section">
          <h3>我的整理</h3>
          <Toggle
            checked={draft.favorite === true}
            onChange={(v) => put({ favorite: v ? true : undefined })}
            label="只看收藏"
          />
          {number("ratingMin", "最低评分", "0–5")}
          <Toggle
            checked={!!draft.unorganized}
            onChange={(v) => put({ unorganized: v || undefined })}
            label="未整理"
          />
          <Toggle
            checked={!!draft.missing}
            onChange={(v) => put({ missing: v || undefined })}
            label="文件缺失"
          />
        </section>
      </div>
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      <div className="if-filter-footer">
        <Button
          onClick={() => {
            setDraft({});
            onChange({});
          }}
        >
          清空
        </Button>
        <Button variant="primary" onClick={apply}>
          应用筛选
        </Button>
        <Button
          onClick={() => {
            const e = validateFilter(draft);
            if (e) {
              setError(e);
              return;
            }
            onChange(draft);
            onSave();
          }}
        >
          保存智能集合
        </Button>
      </div>
    </aside>
  );
}
