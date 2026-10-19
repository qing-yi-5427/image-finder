import {
  WD_AUTO_MODEL_ID,
  WD_AUTO_MODEL_VERSION,
  SEMANTIC_MODEL_VERSION,
  WD_AUTO_GENERAL,
  WD_AUTO_CHARACTER,
  scopedFileSql,
} from "./ai-effective.js";
import path from "node:path";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Catalog } from "./catalog.js";
import type {
  AiConfig,
  AiKind,
  AiStatus,
  AiCandidates,
  AiMethodMap,
} from "./ai-contracts.js";
import type { QueryRequest, QueryResult } from "../contracts.js";

export const AI_MODELS = {
  wd: {
    id: WD_AUTO_MODEL_ID,
    version: WD_AUTO_MODEL_VERSION,
    license: "Apache-2.0",
    files: ["model.onnx", "selected_tags.csv"],
  },
  semantic: {
    id: "OFA-Sys/chinese-clip-vit-base-patch16",
    version: SEMANTIC_MODEL_VERSION,
    license: "MIT",
    files: ["image.onnx", "text.onnx", "vocab.txt"],
  },
} as const;
export const aiFingerprint = (file: {
  id: string;
  bytes: number;
  mtimeMs: number;
}) =>
  createHash("sha256")
    .update(`${file.id}:${file.bytes}:${file.mtimeMs}`)
    .digest("hex");
