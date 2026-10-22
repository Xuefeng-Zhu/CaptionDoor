import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
Object.assign(process.env, {
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
});
const bin = process.platform === "win32" ? "corepack.cmd" : "corepack";
const children = [
  spawn(bin, ["pnpm", "--filter", "@captiondoor/web", "dev"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(bin, ["pnpm", "worker"], { stdio: "inherit", env: process.env }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop());
for (const c of children) c.on("exit", (code) => stop(code || 0));
