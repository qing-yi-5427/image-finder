export interface PixivQueueSettings {
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  batchLimit: number;
  autoRest: boolean;
  restMinutes: number;
}

export const DEFAULT_PIXIV_QUEUE_SETTINGS: PixivQueueSettings = {
  intervalMinSeconds: 10,
  intervalMaxSeconds: 15,
  batchLimit: 200,
  autoRest: true,
  restMinutes: 15,
};

export function validatePixivQueueSettings(
  value: unknown,
): asserts value is PixivQueueSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请输入完整的 Pixiv 请求设置。");
  const settings = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_PIXIV_QUEUE_SETTINGS);
  if (
    Object.keys(settings).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(settings, key))
  )
    throw new Error("请输入完整的 Pixiv 请求设置，不能包含未知字段。");
  const integer = (key: string, min: number, max: number) =>
    typeof settings[key] === "number" &&
    Number.isInteger(settings[key]) &&
    Number(settings[key]) >= min &&
    Number(settings[key]) <= max;
  if (
    !integer("intervalMinSeconds", 1, 3600) ||
    !integer("intervalMaxSeconds", 1, 3600) ||
    Number(settings.intervalMaxSeconds) < Number(settings.intervalMinSeconds)
  )
    throw new Error("请求间隔须为 1–3600 秒的整数，最大间隔不能小于最小间隔。");
  if (!integer("batchLimit", 1, 10000))
    throw new Error("每批请求数须为 1–10000 的整数。");
  if (typeof settings.autoRest !== "boolean")
    throw new Error("自动休息选项无效。");
  if (!integer("restMinutes", 1, 1440))
    throw new Error("批次休息须为 1–1440 分钟的整数。");
}
