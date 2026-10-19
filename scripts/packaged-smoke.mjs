import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const config = JSON.parse(readFileSync("package.json", "utf8"));
const binary = resolve(config.build.directories.output, "win-unpacked/Image Finder.exe");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const profile = mkdtempSync(join(tmpdir(), "image-finder-packaged-profile-"));
const child = spawnSync(binary, ["--smoke", `--user-data-dir=${profile}`], {
  env,
  encoding: "utf8",
  windowsHide: true,
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
if (child.error) {
  console.error(child.error.message);
  process.exitCode = 1;
} else process.exitCode = child.status ?? 1;
