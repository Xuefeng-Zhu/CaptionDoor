import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
const action = process.argv[2];
if (!["setup", "reset"].includes(action))
  throw new Error("Use setup or reset.");
if (
  (process.env.CAPTIONDOOR_DB_MODE &&
    process.env.CAPTIONDOOR_DB_MODE !== "local") ||
  (process.env.CAPTIONDOOR_ENV && process.env.CAPTIONDOOR_ENV !== "local")
)
  throw new Error(
    "Local setup/reset refuses an AWS or nonlocal application configuration.",
  );
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/setup-local.ts",
    ...(action === "reset" ? ["--reset"] : []),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CAPTIONDOOR_DB_MODE: "local",
      CAPTIONDOOR_ENV: "local",
      DYNAMODB_ENDPOINT:
        process.env.DYNAMODB_ENDPOINT || "http://127.0.0.1:8410",
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
