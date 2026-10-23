import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseProviderSmokeArgs,
  providerSmokeChildEnvironment,
  providerSmokePreflight,
} from "./provider-smoke-config";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
async function main(): Promise<number> {
  let options: ReturnType<typeof parseProviderSmokeArgs>;
  try {
    options = parseProviderSmokeArgs(process.argv.slice(2));
  } catch {
    console.log(
      JSON.stringify({
        result: "BLOCKED",
        blockers: ["INVALID_SMOKE_ARGUMENTS"],
      }),
    );
    return 2;
  }
  if (options.help) {
    console.log(
      "Usage: corepack pnpm smoke:provider [--stage ring-audio|captions] [--run]\nDefault: zero-network configuration preflight only. --run requires prior action-specific approval and matching CAPTIONDOOR_SMOKE_APPROVAL. Services, dedicated fictional tables and approved secrets must already be configured manually. One incoming media attempt, at most 30 seconds; no microphone or fixture substitute. ring-audio never starts AWS transcription. Root is forbidden by default; its one-off captions opt-in requires the fixed approved scope and a valid durable local reservation budget. Preflight never verifies AWS identity or billing. No screenshots, traces, video or caption text are saved. See docs/ring-smoke.md for authorization and cleanup limits.",
    );
    return 0;
  }
  const preflight = providerSmokePreflight(process.env, options.stage);
  console.log(JSON.stringify(preflight));
  if (preflight.result !== "READY") return 2;
  if (!options.run) return 0;
  const runId = randomUUID();
  const evidenceDir = resolve(root, "output", "provider-smoke", runId);
  await mkdir(evidenceDir, { recursive: true });
  const code = await new Promise<number>((done) => {
    const child = spawn(
      process.execPath,
      [
        require.resolve("@playwright/test/cli"),
        "test",
        "--config",
        "playwright.provider.config.ts",
      ],
      {
        cwd: root,
        env: providerSmokeChildEnvironment(process.env, options.stage, runId),
        // Browser transports can include cookies in diagnostics. Only our sanitized JSON is emitted.
        stdio: "ignore",
      },
    );
    child.on("error", () => done(2));
    child.on("exit", (exitCode) => done(exitCode ?? 2));
  });
  try {
    const report = JSON.parse(
      await readFile(resolve(evidenceDir, "result.json"), "utf8"),
    );
    // Do not echo arbitrary file fields if the result format changes.
    const result = ["PASS", "SKIP", "FAIL", "BLOCKED"].includes(report.result)
      ? report.result
      : "FAIL";
    console.log(
      JSON.stringify({ result, stage: options.stage, evidence: evidenceDir }),
    );
    if (result === "SKIP") return 3;
    return result === "PASS" && code === 0 ? 0 : 2;
  } catch {
    console.log(
      JSON.stringify({
        result: "BLOCKED",
        blockers: ["SANITIZED_BROWSER_RESULT_UNAVAILABLE"],
        evidence: evidenceDir,
      }),
    );
    return 2;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.log(
        JSON.stringify({
          result: "BLOCKED",
          blockers: ["SMOKE_LAUNCH_FAILED"],
        }),
      );
      process.exitCode = 2;
    });
