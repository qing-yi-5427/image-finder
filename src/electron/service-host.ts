import { fork, type ChildProcess } from "node:child_process";
import type { SourceReply } from "../core/network-contract.js";
import { fileURLToPath } from "node:url";
export class ServiceHost {
  private child: ChildProcess;
  private serial = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    dataDir: string,
    transport?: (url: string) => Promise<SourceReply>,
    options: {
      startPaused?: boolean;
      cachePreferenceFile?: string;
      aiHomePreferenceFile?: string;
      sauceRequest?: (
        preview: Uint8Array,
      ) => Promise<{ status: number; body: string }>;
    } = {},
  ) {
    this.child = fork(
      fileURLToPath(new URL("../workers/service-worker.js", import.meta.url)),
      [dataDir, ...(options.startPaused ? ["--start-paused"] : []),
        ...(options.cachePreferenceFile ? [`--cache-preferences=${options.cachePreferenceFile}`] : []),
        ...(options.aiHomePreferenceFile ? [`--ai-home-preferences=${options.aiHomePreferenceFile}`] : [])],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    this.child.stderr?.on("data", () => {});
    this.child.on("message", (m: any) => {
      if (m?.kind === "sauce-request") {
        const data = m.preview;
        const valid =
          Array.isArray(data) &&
          data.length > 10 &&
          data.length <= 1024 * 1024 &&
          data.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
        void (
          valid && options.sauceRequest
            ? options.sauceRequest(Uint8Array.from(data))
            : Promise.reject(new Error("Denied"))
        ).then(
          (result) => {
            if (this.child.connected)
              this.child.send({
                kind: "sauce-response",
                requestId: m.requestId,
                result,
              });
          },
          () => {
            if (this.child.connected)
              this.child.send({
                kind: "sauce-response",
                requestId: m.requestId,
                error: true,
              });
          },
        );
        return;
      }
      if (m?.kind === "source-request") {
        void (
          transport
            ? transport(m.url)
            : Promise.reject(new Error("No source transport"))
        ).then(
          (result) => {
            if (this.child.connected)
              this.child.send({
                kind: "source-response",
                requestId: m.requestId,
                result,
              });
          },
          () => {
            if (this.child.connected)
              this.child.send({
                kind: "source-response",
                requestId: m.requestId,
                error: true,
              });
          },
        );
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
    const rejectAll = (e: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
    };
    this.child.on("error", rejectAll);
    this.child.on("exit", () => rejectAll(new Error("Worker exited")));
  }
  invoke(method: string, payload: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error("Worker request timed out"));
        },
        method === "__close" ? 40000 : ["cache.initialize", "cache.configure", "ai.configureHome"].includes(method) ? 30 * 60 * 1000 : 300000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, payload }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  async close() {
    try {
      await this.invoke("__close");
    } finally {
      if (this.child.connected) this.child.disconnect();
      if (!this.child.killed) this.child.kill();
    }
  }
}
