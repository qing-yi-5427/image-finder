import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const home = path.resolve(process.argv[2] ?? "ai-runtime");
const stage = (value) => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "install-status.json"),
    JSON.stringify({ stage: value, at: Date.now() }),
  );
  console.log(value);
};
const run = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(file)} failed (${code})`)),
    );
  });
// Node's proxy setting is read at startup; restart once with the Windows system proxy.
if (!process.env.IMAGE_FINDER_AI_INSTALL_PROXY_READY) {
  let proxy = process.env.HTTPS_PROXY;
  try {
    proxy ??= execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Net.WebRequest]::DefaultWebProxy.GetProxy('https://huggingface.co').AbsoluteUri",
      ],
      { windowsHide: true, encoding: "utf8" },
    ).trim();
  } catch {}
  const env = {
    ...process.env,
    IMAGE_FINDER_AI_INSTALL_PROXY_READY: "1",
    NODE_USE_ENV_PROXY: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
  if (proxy && proxy !== "https://huggingface.co/")
    env.HTTPS_PROXY = env.HTTP_PROXY = proxy;
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), home],
    { windowsHide: true, env, stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  await new Promise(() => {});
}
const { download } = await import("./ai-download.mjs");
let python = path.join(
  home,
  "python",
  "cpython-3.12.13-windows-x86_64-none",
  "python.exe",
);
if (!fs.existsSync(python)) python = path.join(home, "python", "python.exe");
if (!fs.existsSync(python)) {
  stage("下载独立 Python 运行时（11.1 MB）");
  const archive = path.join(home, "python-embed.zip");
  await download(
    "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip",
    archive,
    11133606,
    "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
  );
  await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${path.join(home, "python").replaceAll("'", "''")}' -Force`,
  ]);
  const pth = path.join(home, "python", "python312._pth");
  fs.writeFileSync(pth, "python312.zip\n.\nLib/site-packages\nimport site\n");
}
let dependenciesReady = false;
try {
  execFileSync(
    python,
    ["-c", "import torch,transformers,onnxruntime,onnx,PIL,numpy"],
    { windowsHide: true, stdio: "ignore" },
  );
  dependenciesReady = true;
} catch {}
if (!dependenciesReady) {
  stage("下载并安装隔离依赖（约 200 MB 下载，另需解压空间）");
  const wheel = path.join(home, "pip.whl");
  await download(
    "https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl",
    wheel,
    1778622,
    "9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd",
  );
  await run(python, [
    "-c",
    "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    wheel,
    path.join(path.dirname(python), "Lib", "site-packages"),
  ]);
  await run(python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "torch==2.9.1",
    "--index-url",
    "https://download.pytorch.org/whl/cpu",
  ]);
  await run(python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "transformers==4.57.6",
    "onnxruntime-directml==1.24.4",
    "onnx==1.20.1",
    "pillow==12.1.1",
    "numpy==2.4.2",
  ]);
}
stage("准备官方模型（约 2.04 GB 下载，可断点续传）");
await run(process.execPath, [path.join(home, "ai-download.mjs"), home]);
stage("转换并验证中文图文模型");
await run(python, [path.join(home, "ai-export.py"), home]);
await run(python, [path.join(home, "ai-verify.py"), home]);
await run(python, [path.join(home, "ai-translation.py"), home]);
stage("安装完成");
