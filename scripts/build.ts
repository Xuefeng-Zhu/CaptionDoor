import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
// Compile production artifacts without running providers or weakening runtime mode checks.
const child = spawn(
  process.execPath,
  [`${root}node_modules/next/dist/bin/next`, "build"],
  {
    cwd: `${root}apps/web`,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      AUTH_MODE: "oidc",
      RING_MODE: "live",
      TRANSCRIBE_MODE: "aws",
    },
  },
);
child.on("exit", (code) => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  function inspect(folder: string, browser = false) {
    if (!existsSync(folder)) return;
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const target = join(folder, item.name);
      if (
        item.name === ".env" ||
        (item.name.startsWith(".env.") && item.name !== ".env.example")
      )
        throw new Error(
          "Private environment file was included in build output.",
        );
      if (item.isDirectory()) inspect(target, browser);
      else if (
        browser &&
        item.name.endsWith(".js") &&
        /RING_CLIENT_SECRET|DEV_CREDENTIAL_KEY|DynamoDBClient/.test(
          readFileSync(target, "utf8"),
        )
      )
        throw new Error("Server-only code was included in a browser chunk.");
    }
  }
  try {
    inspect(`${root}apps/web/.next/standalone`);
    inspect(`${root}apps/web/.next/static`, true);
    console.log(
      "Build packaging checks passed: no private environment files or server SDKs in browser chunks.",
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
});
child.on("error", () => {
  process.exitCode = 1;
});
