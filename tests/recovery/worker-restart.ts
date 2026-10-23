/** Requires the main worker to be stopped. Starts and stops only children created by this script. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  chromium,
  expect as baseExpect,
  type BrowserContext,
} from "@playwright/test";
import { service, getItem, tables, databaseConfig } from "@captiondoor/db";
import {
  assertReplayTarget,
  assertReplayWebModes,
} from "../../scripts/judge-replay";
import {
  resident,
  origin,
  consent,
  freshVisit,
  command,
  view,
} from "../e2e/helpers";
const expect = baseExpect.configure({ timeout: 20000 });
const root = fileURLToPath(new URL("../../", import.meta.url));
const health = "http://127.0.0.1:3411/health";
if (
  databaseConfig.mode !== "local" ||
  !["127.0.0.1", "localhost"].includes(new URL(origin).hostname) ||
  process.env.NODE_ENV === "production"
)
  throw new Error("Recovery harness is local-only.");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 15000,
): Promise<T> {
  const started = Date.now();
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() - started > timeout)
      throw new Error("Recovery observation timed out.");
    await wait(100);
  }
}
async function workerResponds() {
  try {
    await fetch(health, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}
let child: ChildProcess | undefined;
async function start() {
  if (await workerResponds())
    throw new Error(
      "Port3411 is occupied. Stop the main CaptionDoor worker before this harness.",
    );
  child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/worker/src/index.ts"],
    {
      cwd: root,
      env: { ...process.env, WORKER_HOST: "127.0.0.1", WORKER_PORT: "3411" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  await until(async () => {
    if (child?.exitCode !== null)
      throw new Error("Owned worker exited during startup.");
    try {
      const result = await fetch(health, { signal: AbortSignal.timeout(1000) });
      return result.ok;
    } catch {
      return false;
    }
  }, Boolean);
}
async function stop() {
  if (!child) return;
  const owned = child;
  child = undefined;
  const exited = new Promise<void>((resolve) =>
    owned.once("exit", () => resolve()),
  );
  owned.kill("SIGTERM");
  await Promise.race([
    exited,
    wait(5000).then(() => {
      if (owned.exitCode === null) owned.kill("SIGKILL");
    }),
  ]);
  await until(workerResponds, (value) => !value);
}
assertReplayTarget(origin, process.env.NODE_ENV);
// A loopback web app may use remote DynamoDB; check its mode before any login or write.
const webHealth = await fetch(`${origin}/api/health`, {
  redirect: "error",
  signal: AbortSignal.timeout(8000),
});
if (!webHealth.ok)
  throw new Error("Local recovery web health precondition failed.");
assertReplayWebModes(await webHealth.json());
if (await workerResponds())
  throw new Error(
    "Main CaptionDoor worker must be stopped before running this recovery harness.",
  );
const browser = await chromium.launch();
let context: BrowserContext | undefined;
try {
  const alex = await resident(browser, "alex");
  context = alex.context;
  await consent(alex);
  const visit = await freshVisit(alex);
  const claimed = await command(alex, visit.id, {
    type: "claim",
    expectedVersion: visit.version,
  });
  expect(claimed.ok(), await claimed.text()).toBeTruthy();
  await start();
  const page = await context.newPage();
  await page.goto(`/visits/${visit.id}`);
  await expect(
    page.getByRole("heading", { name: "You’re handling this." }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Connected" }),
  ).toBeVisible();
  const firstPid = child!.pid;
  await stop();
  await expect(
    page.getByRole("status").filter({ hasText: "Reconnecting" }),
  ).toBeVisible();
  const before = (await view(alex, visit.id)).visit;
  const handoff = await command(alex, visit.id, {
    type: "handoff",
    expectedVersion: before.version,
    targetUserId: "sam",
  });
  expect(handoff.ok(), await handoff.text()).toBeTruthy();
  const pending = (await handoff.json()).visit;
  expect(pending.handlerId).toBe("alex");
  const job = await until(
    async () => {
      const due = await service.dueJobs(100);
      return due.find(
        (j) =>
          j.type === "NOTIFY" &&
          j.visitId === visit.id &&
          j.version === pending.version,
      );
    },
    (value) => !!value,
  );
  expect(job!.status).toBe("READY");
  const restartAt = Date.now();
  await start();
  const secondPid = child!.pid;
  await expect(
    page.getByRole("status").filter({ hasText: "Connected" }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByText("Handoff requested to Sam", { exact: true }),
  ).toBeVisible();
  await until(
    () => getItem(tables.runtime, job!.PK, job!.SK),
    (value) => value?.status === "DONE",
  );
  const after = (await view(alex, visit.id)).visit;
  expect(after.handlerId).toBe("alex");
  expect(after.status).toBe("CLAIMED");
  expect(after.pendingHandoff?.targetUserId).toBe("sam");
  const evidence = {
    result: "PASS",
    visitId: visit.id,
    firstOwnedWorkerPid: firstPid,
    secondOwnedWorkerPid: secondPid,
    queuedJobId: job!.id,
    jobBeforeRestart: "READY",
    jobAfterRestart: "DONE",
    handlerBeforeAndAfter: "alex",
    socketReconnected: true,
    observedRestartRecoveryMs: Date.now() - restartAt,
    transport: "local due-work GSI poller; cloud Streams/SQS not tested",
  };
  await mkdir(`${root}output/playwright`, { recursive: true });
  await writeFile(
    `${root}output/playwright/worker-recovery-result.json`,
    JSON.stringify(evidence, null, 2),
  );
  await page.screenshot({
    path: `${root}output/playwright/worker-recovery.png`,
    fullPage: true,
  });
  console.log(JSON.stringify(evidence));
  const close = await command(alex, visit.id, {
    type: "close",
    expectedVersion: after.version,
    outcome: "NO_RESPONSE_RECORDED",
  });
  expect(close.ok(), await close.text()).toBeTruthy();
} finally {
  await stop();
  await context?.close();
  await browser.close();
}
