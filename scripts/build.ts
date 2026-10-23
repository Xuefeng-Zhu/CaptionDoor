import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
// Compile production artifacts without running providers or weakening runtime mode checks.
// Build children cannot inherit a developer's AWS session or credential providers.
const buildEnv = { ...process.env };
for (const key of Object.keys(buildEnv))
  if (
    key.startsWith("AWS_") &&
    /CREDENTIAL|ACCESS_KEY|SECRET|TOKEN|PROFILE|ROLE|WEB_IDENTITY|CONTAINER/.test(
      key,
    )
  )
    delete buildEnv[key];
const child = spawn(
  process.execPath,
  [`${root}node_modules/next/dist/bin/next`, "build"],
  {
    cwd: `${root}apps/web`,
    stdio: "inherit",
    env: {
      ...buildEnv,
      AWS_CONFIG_FILE: "/dev/null",
      AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      AWS_EC2_METADATA_DISABLED: "true",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      AUTH_MODE: "oidc",
      CAPTIONDOOR_DB_MODE: "aws",
      CAPTIONDOOR_ENV: "production",
      // Synthetic metadata for compilation only; no SDK request is made during build.
      AWS_ACCOUNT_ID: "000000000000",
      AWS_REGION: "us-east-1",
      DYNAMODB_ENDPOINT: "",
      AWS_ENDPOINT_URL: "",
      AWS_ENDPOINT_URL_DYNAMODB: "",
      AWS_ENDPOINT_URL_STS: "",
      CAPTIONDOOR_AWS_TABLE_PREFIX: "CaptionDoor",
      CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorConfig",
      CAPTIONDOOR_VISITS_TABLE: "CaptionDoorVisits",
      CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorRuntime",
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
