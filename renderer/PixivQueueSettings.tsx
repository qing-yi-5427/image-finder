import React, { useEffect, useState } from "react";
import { api } from "./client";
import { Button } from "./ui";
import {
  validatePixivQueueSettings,
  type PixivQueueSettings,
} from "../src/core/queue-settings";

export function PixivQueueSettingsForm({
  onSaved,
  notify,
}: {
  onSaved?: () => void;
  notify: (text: string, undo?: () => void, kind?: "success" | "error") => void;
}) {
  const [value, setValue] = useState<PixivQueueSettings | null>(null);
  const [fields, setFields] = useState({
    minimum: "",
    maximum: "",
    batch: "",
    rest: "",
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let alive = true;
    void api
      .invoke("jobs.settings", {})
      .then((settings) => {
        if (!alive) return;
        setValue(settings);
        setFields({
          minimum: String(settings.intervalMinSeconds),
          maximum: String(settings.intervalMaxSeconds),
          batch: String(settings.batchLimit),
          rest: String(settings.restMinutes),
        });
      })
      .catch((error) => {
        if (alive) setFailure(String(error));
      });
    return () => {
      alive = false;
    };
  }, []);
  const save = async () => {
    if (!value || busy) return;
    setFailure("");
    setBusy(true);
    try {
      const settings = {
        intervalMinSeconds: Number(fields.minimum),
        intervalMaxSeconds: Number(fields.maximum),
        batchLimit: Number(fields.batch),
        restMinutes: Number(fields.rest),
        autoRest: value.autoRest,
      };
      validatePixivQueueSettings(settings);
      await api.invoke("jobs.configure", settings);
      notify("Pixiv 请求设置已保存；已暂停的任务需手动继续");
      onSaved?.();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="if-pixiv-queue-settings" aria-label="Pixiv 请求设置">
      <div className="if-pixiv-settings-grid">
        {(
          [
            ["minimum", "最小请求间隔（秒）", 1, 3600],
            ["maximum", "最大请求间隔（秒）", 1, 3600],
            ["batch", "每批请求数（次）", 1, 10000],
            ["rest", "批次休息（分钟）", 1, 1440],
          ] as const
        ).map(([key, label, min, max]) => (
          <label className="if-utility-field" key={key}>
            <span>{label}</span>
            <input
              className="if-input"
              type="number"
              min={min}
              max={max}
              step="1"
              disabled={!value || busy}
              value={fields[key]}
              onChange={(event) =>
                setFields((old) => ({ ...old, [key]: event.target.value }))
              }
            />
          </label>
        ))}
      </div>
      <label className="if-pixiv-option">
        <input
          type="checkbox"
          disabled={!value || busy}
          checked={value?.autoRest ?? false}
          onChange={(event) =>
            setValue((old) =>
              old ? { ...old, autoRest: event.target.checked } : old,
            )
          }
        />
        每批用完后自动休息，到时继续下一批
      </label>
      <p className="if-setting-description">
        每次请求完成后，在最小与最大间隔之间随机等待；失败也计入本批。允许间隔
        1–3600 秒、每批 1–10000 次、休息 1–1440 分钟。默认 10–15 秒、每批 200
        次，自动休息 15 分钟后继续。这些是软件设置，并非官方安全额度。
      </p>
      <p className="if-setting-description">
        保存设置不会恢复已暂停的队列。已有休息截止时间保持不变；关闭自动休息后需手动继续。登录、访问限制、安全验证或限流都会立即暂停全队列，须处理原因后手动继续。
      </p>
      {failure && (
        <p role="alert" className="if-pixiv-error">
          {failure}
        </p>
      )}
      <Button disabled={!value || busy} onClick={() => void save()}>
        保存请求设置
      </Button>
    </div>
  );
}
