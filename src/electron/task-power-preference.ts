import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskPowerGuard } from "./task-power.js";
export interface TaskPowerStatus {
  enabled: boolean;
  active: boolean;
  error: string | null;
}
/** Main-process preference: loading and every failed read default to no blocker. */
export class TaskPowerPreference {
  private enabled = false;
  private needed = false;
  private error: string | null = null;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private filename: string,
    private guard: TaskPowerGuard,
    private store: {
      read?: (file: string) => Promise<string>;
      save?: (file: string, text: string) => Promise<void>;
    } = {},
  ) {}
  async initialize() {
    this.guard.close();
    try {
      const value = JSON.parse(
        await (this.store.read ?? ((f) => readFile(f, "utf8")))(this.filename),
      );
      if (typeof value.enabled !== "boolean") throw new Error("invalid");
      this.enabled = value.enabled;
    } catch (e: any) {
      this.enabled = false;
      if (e.code !== "ENOENT")
        this.error = "无法读取防休眠设置，已保持关闭；请重新保存。";
    }
    this.guard.update(this.enabled && this.needed);
    return this.status();
  }
  status(): TaskPowerStatus {
    return {
      enabled: this.enabled,
      active: this.guard.active,
      error: this.error,
    };
  }
  update(needed: boolean) {
    this.needed = needed;
    this.guard.update(this.enabled && needed);
  }
  async setEnabled(enabled: boolean) {
    const token = ++this.generation;
    if (!enabled) {
      this.enabled = false;
      this.guard.close();
    }
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        try {
          const text = JSON.stringify({ enabled }, null, 2) + "\n";
          if (this.store.save) await this.store.save(this.filename, text);
          else {
            await mkdir(path.dirname(this.filename), { recursive: true });
            const temp = this.filename + "." + randomUUID() + ".tmp";
            await writeFile(temp, text, "utf8");
            await rename(temp, this.filename);
          }
          if (token === this.generation) {
            this.enabled = enabled;
            this.error = null;
            this.guard.update(enabled && this.needed);
          }
          return this.status();
        } catch {
          if (token === this.generation) {
            this.enabled = false;
            this.guard.close();
            this.error = "防休眠设置保存失败，当前已关闭；重启前请重新保存。";
          }
          throw new Error("防休眠设置保存失败，当前已关闭；请重试。");
        }
      });
    this.tail = operation;
    return operation;
  }
}
