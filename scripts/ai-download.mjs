import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const home = path.resolve(process.argv[2] || "ai-runtime");
const manifest = JSON.parse(
  fs.readFileSync(new URL("ai-manifest.json", import.meta.url), "utf8"),
);
async function hash(file) {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
const progress = (stage) => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "install-status.json"),
    JSON.stringify({ stage, at: Date.now() }),
  );
  console.log(stage);
};
export async function download(url, destination, bytes, sha256) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (
    fs.existsSync(destination) &&
    (!bytes || fs.statSync(destination).size === bytes) &&
    (!sha256 || (await hash(destination)) === sha256)
  )
    return;
  const part = destination + ".part";
  for (let attempt = 0; attempt < 5; attempt++) {
    let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (bytes && offset > bytes) {
      fs.truncateSync(part, 0);
      offset = 0;
    }
    try {
      const response = await fetch(url, {
        headers: offset ? { Range: `bytes=${offset}-` } : {},
        signal: AbortSignal.timeout(180000),
      });
      if (response.status === 416 && bytes === offset) {
      } else {
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
        const append = response.status === 206 && offset > 0;
        const output = fs.createWriteStream(part, {
          flags: append ? "a" : "w",
        });
        try {
          for await (const chunk of response.body) {
            if (!output.write(chunk))
              await new Promise((resolve) => output.once("drain", resolve));
          }
        } finally {
          await new Promise((resolve) => output.end(resolve));
        }
      }
      if (bytes && fs.statSync(part).size !== bytes)
        throw new Error("DOWNLOAD_SIZE_MISMATCH");
      if (sha256 && (await hash(part)) !== sha256) {
        fs.truncateSync(part, 0);
        throw new Error("DOWNLOAD_HASH_MISMATCH");
      }
      fs.renameSync(part, destination);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  for (const [kind, model] of Object.entries(manifest)) {
    for (const file of model.files) {
      progress(`下载 ${kind}/${file.name}`);
      const url =
        kind === "translation"
          ? `https://raw.githubusercontent.com/${model.id}/${model.revision}/${file.name}`
          : `https://huggingface.co/${model.id}/resolve/${model.revision}/${file.name}?download=true`;
      await download(
        url,
        path.join(home, "models", kind, file.name),
        file.bytes,
        file.sha256,
      );
    }
  }
  progress("模型下载并校验完成");
  const notices = [
    {
      name: "Chinese-CLIP-MIT.txt",
      url: "https://raw.githubusercontent.com/OFA-Sys/Chinese-CLIP/31863c707501bf1605d36842f43deb78793dbc5d/MIT-LICENSE.txt",
      bytes: 1264,
      sha256:
        "aaaac89467b2ed90ff9dedb180c43a9007b96cab2396ae5991568fc1940a49b6",
    },
    {
      name: "WD-Apache-2.0.txt",
      url: "https://www.apache.org/licenses/LICENSE-2.0.txt",
      bytes: 11358,
      sha256:
        "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    },
    {
      name: "WD-MODEL-CARD.md",
      url: "https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/raw/b25b82a03f7282e41aa2f257a52c7583b710bd1c/README.md",
      bytes: 1490,
    },
    {
      name: "Chinese-CLIP-MODEL-CARD.md",
      url: "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/raw/36e679e65c2a2fead755ae21162091293ad37834/README.md",
      bytes: 7700,
    },
  ];
  for (const notice of notices)
    await download(
      notice.url,
      path.join(home, "licenses", notice.name),
      notice.bytes,
      notice.sha256,
    );
  fs.copyFileSync(
    path.join(home, "models", "translation", "LICENSE"),
    path.join(home, "licenses", "Translation-MIT.txt"),
  );
  fs.copyFileSync(
    path.join(home, "models", "translation", "README.md"),
    path.join(home, "licenses", "Translation-README.md"),
  );
}
