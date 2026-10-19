import { spawn } from "node:child_process";
import path from "node:path";
import type { FileActionResult } from "../api.js";
import { userError } from "../user-errors.js";

/** FileDrop is the Windows Explorer file clipboard format, including Unicode paths. */
export async function copyWindowsFiles(paths: string[]): Promise<void> {
  if (process.platform !== "win32")
    throw new Error("复制文件当前仅支持 Windows。");
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$inputJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$filePaths=ConvertFrom-Json -InputObject $inputJson
$list=New-Object System.Collections.Specialized.StringCollection
foreach($filePath in $filePaths){[void]$list.Add([string]$filePath)}
[System.Windows.Forms.Clipboard]::SetFileDropList($list)
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    let failed = false;
    const timeout = setTimeout(() => {
      failed = true;
      child.kill();
      reject(new Error("文件剪贴板操作超时，请重试。"));
    }, 15000);
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("无法写入文件剪贴板，请检查 Windows PowerShell。"));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (!failed)
        code === 0
          ? resolve()
          : reject(
              new Error("文件剪贴板暂不可用，可能被其他程序占用，请重试。"),
            );
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(
      Buffer.from(JSON.stringify(paths), "utf8").toString("base64"),
    );
  });
}

interface Dependencies {
  invoke: (method: string, payload: unknown) => Promise<any>;
  copyFiles: (paths: string[]) => Promise<void>;
  copyText: (text: string) => void;
  openPath: (path: string) => Promise<string>;
  reveal: (path: string) => void;
  trash: (path: string) => Promise<void>;
  confirmTrash: (count: number, failed: number) => Promise<boolean>;
}

/** Native operations receive IDs only and resolve/recheck the indexed fingerprint. */
export class FileActions {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private deps: Dependencies) {}
  run(
    method: string,
    payload: {
      fileIds?: string[];
      fileId?: string;
      format?: "files" | "paths";
    },
  ) {
    const operation = this.tail.then(() => this.execute(method, payload));
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  private async resolve(fileId: string): Promise<string> {
    return (
      await this.deps.invoke("images.resolve", { fileId, variant: "original" })
    ).path;
  }
  private async execute(
    method: string,
    payload: {
      fileIds?: string[];
      fileId?: string;
      format?: "files" | "paths";
    },
  ): Promise<FileActionResult | void> {
    if (method === "files.open" || method === "files.reveal") {
      const original = await this.resolve(payload.fileId!);
      if (method === "files.reveal") this.deps.reveal(original);
      else {
        const error = await this.deps.openPath(original);
        if (error)
          throw new Error(
            "默认程序无法打开这张图片，请检查文件关联或文件占用。",
          );
      }
      return;
    }
    const ids = [...new Set(payload.fileIds)];
    const result: FileActionResult = {
      successIds: [],
      failures: [],
      canceled: false,
    };
    const resolved: Array<{ id: string; path: string }> = [];
    for (const id of ids) {
      try {
        resolved.push({ id, path: await this.resolve(id) });
      } catch (e) {
        result.failures.push({ fileId: id, message: userError(e) });
      }
    }
    if (!resolved.length) return result;
    if (method === "files.copy") {
      try {
        if (payload.format === "paths")
          this.deps.copyText(resolved.map((x) => x.path).join("\r\n"));
        else await this.deps.copyFiles(resolved.map((x) => x.path));
        result.successIds = resolved.map((x) => x.id);
      } catch (e) {
        result.failures.push(
          ...resolved.map((x) => ({ fileId: x.id, message: userError(e) })),
        );
      }
      return result;
    }
    if (method !== "files.trash") throw new Error("Unknown file operation");
    if (
      !(await this.deps.confirmTrash(resolved.length, result.failures.length))
    ) {
      result.canceled = true;
      return result;
    }
    for (const item of resolved) {
      try {
        // Recheck after the confirmation dialog; the path may have changed while open.
        const original = await this.resolve(item.id);
        if (original !== item.path)
          throw new Error("原文件位置已变化，请刷新后重试。");
        await this.deps.trash(original);
        result.successIds.push(item.id);
        try {
          await this.deps.invoke("files.trashCommitted", {
            fileIds: [item.id],
          });
        } catch {
          result.failures.push({
            fileId: item.id,
            message:
              "原文件已移到回收站，索引待刷新。请重新扫描原目录确认；不要重复删除。",
          });
        }
      } catch (e) {
        result.failures.push({ fileId: item.id, message: userError(e) });
      }
    }
    return result;
  }
}
