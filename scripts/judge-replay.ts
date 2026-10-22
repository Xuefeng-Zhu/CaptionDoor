import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
export function assertReplayTarget(origin: string, nodeEnv?: string): string {
  const url = new URL(origin);
  if (
    nodeEnv === "production" ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "3410" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Judge replay only accepts the dedicated local HTTP demo on loopback port3410; production and remote targets are refused.",
    );
  }
  return url.origin;
}
export function assertReplayModes(web: unknown, worker: unknown): void {
  const a = web as Record<string, unknown> | null;
  const b = worker as Record<string, unknown> | null;
  if (
    !a ||
    a.status !== "ok" ||
    a.database !== "DynamoDB" ||
    a.authMode !== "demo" ||
    a.ringMode !== "demo" ||
    a.transcribeMode !== "fixture" ||
    !b ||
    b.status !== "ok" ||
    b.worker !== "single" ||
    b.transport !== "local-due-poller" ||
    b.transcribe !== "fixture"
  ) {
    throw new Error(
      "Judge replay requires healthy real local DynamoDB, demo authentication, LOCAL Ring simulation and FIXTURE transcription. No provider call was authorized.",
    );
  }
}
export function assertReplayIdle(visits: readonly { status: string }[]): void {
  if (visits.some((visit) => visit.status !== "CLOSED")) {
    throw new Error(
      "Judge replay refused: deliberately close the existing LOCAL demo visit in the UI first. No existing visit was changed.",
    );
  }
}
async function health(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(4000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error("Local health check rejected the replay prerequisite.");
  return response.json();
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: corepack pnpm judge:replay [--headed]\nRuns one synthetic local journey through real APIs, sockets and DynamoDB. Requires setup + healthy web3410/worker3411 + Chromium. Refuses an existing active demo visit; deliberately close it first. No real Ring/AWS evidence or external publication is implied.",
    );
    return;
  }
  if (args.some((arg) => arg !== "--headed"))
    throw new Error("Only --headed or --help is supported.");
  const origin = assertReplayTarget(
    process.env.E2E_BASE_URL || "http://127.0.0.1:3410",
    process.env.NODE_ENV,
  );
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const evidenceDir = resolve(root, "output", "judge-replay", stamp);
  await mkdir(evidenceDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    result: "BLOCKED",
    exitCode: 2,
    provenance: {
      event: "LOCAL",
      media: "LOCAL_FIXTURE",
      transcript: "FIXTURE",
      database: "DynamoDB Local",
      transport: "local due-work poller",
    },
    ringProviderObserved: false,
    awsTranscribeObserved: false,
    note: "Synthetic controlled demo. No prior real Ring validation is replayed. No external calls, upload or submission.",
    reason: "Local runtime preflight has not completed.",
  };
  try {
    const [web, worker] = await Promise.all([
      health(`${origin}/api/health`),
      health("http://127.0.0.1:3411/health"),
    ]);
    assertReplayModes(web, worker);
  } catch {
    report.reason =
      "BLOCKED: local health/mode prerequisites failed. Start only captiondoor_local web/worker with a healthy Docker runtime, then retry. See docs/judging-replay.md. No browser journey was counted as passed.";
    await writeFile(
      resolve(evidenceDir, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.error(report.reason);
    console.error(`Evidence: ${evidenceDir}/result.json`);
    process.exitCode = 2;
    return;
  }
  console.log(
    "LOCAL judge replay: synthetic event/media/transcript, real APIs/WebSockets/DynamoDB. The driver clicks explicit claim/association/Send/Got it/closure controls in separate browser contexts.",
  );
  const argv = [
    "pnpm",
    "exec",
    "playwright",
    "test",
    "tests/e2e/journey.spec.ts",
    "--workers=1",
    "--retries=0",
  ];
  if (args.includes("--headed")) argv.push("--headed");
  const status = await new Promise<number>((done) => {
    const child = spawn(
      process.platform === "win32" ? "corepack.cmd" : "corepack",
      argv,
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          E2E_BASE_URL: origin,
          CAPTIONDOOR_JUDGE_REPLAY: "1",
          CAPTIONDOOR_EVIDENCE_DIR: evidenceDir,
        },
      },
    );
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    const finish = (code: number) => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      done(code);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(interrupted ? 130 : (code ?? 1)));
  });
  report.result = status === 0 ? "PASS" : "FAIL";
  report.exitCode = status;
  report.reason =
    status === 0
      ? "The actual local browser journey completed successfully; provider evidence remains absent."
      : "The actual local browser journey failed or was interrupted; inspect the sanitized report. No pass was inferred.";
  await writeFile(
    resolve(evidenceDir, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`${report.result}: ${evidenceDir}/result.json`);
  process.exitCode = status;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Judge replay refused or could not start. No success recorded; use --help and docs/judging-replay.md.",
    );
    process.exitCode = 2;
  });
}
