import { api } from "./client";
import React, { useEffect, useState } from "react";
import { Button, Icon, Modal } from "./ui";
import type { TagDto, MethodMap } from "../src/api";
import type { TagCategory } from "../src/contracts";
import "./TagManager.css";
const categories: Record<TagCategory, string> = {
  character: "角色",
  franchise: "作品",
  content: "内容",
  style: "风格",
  uncategorized: "未分类",
};
type Props = {
  notify: (text: string, undo?: () => void) => void;
  onBrowseTag: (id: string) => void;
  initialTag?: string;
  onChanged?: () => void;
};
export function TagManager({
  notify,
  onBrowseTag,
  initialTag,
  onChanged,
}: Props) {
  const [rows, setRows] = useState<TagDto[]>([]),
    [text, setText] = useState(""),
    [category, setCategory] = useState<TagCategory | "">(""),
    [offset, setOffset] = useState(0),
    [activeId, setActiveId] = useState(initialTag || ""),
    [checked, setChecked] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(""),
    [alias, setAlias] = useState(""),
    [draftCategory, setDraftCategory] = useState<TagCategory>("uncategorized"),
    [modal, setModal] = useState<"create" | "categorize" | "merge" | null>(
      null,
    ),
    [newName, setNewName] = useState(""),
    [bulk, setBulk] = useState<TagCategory>("uncategorized"),
    [target, setTarget] = useState(""),
    [preview, setPreview] = useState<
      MethodMap["tags.mergePreview"]["result"] | null
    >(null);
  const active = rows.find((t) => t.id === activeId);
  const refresh = async () => {
    const result = await api.invoke("tags.list", {
      text,
      category: category || undefined,
      offset,
      limit: 50,
    });
    setRows(result);
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let live = true;
    api
      .invoke("tags.list", {
        text,
        category: category || undefined,
        offset,
        limit: 50,
      })
      .then((r) => {
        if (live) setRows(r);
      })
      .catch((e) => notify(String(e)));
    return () => {
      live = false;
    };
  }, [text, category, offset]);
  useEffect(() => {
    if (initialTag) setActiveId(initialTag);
  }, [initialTag]);
  useEffect(() => {
    setName(active?.name || "");
    setDraftCategory(active?.category || "uncategorized");
    setAlias("");
  }, [active]);
  const changed = async () => {
    await refresh();
    onChanged?.();
  };
  const undo = (undoId: string) => () => {
    void run(async () => {
      await api.invoke("tags.undo", { undoId });
      await changed();
      notify("已撤销标签整理");
    });
  };
  const choose = (id: string) =>
    setChecked((v) =>
      v.includes(id) ? v.filter((x) => x !== id) : [...v, id],
    );
  return (
    <section className="if-tags">
      <header className="if-tags-heading">
        <div>
          <h1 className="if-page-title">标签管理</h1>
          <p className="if-subtitle">
            统一名称、别名与分类，整理真实图库标签。
          </p>
        </div>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            setNewName("");
            setModal("create");
          }}
        >
          <Icon name="plus" size={15} />
          新建标签
        </Button>
      </header>
      <div className="if-tags-workspace">
        <aside className="if-tags-categories">
          <button
            className={`if-tags-category ${category === "" ? "is-active" : ""}`}
            onClick={() => {
              setCategory("");
              setOffset(0);
              setChecked([]);
            }}
          >
            全部标签
          </button>
          {Object.entries(categories).map(([id, label]) => (
            <button
              className={`if-tags-category ${category === id ? "is-active" : ""}`}
              key={id}
              onClick={() => {
                setCategory(id as TagCategory);
                setOffset(0);
                setChecked([]);
              }}
            >
              {label}
            </button>
          ))}
        </aside>
        <section className="if-tags-list-panel">
          <div className="if-tags-list-header">
            <input
              aria-label="搜索标签和别名"
              className="if-input"
              placeholder="搜索名称或别名"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setOffset(0);
                setChecked([]);
              }}
            />
            <Button
              disabled={busy || !checked.length}
              onClick={() => setModal("categorize")}
            >
              批量归类（{checked.length}）
            </Button>
            <Button
              disabled={busy || checked.length !== 2}
              onClick={() => {
                setTarget(checked[1]);
                setPreview(null);
                setModal("merge");
              }}
            >
              合并两个名称
            </Button>
          </div>
          <div className="if-tags-table-scroll">
            {rows.length ? (
              <table className="if-tags-table">
                <thead>
                  <tr>
                    <th className="if-tags-check-cell">
                      <input
                        type="checkbox"
                        aria-label="选择本页全部标签"
                        checked={
                          rows.length > 0 &&
                          rows.every((t) => checked.includes(t.id))
                        }
                        onChange={(e) =>
                          setChecked(
                            e.target.checked ? rows.map((t) => t.id) : [],
                          )
                        }
                      />
                    </th>
                    <th>标准名称 / 别名</th>
                    <th>分类</th>
                    <th>图片数</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className={`${activeId === row.id ? "is-current" : ""} ${checked.includes(row.id) ? "is-checked" : ""}`}
                      onClick={() => setActiveId(row.id)}
                    >
                      <td
                        className="if-tags-check-cell"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          aria-label={`选择 ${row.name}`}
                          type="checkbox"
                          checked={checked.includes(row.id)}
                          onChange={() => choose(row.id)}
                        />
                      </td>
                      <td className="if-tags-name-cell">
                        <button
                          className="if-tags-name-button"
                          onClick={() => setActiveId(row.id)}
                        >
                          <span className="if-tags-standard-name">
                            {row.name}
                          </span>
                          <span className="if-tags-alias-preview">
                            {row.aliases.join(" · ") || "尚无别名"}
                          </span>
                        </button>
                      </td>
                      <td>
                        <span className="if-tags-type">
                          {categories[row.category]}
                        </span>
                      </td>
                      <td className="if-tags-count-cell">
                        {row.usageCount} 张
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="if-tags-empty">
                <Icon name="tags" />
                <h3>没有符合条件的标签</h3>
                <p>添加图片来源标签或新建整理标签。</p>
              </div>
            )}
          </div>
          <footer className="if-tags-list-footer">
            <Button
              disabled={busy || offset === 0}
              onClick={() => {
                setOffset(Math.max(0, offset - 50));
                setChecked([]);
              }}
            >
              上一页
            </Button>
            <span>
              第 {offset / 50 + 1} 页 · 本页 {rows.length} 个
            </span>
            <Button
              disabled={busy || rows.length < 50}
              onClick={() => {
                setOffset(offset + 50);
                setChecked([]);
              }}
            >
              下一页
            </Button>
          </footer>
        </section>
        <aside className="if-tags-detail" aria-label="标签详情编辑">
          {active ? (
            <>
              <div className="if-tags-detail-heading">
                <Icon name="tag" />
                <h2>标签详情</h2>
              </div>
              <div className="if-tags-detail-fields">
                <div className="if-tags-field">
                  <label className="if-label" htmlFor="tag-name">
                    标准名称
                  </label>
                  <input
                    id="tag-name"
                    className="if-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="if-tags-field">
                  <label className="if-label" htmlFor="tag-category">
                    分类
                  </label>
                  <select
                    id="tag-category"
                    className="if-select"
                    value={draftCategory}
                    onChange={(e) =>
                      setDraftCategory(e.target.value as TagCategory)
                    }
                  >
                    {Object.entries(categories).map(([id, label]) => (
                      <option value={id} key={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  disabled={
                    busy ||
                    !name.trim() ||
                    (name === active.name && draftCategory === active.category)
                  }
                  variant="primary"
                  onClick={() =>
                    run(async () => {
                      await api.invoke("tags.update", {
                        tagId: active.id,
                        name: name.trim(),
                        category: draftCategory,
                      });
                      await changed();
                      notify("标签已保存");
                    })
                  }
                >
                  应用修改
                </Button>
                <div className="if-tags-field">
                  <label className="if-label" htmlFor="tag-alias">
                    别名
                  </label>
                  <p>{active.aliases.join(" · ") || "尚无别名"}</p>
                  <input
                    id="tag-alias"
                    className="if-input"
                    placeholder="添加一个别名"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                  />
                  <Button
                    disabled={busy || !alias.trim()}
                    onClick={() =>
                      run(async () => {
                        await api.invoke("tags.addAlias", {
                          tagId: active.id,
                          alias: alias.trim(),
                        });
                        await changed();
                        notify("别名已添加");
                      })
                    }
                  >
                    添加别名
                  </Button>
                </div>
                <div className="if-tags-usage">
                  <p>
                    使用此标签的图片 <strong>{active.usageCount} 张</strong>
                  </p>
                  <Button onClick={() => onBrowseTag(active.id)}>
                    <Icon name="images" />
                    浏览全部图片
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="if-tags-empty">
              <Icon name="tag" />
              <h3>选择一个标签</h3>
              <p>查看名称、别名和关联图片。</p>
            </div>
          )}
        </aside>
      </div>
      {modal === "create" && (
        <Modal
          title="新建标签"
          onClose={() => !busy && setModal(null)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setModal(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={busy || !newName.trim()}
                onClick={() =>
                  run(async () => {
                    const id = await api.invoke("tags.create", {
                      name: newName.trim(),
                      category: bulk,
                    });
                    await changed();
                    setActiveId(id);
                    setModal(null);
                    notify("标签已创建");
                  })
                }
              >
                创建标签
              </Button>
            </>
          }
        >
          <div className="if-tags-field">
            <label className="if-label" htmlFor="new-tag-name">
              标准名称
            </label>
            <input
              id="new-tag-name"
              className="if-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <select
            aria-label="新标签分类"
            className="if-select"
            value={bulk}
            onChange={(e) => setBulk(e.target.value as TagCategory)}
          >
            {Object.entries(categories).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Modal>
      )}
      {modal === "categorize" && (
        <Modal
          title="批量归类"
          onClose={() => !busy && setModal(null)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setModal(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await api.invoke("tags.classify", {
                      tagIds: checked,
                      category: bulk,
                    });
                    await changed();
                    setModal(null);
                    setChecked([]);
                    notify("所选标签已归类", undo(result.undoId));
                  })
                }
              >
                应用到 {checked.length} 个标签
              </Button>
            </>
          }
        >
          <p>保留每个标签的独立名称。</p>
          <select
            aria-label="批量分类"
            className="if-select"
            value={bulk}
            onChange={(e) => setBulk(e.target.value as TagCategory)}
          >
            {Object.entries(categories).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Modal>
      )}
      {modal === "merge" && (
        <Modal
          title="合并为同一个标签的别名"
          onClose={() => !busy && setModal(null)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setModal(null)}>
                取消
              </Button>
              {!preview ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () =>
                      setPreview(
                        await api.invoke("tags.mergePreview", {
                          sourceId: checked.find((id) => id !== target)!,
                          targetId: target,
                        }),
                      ),
                    )
                  }
                >
                  加载合并预览
                </Button>
              ) : (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const result = await api.invoke("tags.merge", {
                        sourceId: preview.fromId,
                        targetId: preview.toId,
                      });
                      setModal(null);
                      setChecked([]);
                      setActiveId(preview.toId);
                      await changed();
                      notify("标签已合并", undo(result.undoId));
                    })
                  }
                >
                  确认合并
                </Button>
              )}
            </>
          }
        >
          <p>保留哪个标准名称？此操作会修改标签引用；完成后可以撤销。</p>
          {checked.map((id) => (
            <label className="if-tags-merge-option" key={id}>
              <input
                type="radio"
                checked={target === id}
                onChange={() => {
                  setTarget(id);
                  setPreview(null);
                }}
              />
              {rows.find((t) => t.id === id)?.name || id}
            </label>
          ))}
          {preview && (
            <div className="if-tags-merge-preview">
              <h3>合并预览</h3>
              <p>涉及图片：{preview.files} 张</p>
              <p>覆盖冲突：{preview.overrideConflicts.n}</p>
              <p>
                别名：{preview.aliases.map((a) => a.alias).join(" · ") || "无"}
              </p>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
export default TagManager;