const kinds: AiKind[] = ["wd", "semantic"];
type Inference = {
  candidates?: Array<{ tag: string; category: string; score: number }>;
  vector?: number[];
  elapsedMs: number;
  providers: string[];
};
interface Runtime {
  run(
    kind: AiKind,
    payload: { path?: string; text?: string; retainTags?: string[] },
    provider: AiConfig["provider"],
  ): Promise<Inference>;
  close(): void;
  closeForMaintenance?():Promise<void>;
}
class PythonRuntime implements Runtime {
  private workers = new Map<
    AiKind,
    {
      child: ChildProcessWithoutNullStreams;
      pending: Map<
        number,
        {
          resolve: (v: Inference) => void;
          reject: (e: Error) => void;
          timer: NodeJS.Timeout;
        }
      >;
      idle: NodeJS.Timeout | null;
    }
  >();
  private serial = 0;
  constructor(
    private home: string,
    private python: string | (()=>string),
  ) {}
  run(
    kind: AiKind,
    payload: { path?: string; text?: string; retainTags?: string[] },
    provider: AiConfig["provider"],
  ): Promise<Inference> {
    let worker = this.workers.get(kind);
    if (!worker) {
      const child = spawn(
        typeof this.python==='function'?this.python():this.python,
        [path.join(this.home, "ai-worker.py"), this.home, kind, provider],
        {
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONUTF8: "1",
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      worker = { child, pending: new Map(), idle: null };
      this.workers.set(kind, worker);
      const owned = worker;
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const response = JSON.parse(line);
          const pending = owned.pending.get(response.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          owned.pending.delete(response.id);
          response.error
            ? pending.reject(new Error(response.error))
            : pending.resolve(response.result);
          if (!owned.pending.size)
            owned.idle = setTimeout(() => {
              child.kill();
              this.workers.delete(kind);
            }, 30000);
        } catch {}
      });
      child.stderr.on("data", () => {});
      const reject = (error: Error) => {
        for (const item of owned.pending.values()) {
          clearTimeout(item.timer);
          item.reject(error);
        }
        owned.pending.clear();
        if (owned.idle) clearTimeout(owned.idle);
        if (this.workers.get(kind) === owned) this.workers.delete(kind);
      };
      child.on("error", reject);
      child.on("exit", () => reject(new Error("AI_WORKER_EXITED")));
    }
    if (worker.idle) clearTimeout(worker.idle);
    const current = worker;
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        current.child.kill();
        reject(new Error("AI_INFERENCE_TIMEOUT"));
      }, 180000);
      current.pending.set(id, { resolve, reject, timer });
      current.child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    });
  }
  close() {
    for (const worker of this.workers.values()) {
      if (worker.idle) clearTimeout(worker.idle);
      worker.child.kill();
    }
    this.workers.clear();
  }
  async closeForMaintenance(){
    const children=[...this.workers.values()].map(worker=>worker.child);
    this.close();
    await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{
      if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
      const timer=setTimeout(()=>{child.removeListener('exit',done);reject(new Error('AI_WORKER_CLOSE_TIMEOUT'));},10000);
      const done=()=>{clearTimeout(timer);resolve();};
      child.once('exit',done);
    })));
  }
}
export class LocalAi {
  readonly home: string;
  get python(){const nested=path.join(this.home,'python','cpython-3.12.13-windows-x86_64-none','python.exe');return existsSync(nested)?nested:path.join(this.home,'python','python.exe');}
  private runtime: Runtime;
  private timer: NodeJS.Timeout;
  private closing = false;
  private active = new Map<AiKind, string>();
  private activeWork = new Map<AiKind, Promise<void>>();
  private work = new Set<Promise<void>>();
  private generations = {wd:0,semantic:0};
  private maintenance=false;
  private searches=0;
  private requireAvailable(){if(this.maintenance)throw new Error('AI_ENVIRONMENT_MAINTENANCE');}
  prepareCleanup(){
    if(this.maintenance||this.installer||this.installState.running||this.work.size||this.searches||this.catalog.db.prepare("SELECT 1 FROM ai_jobs j JOIN ai_state s ON s.kind=j.kind WHERE s.paused=0 AND j.status IN ('waiting','running') LIMIT 1").get())throw new Error('AI_ENVIRONMENT_BUSY');
    this.maintenance=true;
    try{if(this.runtime.closeForMaintenance)return this.runtime.closeForMaintenance().then(()=>({ready:true})).catch(error=>{this.maintenance=false;throw error;});this.runtime.close();return {ready:true};}catch(error){this.maintenance=false;throw error;}
  }
  finishCleanup(){this.maintenance=false;return {ready:true};}
  async cancel(kind:AiKind) {
    this.generations[kind]++;
    this.pause(kind);
    const cancelled=this.catalog.db.prepare("UPDATE ai_jobs SET status='cancelled',updated_at=? WHERE kind=? AND status IN ('waiting','running')").run(Date.now(),kind).changes;
    await this.activeWork.get(kind);
    return {cancelled};
  }
  private currentRun: {
    fileId: string;
    promise: Promise<AiMethodMap["ai.runCurrent"]["result"]>;
  } | null = null;
  private installer: ReturnType<typeof spawn> | null = null;
  private installState = {
    running: false,
    stage: "尚未安装",
    error: null as string | null,
  };
  private dictionary = new Map<string, string>();
  constructor(
    readonly catalog: Catalog,
    options: { home?: string; runtime?: Runtime } = {},
  ) {
    const repository = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const adjacent = path.join(path.dirname(process.execPath), "ai-runtime");
    this.home = path.resolve(
      options.home ??
        process.env.IMAGE_FINDER_AI_HOME ??
        (repository.includes("app.asar")
          ? adjacent
          : path.join(repository, "ai-runtime")),
    );
    // Installer and worker are external resources; no model is loaded at application startup.
    const scripts =
      process.env.IMAGE_FINDER_AI_SCRIPTS ?? path.join(repository, "scripts");
    try {
      if (existsSync(scripts)) {
        mkdirSync(this.home, { recursive: true });
        for (const name of [
          "ai-worker.py",
          "ai-export.py",
          "ai-verify.py",
          "ai-translation.py",
          "ai-install.mjs",
          "ai-download.mjs",
          "ai-manifest.json",
        ])
          if (
            existsSync(path.join(scripts, name)) &&
            path.resolve(path.join(scripts, name)) !==
              path.resolve(path.join(this.home, name))
          )
            copyFileSync(path.join(scripts, name), path.join(this.home, name));
      }
    } catch {
      /* Optional model runtime must not block catalog startup. */
    }
    const bundledDictionary = path.join(
      repository,
      "resources",
      "ai",
      "wd-translations.json",
    );
    try {
      if (
        existsSync(bundledDictionary) &&
        !existsSync(path.join(this.home, "wd-translations.json"))
      )
        copyFileSync(
          bundledDictionary,
          path.join(this.home, "wd-translations.json"),
        );
    } catch {}
    this.runtime = options.runtime ?? new PythonRuntime(this.home, ()=>this.python);
    catalog.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_state(kind TEXT PRIMARY KEY,paused INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS ai_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_jobs(kind TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,file_id));
      CREATE TABLE IF NOT EXISTS ai_runs(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,kind TEXT NOT NULL,model_id TEXT NOT NULL,model_version TEXT NOT NULL,input_fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,thresholds TEXT NOT NULL,elapsed_ms REAL NOT NULL,providers TEXT NOT NULL,PRIMARY KEY(file_id,kind));
      CREATE TABLE IF NOT EXISTS ai_candidates(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,tag TEXT NOT NULL,category TEXT NOT NULL,score REAL NOT NULL,PRIMARY KEY(file_id,tag));
      CREATE TABLE IF NOT EXISTS ai_reviews(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,tag TEXT NOT NULL,action TEXT NOT NULL,tag_id TEXT REFERENCES tags(id),created_at INTEGER NOT NULL,PRIMARY KEY(file_id,tag));
      CREATE TABLE IF NOT EXISTS ai_translations(tag TEXT PRIMARY KEY,display_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_vectors(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,model_version TEXT NOT NULL,dimension INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(file_id,model_version));
      CREATE TABLE IF NOT EXISTS ai_inputs(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,kind TEXT NOT NULL,bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL,PRIMARY KEY(file_id,kind));
      CREATE INDEX IF NOT EXISTS ai_jobs_ready ON ai_jobs(kind,status,updated_at);
      UPDATE ai_jobs SET status='waiting' WHERE status='running';
      INSERT OR IGNORE INTO ai_state(kind) VALUES('wd'),('semantic');
    `);
    this.loadDictionary();
    this.timer = setInterval(() => this.schedule(), 500);
    this.timer.unref();
  }
  config(): AiConfig {
    const row = this.catalog.db
      .prepare("SELECT value FROM ai_config WHERE key='config'")
      .get() as any;
    return {
      provider: "cpu",
      generalThreshold: WD_AUTO_GENERAL,
      characterThreshold: 0.85,
      ...(row ? JSON.parse(row.value) : {}),
    };
  }
  private loadDictionary() {
    try {
      const dictionary = JSON.parse(
        readFileSync(path.join(this.home, "wd-translations.json"), "utf8"),
      );
      this.catalog.db.transaction(() => {
        for (const [key, value] of Object.entries(dictionary.tags ?? {})) {
          this.dictionary.set(key, String(value));
          this.catalog.db
            .prepare("INSERT OR IGNORE INTO ai_lexicon VALUES(?,?)")
            .run(key, String(value));
        }
      })();
    } catch {}
  }
  status(): AiStatus {
    const db = this.catalog.db;
    const total = (
      db.prepare("SELECT COUNT(*) n FROM files_visible WHERE missing=0").get() as any
    ).n;
    let stage = this.installState.stage;
    try {
      stage = JSON.parse(
        readFileSync(path.join(this.home, "install-status.json"), "utf8"),
      ).stage;
    } catch {}
    let marker: any = null;
    try {
      marker = JSON.parse(
        readFileSync(path.join(this.home, "models-ready.json"), "utf8"),
      );
    } catch {}
    return {
      home: this.home,
      python: this.python,
      config: this.config(),
      models: kinds.map((kind) => {
        const model = AI_MODELS[kind];
        const filesMissing = [
          ...model.files.map((name) => path.join("models", kind, name)),
          "ai-worker.py",
          ...(existsSync(this.python) ? [] : ["python/python.exe"]),
        ].filter((name) => !existsSync(path.join(this.home, name)));
        if (
          marker?.format !== 1 ||
          marker?.preprocess !==
            "clip-rgba-white-bicubic-square224-meanstd-v2" ||
          !model.files.every((name) => {
            try {
              const recorded = marker.files[kind][name];
              const current = statSync(
                path.join(this.home, "models", kind, name),
              );
              return (
                current.size === recorded.bytes &&
                /^[a-f0-9]{64}$/.test(recorded.sha256)
              );
            } catch {
              return false;
            }
          })
        )
          filesMissing.push("models-ready.json（需要完整性校验）");
        return {
          kind,
          id: model.id,
          version: model.version,
          license: model.license,
          ready: !filesMissing.length,
          filesMissing,
        };
      }),
      queues: kinds.map((kind) => {
        const counts = { waiting: 0, running: 0, done: 0, failed: 0, cancelled:0 };
        for (const row of db
          .prepare(
            "SELECT status,COUNT(*) n FROM ai_jobs WHERE kind=? GROUP BY status",
          )
          .all(kind) as any[])
          if (row.status in counts)
            counts[row.status as keyof typeof counts] = row.n;
        const runs = db
          .prepare(
            "SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN i.bytes=f.bytes AND i.mtime_ms=f.mtime_ms THEN 1 ELSE 0 END),0) indexed_count FROM ai_runs r JOIN files_visible f ON f.id=r.file_id LEFT JOIN ai_inputs i ON i.file_id=r.file_id AND i.kind=r.kind WHERE r.kind=? AND r.model_version=? AND f.missing=0",
          )
          .get(kind, AI_MODELS[kind].version) as any;
        const indexed = runs.indexed_count;
        return {
          kind,
          paused: !!(
            db
              .prepare("SELECT paused FROM ai_state WHERE kind=?")
              .get(kind) as any
          ).paused,
          activeFileId: this.active.get(kind) ?? null,
          counts,
          indexed,
          stale: runs.total - indexed,
          lastError:
            (
              db
                .prepare(
                  "SELECT last_error FROM ai_jobs WHERE kind=? AND status='failed' ORDER BY updated_at DESC LIMIT 1",
                )
                .get(kind) as any
            )?.last_error ?? null,
          total,
        };
      }),
      install: { ...this.installState, stage },
      maintenance:this.maintenance,
    };
  }
  configure(config: Partial<AiConfig>) {
    this.requireAvailable();
    this.runtime.close();
    this.catalog.db
      .prepare(
        "INSERT INTO ai_config VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify({ ...this.config(), ...config }));
    return this.status();
  }
  install() {
    this.requireAvailable();
    if (this.installer) return this.status();
    try {
      mkdirSync(this.home, { recursive: true });
      const probe = path.join(
        this.home,
        `.write-check-${process.pid}-${Date.now()}`,
      );
      writeFileSync(probe, "", { flag: "wx" });
      unlinkSync(probe);
    } catch {
      throw new Error("AI_HOME_NOT_WRITABLE");
    }
    const script = path.join(this.home, "ai-install.mjs");
    if (!existsSync(script)) throw new Error("AI_INSTALLER_MISSING");
    this.installState = { running: true, stage: "准备独立运行时", error: null };
    const child = spawn(process.execPath, [script, this.home], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.installer = child;
    let error = "";
    child.stderr?.on("data", (chunk) => {
      error = (error + chunk).slice(-3000);
    });
    const complete = (failure: string | null) => {
      this.installer = null;
      this.installState = {
        running: false,
        stage: failure ? "安装失败" : "安装完成",
        error: failure,
      };
      if (!failure) this.loadDictionary();
    };
    child.on("error", (e) => complete(e.message));
    child.on("exit", (code) =>
      complete(code === 0 ? null : error || `INSTALL_EXIT_${code}`),
    );
    return this.status();
  }
  enqueue(p: {
    kind: AiKind;
    fileIds?: string[];
    filter?: QueryRequest["filter"];
    scope?: "all" | "missing" | "missing_source";
  }) {
    this.requireAvailable();
    const db = this.catalog.db;
    let files = p.fileIds
      ? p.fileIds.map((id) => this.catalog.getFile(id))
      : this.catalog.queryAll({ filter: p.filter });
    let enqueued = 0;
    db.transaction(() => {
      for (const file of files) {
        if (file.missing) continue;
        if (
          p.scope === "missing_source" &&
          db
            .prepare("SELECT 1 FROM artwork_tags WHERE artwork_id=? LIMIT 1")
            .get(file.artworkId)
        )
          continue;
        const run = db
          .prepare("SELECT * FROM ai_runs WHERE file_id=? AND kind=?")
          .get(file.id, p.kind) as any;
        if (
          p.scope !== "all" &&
          run?.model_version === AI_MODELS[p.kind].version &&
          run.input_fingerprint === aiFingerprint(file)
        )
          continue;
        const previous = db
          .prepare("SELECT status FROM ai_jobs WHERE file_id=? AND kind=?")
          .get(file.id, p.kind) as any;
        if (previous?.status === "running") continue;
        db.prepare(
          "INSERT INTO ai_jobs(kind,file_id,status,updated_at) VALUES(?,?,'waiting',?) ON CONFLICT(kind,file_id) DO UPDATE SET status='waiting',last_error=NULL,updated_at=excluded.updated_at",
        ).run(p.kind, file.id, Date.now());
        enqueued++;
      }
    })();
    return { enqueued, status: this.status() };
  }
  pause(kind: AiKind) {
    this.catalog.db
      .prepare("UPDATE ai_state SET paused=1 WHERE kind=?")
      .run(kind);
    return this.status();
  }
  resume(kind: AiKind) {
    this.requireAvailable();
    const model = this.status().models.find((model) => model.kind === kind)!;
    if (!model.ready) throw new Error("AI_MODEL_MISSING");
    this.catalog.db
      .prepare("UPDATE ai_state SET paused=0 WHERE kind=?")
      .run(kind);
    this.schedule();
    return this.status();
  }
  retry(kind: AiKind, fileIds?: string[]) {
    this.requireAvailable();
    let retried = 0;
    this.catalog.db.transaction(() => {
      const rows = this.catalog.db
        .prepare("SELECT file_id FROM ai_jobs WHERE kind=? AND status='failed'")
        .all(kind) as any[];
      for (const row of rows)
        if (!fileIds || fileIds.includes(row.file_id))
          retried += this.catalog.db
            .prepare(
              "UPDATE ai_jobs SET status='waiting',last_error=NULL WHERE kind=? AND file_id=?",
            )
            .run(kind, row.file_id).changes;
    })();
    return { retried, status: this.status() };
  }
  runCurrent(fileId: string): Promise<AiMethodMap["ai.runCurrent"]["result"]> {
    this.requireAvailable();
    if (this.closing) throw new Error("SERVICE_CLOSING");
    if (this.currentRun?.fileId === fileId) return this.currentRun.promise;
    const activeFile = this.active.get("wd");
    if (activeFile && activeFile !== fileId) throw new Error("AI_WD_BUSY");
    const file = this.catalog.getFile(fileId);
    if (file.missing) throw new Error("AI_INPUT_CHANGED");
    if (!this.status().models.find((model) => model.kind === "wd")?.ready)
      throw new Error("AI_MODEL_MISSING");
    if (!activeFile)
      this.catalog.db
        .prepare(
          "INSERT INTO ai_jobs(kind,file_id,status,attempts,last_error,updated_at) VALUES('wd',?,'waiting',0,NULL,?) ON CONFLICT(kind,file_id) DO UPDATE SET status='waiting',attempts=0,last_error=NULL,updated_at=excluded.updated_at",
        )
        .run(fileId, Date.now());
    // Reserve the same model lock used by the background scheduler. This action
    // does not resume, pause, reorder or rewrite any other queued work.
    const work = this.activeWork.get("wd") ?? this.beginWork("wd", fileId);
    const promise = work
      .then(() => {
        if (this.closing) throw new Error("SERVICE_CLOSING");
        const job = this.catalog.db
          .prepare(
            "SELECT status,last_error FROM ai_jobs WHERE kind='wd' AND file_id=?",
          )
          .get(fileId) as
          | { status: string; last_error: string | null }
          | undefined;
        return {
          fileId,
          status:
            job?.status === "done" ? ("done" as const) : ("failed" as const),
          error:
            job?.status === "done"
              ? null
              : (job?.last_error ?? "AI_INPUT_CHANGED"),
          candidates: this.candidates(fileId),
        };
      })
      .finally(() => {
        if (this.currentRun?.promise === promise) this.currentRun = null;
      });
    this.currentRun = { fileId, promise };
    return promise;
  }
  private beginWork(kind: AiKind, fileId: string) {
    this.active.set(kind, fileId);
    const work = this.process(kind, fileId).finally(() => {
      this.active.delete(kind);
      this.activeWork.delete(kind);
      this.work.delete(work);
    });
    this.activeWork.set(kind, work);
    this.work.add(work);
    return work;
  }
  private schedule() {
    if (this.closing||this.maintenance) return;
    for (const kind of kinds) {
      if (this.active.has(kind)) continue;
      const state = this.catalog.db
        .prepare("SELECT paused FROM ai_state WHERE kind=?")
        .get(kind) as any;
      if (state.paused) continue;
      const row = this.catalog.db
        .prepare(
          "SELECT file_id FROM ai_jobs WHERE kind=? AND status='waiting' ORDER BY updated_at,file_id LIMIT 1",
        )
        .get(kind) as any;
      if (!row) continue;
      if (!this.status().models.find((model) => model.kind === kind)?.ready) {
        this.pause(kind);
        continue;
      }
      this.beginWork(kind, row.file_id);
    }
  }
  private async process(kind: AiKind, fileId: string) {
    const generation=this.generations[kind];
    const db = this.catalog.db;
    db.prepare(
      "UPDATE ai_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE kind=? AND file_id=?",
    ).run(Date.now(), kind, fileId);
    try {
      const file = this.catalog.getFile(fileId);
      const fingerprint = aiFingerprint(file);
      const original = await this.catalog.resolveOriginal(fileId);
      const before = await stat(original);
      if (
        file.missing ||
        before.size !== file.bytes ||
        before.mtimeMs !== file.mtimeMs
      )
        throw new Error("AI_INPUT_CHANGED");
      if (this.closing || generation!==this.generations[kind]) return;
      const config = this.config();
      const result = await this.runtime.run(
        kind,
        {
          path: original,
          retainTags: (
            db
              .prepare("SELECT tag FROM ai_reviews WHERE file_id=?")
              .all(fileId) as any[]
          ).map((row) => row.tag),
        },
        config.provider,
      );
      const current = this.catalog.getFile(fileId);
      const after = await stat(await this.catalog.resolveOriginal(fileId));
      if (
        current.missing ||
        aiFingerprint(current) !== fingerprint ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new Error("AI_INPUT_CHANGED");
      if (this.closing || generation!==this.generations[kind]) return;
      db.transaction(() => {
        if (kind === "wd") {
          db.prepare(
            "DELETE FROM ai_candidates WHERE file_id=? AND NOT EXISTS(SELECT 1 FROM ai_reviews r WHERE r.file_id=ai_candidates.file_id AND r.tag=ai_candidates.tag)",
          ).run(fileId);
          const insert = db.prepare(
            "INSERT OR REPLACE INTO ai_candidates VALUES(?,?,?,?)",
          );
          for (const candidate of result.candidates ?? [])
            insert.run(
              fileId,
              candidate.tag,
              candidate.category,
              candidate.score,
            );
        } else {
          const vector = validVector(result.vector);
          const values = new Float32Array(vector);
          db.prepare("INSERT OR REPLACE INTO ai_vectors VALUES(?,?,?,?)").run(
            fileId,
            AI_MODELS.semantic.version,
            values.length,
            Buffer.from(values.buffer),
          );
        }
        db.prepare(
          "INSERT OR REPLACE INTO ai_runs VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          fileId,
          kind,
          AI_MODELS[kind].id,
          AI_MODELS[kind].version,
          fingerprint,
          Date.now(),
          JSON.stringify({
            general: config.generalThreshold,
            character: config.characterThreshold,
          }),
          result.elapsedMs,
          JSON.stringify(result.providers),
        );
        db.prepare(
          "UPDATE ai_jobs SET status='done',last_error=NULL,updated_at=? WHERE kind=? AND file_id=?",
        ).run(Date.now(), kind, fileId);
        db.prepare("INSERT OR REPLACE INTO ai_inputs VALUES(?,?,?,?)").run(
          fileId,
          kind,
          file.bytes,
          file.mtimeMs,
        );
        if (kind === "wd") this.catalog.registerAutomaticTags(fileId);
      })();
    } catch (error) {
      if (!this.closing && generation===this.generations[kind])
        db.prepare(
          "UPDATE ai_jobs SET status='failed',last_error=?,updated_at=? WHERE kind=? AND file_id=?",
        ).run(String(error), Date.now(), kind, fileId);
    }
  }
  private displayName(tag: string) {
    const row = this.catalog.db
      .prepare("SELECT display_name FROM ai_translations WHERE tag=?")
      .get(tag) as any;
    return row?.display_name ?? this.dictionary.get(tag) ?? tag;
  }
  candidates(fileId: string): AiCandidates {
    this.catalog.getFile(fileId);
    const db = this.catalog.db;
    const run = db
      .prepare("SELECT * FROM ai_runs WHERE file_id=? AND kind='wd'")
      .get(fileId) as any;
    const thresholds = run
      ? JSON.parse(run.thresholds)
      : { general: 0.35, character: 0.85 };
    const autoPolicy = db
      .prepare(
        `SELECT s.general_threshold,s.character_threshold FROM files_visible f JOIN ai_auto_scopes s ON ${scopedFileSql()} WHERE f.id=? LIMIT 1`,
      )
      .get(fileId) as any;
    const autoIds = new Map(
      (
        db
          .prepare("SELECT tag,tag_id FROM ai_auto_effective WHERE file_id=?")
          .all(fileId) as any[]
      ).map((r) => [r.tag, r.tag_id]),
    );
    const candidates = (
      db
        .prepare(
          "SELECT c.*,r.action,r.tag_id FROM ai_candidates c LEFT JOIN ai_reviews r ON r.file_id=c.file_id AND r.tag=c.tag WHERE c.file_id=? ORDER BY c.score DESC,c.tag",
        )
        .all(fileId) as any[]
    )
      .filter(
        (row) =>
          row.action ||
          autoIds.has(row.tag) ||
          row.category === "rating" ||
          (!autoPolicy &&
            row.score >=
              (row.category === "character"
                ? thresholds.character
                : thresholds.general)),
      )
      .map((row) => ({
        tag: row.tag,
        displayName: this.displayName(row.tag),
        category: row.category,
        score: row.score,
        automatic: autoIds.has(row.tag),
        effective:
          row.action !== "exclude" &&
          (row.action === "accept" || autoIds.has(row.tag)) &&
          !db
            .prepare(
              "SELECT 1 FROM file_tag_overrides WHERE file_id=? AND tag_id=? AND action='exclude'",
            )
            .get(fileId, row.tag_id ?? autoIds.get(row.tag) ?? ""),
        review: (row.action === "accept"
          ? "accepted"
          : row.action === "exclude"
            ? "excluded"
            : "pending") as "pending" | "accepted" | "excluded",
        ...((row.tag_id ?? autoIds.get(row.tag))
          ? { tagId: row.tag_id ?? autoIds.get(row.tag) }
          : {}),
      }));
    return {
      fileId,
      job:
        (db
          .prepare(
            "SELECT status,attempts,last_error lastError FROM ai_jobs WHERE file_id=? AND kind='wd'",
          )
          .get(fileId) as AiCandidates["job"]) ?? null,
      run: run
        ? {
            modelId: run.model_id,
            modelVersion: run.model_version,
            inputFingerprint: run.input_fingerprint,
            createdAt: run.created_at,
            thresholds,
          }
        : null,
      candidates,
    };
  }
  review(p: {
    fileIds: string[];
    tag: string;
    action: "accept" | "exclude" | "restore";
  }) {
    const db = this.catalog.db;
    db.transaction(() => {
      for (const fileId of p.fileIds) {
        this.catalog.getFile(fileId);
        const candidate = db
          .prepare(
            "SELECT category FROM ai_candidates WHERE file_id=? AND tag=?",
          )
          .get(fileId, p.tag) as any;
        if (!candidate) throw new Error("AI_CANDIDATE_NOT_FOUND");
        let tagId =
          (
            db
              .prepare(
                "SELECT tag_id FROM ai_reviews WHERE file_id=? AND tag=?",
              )
              .get(fileId, p.tag) as any
          )?.tag_id ?? null;
        if (p.action === "accept" && !tagId) {
          // Resolve only the exact stable English key; never merge through a translated name.
          const existing = db
            .prepare(
              "SELECT tag_id FROM tag_aliases WHERE alias_key=normalize_text(?)",
            )
            .get(p.tag) as any;
          tagId =
            existing?.tag_id ??
            this.catalog.createTag(
              p.tag,
              candidate.category === "character" ? "character" : "content",
            );
        }
        db.prepare(
          "INSERT INTO ai_reviews VALUES(?,?,?,?,?) ON CONFLICT(file_id,tag) DO UPDATE SET action=excluded.action,tag_id=excluded.tag_id,created_at=excluded.created_at",
        ).run(fileId, p.tag, p.action, tagId, Date.now());
      }
    })();
    return { updated: p.fileIds.length };
  }
  translate(tag: string, displayName: string) {
    this.catalog.db
      .prepare(
        "INSERT INTO ai_translations VALUES(?,?) ON CONFLICT(tag) DO UPDATE SET display_name=excluded.display_name",
      )
      .run(tag, displayName);
    this.catalog.db
      .prepare(
        "INSERT INTO ai_lexicon VALUES(?,?) ON CONFLICT(tag) DO UPDATE SET display_name=excluded.display_name",
      )
      .run(tag, displayName);
  }
  async search(req: QueryRequest): Promise<QueryResult> {
    this.requireAvailable();this.searches++;
    try{return await this.searchImpl(req);}finally{this.searches--;}
  }
  private async searchImpl(req:QueryRequest):Promise<QueryResult>{
    if (!req.semantic?.query.trim()) throw new Error("AI_QUERY_EMPTY");
    if (!this.status().models.find((model) => model.kind === "semantic")?.ready)
      throw new Error("AI_MODEL_MISSING");
    const text = validVector(
      (
        await this.runtime.run(
          "semantic",
          { text: req.semantic.query },
          this.config().provider,
        )
      ).vector,
    );
    const scores = new Map<string, number>();
    for (const row of this.catalog.db
      .prepare(
        "SELECT v.*,r.input_fingerprint,f.bytes,f.mtime_ms mtimeMs,f.id FROM ai_vectors v JOIN ai_runs r ON r.file_id=v.file_id AND r.kind='semantic' AND r.model_version=v.model_version JOIN files_visible f ON f.id=v.file_id WHERE v.model_version=? AND f.missing=0",
      )
      .all(AI_MODELS.semantic.version) as any[]) {
      if (
        row.dimension !== text.length ||
        row.input_fingerprint !== aiFingerprint(row)
      )
        continue;
      const copied = Uint8Array.from(row.vector);
      const values = new Float32Array(copied.buffer);
      let score = 0;
      for (let i = 0; i < text.length; i++) score += text[i] * values[i];
      if (Number.isFinite(score)) scores.set(row.file_id, score);
    }
    const request = { ...req, semantic: undefined };
    const result = this.catalog.rankedQuery(request, scores);
    const plain = this.catalog.query({
      ...request,
      stackArtworks: false,
      offset: 0,
      limit: 1,
    });
    const matched = this.catalog.rankedQuery(
      { ...request, stackArtworks: false, offset: 0, limit: 1 },
      scores,
    ).total;
    return {
      ...result,
      semantic: {
        modelId: AI_MODELS.semantic.id,
        modelVersion: AI_MODELS.semantic.version,
        indexed: matched,
        unindexed: plain.total - matched,
      },
    };
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.runtime.close();
    const installer = this.installer;
    if (installer && installer.exitCode === null) {
      if (process.platform === "win32" && installer.pid) {
        await new Promise<void>((resolve) => {
          const killer = spawn(
            "taskkill.exe",
            ["/PID", String(installer.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.once("error", () => {
            installer.kill();
            resolve();
          });
          killer.once("exit", () => resolve());
        });
      } else installer.kill();
    }
    await Promise.allSettled([...this.work]);
  }
}
export function validVector(vector: unknown): number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== 512 ||
    !vector.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  )
    throw new Error("AI_VECTOR_DIMENSION");
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (Math.abs(norm - 1) > 0.005) throw new Error("AI_VECTOR_NOT_NORMALIZED");
  return vector;
}
