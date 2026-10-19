import { spawn } from "node:child_process";
import electron from "electron";
const args = process.argv.slice(2);
const child = spawn(electron, args, {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
