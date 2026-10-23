import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import {
  hiddenTerminalInput,
  HiddenTerminalInputError,
} from "./hidden-terminal-input";
import {
  buildProviderSessionBaseEnvironment,
  buildProviderSessionEnvironment,
  providerSessionMetadata,
  ProviderSessionConfigError,
} from "./provider-session-config";
import {
  assertProviderSmokeHealth,
  providerSmokeChildEnvironment,
  providerSmokePreflight,
} from "./provider-smoke-config";
import {
  runProviderSessionFlow,
  type SessionScope,
} from "./provider-session-flow";
import {
  readProviderMediaCheckpoint,
  resolveCheckpointMediaScope,
} from "../packages/integrations/src/provider-media-checkpoint";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
class SessionError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}
export function parseProviderSessionArgs(args: string[]) {
  if (!args.length || (args.length === 1 && args[0] === "--help"))
    return { start: false };
  if (
    args.length === 2 &&
    new Set(args).size === 2 &&
    args.includes("--start") &&
    args.includes("--approved-cleanup")
  )
    return { start: true };
  throw new SessionError("INVALID_SESSION_ARGUMENTS");
}
export function selectSessionDevice(
  devices: { id: string }[],
  value: string,
): string {
  if (!/^[1-9][0-9]{0,2}$/.test(value))
    throw new SessionError("DEVICE_SELECTION_REQUIRED");
  const selected = devices[Number(value) - 1];
  if (
    !selected ||
    typeof selected.id !== "string" ||
    !selected.id ||
    selected.id.length > 256 ||
    /[\x00-\x1f\x7f]/.test(selected.id)
  )
    throw new SessionError("DEVICE_SELECTION_REQUIRED");
  return selected.id;
}
async function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let resolved = false;
    const finish = (value: boolean) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        done(value);
      }
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
const commandChildren = new Set<ChildProcess>();
export async function terminateOwned(
  child: Pick<ChildProcess, "pid">,
  io: {
    kill(pid: number, signal: NodeJS.Signals | 0): boolean;
    now(): number;
    wait(ms: number): Promise<void>;
  } = {
    kill: (pid: number, signal: NodeJS.Signals | 0) =>
      process.kill(pid, signal),
    now: () => Date.now(),
    wait,
  },
): Promise<void> {
  if (!child.pid) return;
  const group = -child.pid;
  const exists = () => {
    try {
      io.kill(group, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw new SessionError("OWNED_PROCESS_STOP_PENDING");
    }
  };
  if (!exists()) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      io.kill(group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new SessionError("OWNED_PROCESS_STOP_PENDING");
    }
    const deadline = io.now() + 3000;
    while (io.now() < deadline) {
      if (!exists()) return;
      await io.wait(50);
    }
  }
  if (exists()) throw new SessionError("OWNED_PROCESS_STOP_PENDING");
}
export async function runOwnedSessionCommand(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60000,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string }> {
  return new Promise((done, reject) => {
    if (signal?.aborted) {
      done({ code: 2, stdout: "" });
      return;
    }
    let stdout = "",
      settled = false,
      stopRequested = false;
    let stopping: Promise<void> | undefined;
    const child = spawn(file, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    commandChildren.add(child);
    const clear = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortCommand);
    };
    const finishAfterGroupExit = (code: number) => {
      if (settled) return;
      if (!stopping)
        stopping = terminateOwned(child)
          .then(() => {
            if (settled) return;
            settled = true;
            clear();
            commandChildren.delete(child);
            done({ code: stopRequested ? 2 : code, stdout });
          })
          .catch(() => {
            if (settled) return;
            settled = true;
            clear();
            // Keep the exact child registered for stopOwned retries. Parent exit alone
            // does not establish that a descendant process or its group has stopped.
            reject(new SessionError("OWNED_COMMAND_STOP_UNCONFIRMED"));
          });
    };
    const abortCommand = () => {
      stopRequested = true;
      finishAfterGroupExit(2);
    };
    const timer = setTimeout(abortCommand, timeoutMs);
    signal?.addEventListener("abort", abortCommand, { once: true });
    child.stdout?.on("data", (data) => {
      if (stdout.length < 100000) stdout += data.toString();
    });
    child.once("error", () => finishAfterGroupExit(2));
    child.once("exit", (code) => finishAfterGroupExit(code ?? 2));
  });
}
const command = runOwnedSessionCommand;

function safeFailure(error: unknown): string {
  if (
    error instanceof SessionError ||
    error instanceof ProviderSessionConfigError
  )
    return error.category;
  if (error instanceof HiddenTerminalInputError)
    return `HIDDEN_INPUT_${error.code}`;
  return "SESSION_BLOCKED_CHECK_SAFE_PREREQUISITES";
}
function lastJson(stdout: string): Record<string, any> {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new SessionError("SANITIZED_CHILD_RESULT_UNAVAILABLE");
}
async function localJson(path: string, options: RequestInit = {}) {
  try {
    const response = await fetch(`${providerSessionMetadata.origin}${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new SessionError("LOCAL_OR_PROVIDER_REQUEST_REJECTED");
    return {
      body: await response.json(),
      cookies: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    };
  } catch {
    throw new SessionError("LOCAL_OR_PROVIDER_REQUEST_REJECTED");
  }
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseProviderSessionArgs(args);
  if (!options.start) {
    console.log(
      "Usage: corepack pnpm provider:session --start --approved-cleanup\nUser-terminal only. Prompts for an EXISTING approved Playground token without echo. Creates one temporary key, uses only fixed isolated Local tables, asks which discovered device and explicit START, then runs one <=30s attempt. No token generation, OAuth, IAM or cloud deployment. Never paste a token into chat. --help makes no requests and creates no key.",
    );
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new SessionError("INTERACTIVE_USER_TERMINAL_REQUIRED");
  const inheritedEnv = { ...process.env };
  const base = buildProviderSessionBaseEnvironment({
    inheritedEnv,
    cleanupApproved: true,
  });
  return runProviderSessionCoordinator(base, inheritedEnv);
}

export type OwnedSessionCommand = (
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string }>;
export type ProviderSessionCoordinatorStrategy = {
  scope: string;
  tablePrefix: string;
  storageHelper: string;
  prepare(run: OwnedSessionCommand): Promise<void>;
  buildEnvironment(secrets: {
    token: string;
    keyBase64: string;
  }): NodeJS.ProcessEnv;
};

/** Shared hidden intake/owned-process/cleanup lifecycle; storage strategy is explicit. */
export async function runProviderSessionCoordinator(
  base: NodeJS.ProcessEnv,
  inheritedEnv: NodeJS.ProcessEnv,
  strategy?: ProviderSessionCoordinatorStrategy,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new SessionError("INTERACTIVE_USER_TERMINAL_REQUIRED");
  if (
    !strategy &&
    existsSync(resolve(root, "output/provider-smoke/local-scope-retired.json"))
  )
    throw new SessionError("LOCAL_SCOPE_RETIRED_USE_APPROVED_REMOTE_BUDGET");
  const runId = randomUUID(),
    evidence = resolve(root, "output/provider-smoke", runId);
  await mkdir(resolve(root, "output/provider-smoke"), { recursive: true });
  const lockPath = resolve(root, "output/provider-smoke/intake.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new SessionError(
      "INTAKE_LOCK_EXISTS_OR_UNAVAILABLE_REVIEW_BEFORE_RETRY",
    );
  }
  await lock.writeFile(
    JSON.stringify({
      runId,
      pid: process.pid,
      scope: strategy?.scope ?? providerSessionMetadata.scope,
    }),
  );
  let backendEnv: NodeJS.ProcessEnv | undefined,
    dbStarted = false,
    web: ChildProcess | undefined,
    worker: ChildProcess | undefined;
  let scope: SessionScope = { householdId: "h1", mediaAttempted: false };
  const abort = new AbortController();
  let cancelRequested = false;
  const status = (category: string) => process.stdout.write(`${category}\n`);
  const cancel = () => {
    cancelRequested = true;
    abort.abort();
    status("CANCEL_REQUESTED_FINISHING_SCOPED_CLEANUP");
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, cancel);
  const intakeDeadline = setTimeout(cancel, 5 * 60_000);
  const owned = new Set<ChildProcess>();
  const spawnFailed = new WeakSet<ChildProcess>();
  async function stopChild(child?: ChildProcess) {
    if (!child || !owned.has(child)) return;
    await terminateOwned(child);
    owned.delete(child);
  }
  function startChild(args: string[], cwd: string) {
    const child = spawn(process.execPath, args, {
      cwd,
      env: backendEnv,
      stdio: "ignore",
      detached: true,
    });
    owned.add(child);
    child.on("error", () => {
      spawnFailed.add(child);
    });
    return child;
  }
  const helper = async (
    args: string[],
    env: NodeJS.ProcessEnv = base,
  ): Promise<Record<string, any> & { code: number }> => {
    const result = await command(
      process.execPath,
      [
        "--import",
        "tsx",
        strategy?.storageHelper ?? "scripts/provider-session-local.ts",
        ...args,
      ],
      env,
    );
    return { code: result.code, ...lastJson(result.stdout) };
  };
  let providerMediaCreationNotReached = false;
  const loadScope = async (intakeStopped = false) => {
    try {
      const value = JSON.parse(
        await readFile(resolve(evidence, "scope.json"), "utf8"),
      );
      if (
        value.householdId !== "h1" ||
        typeof value.mediaAttempted !== "boolean"
      )
        throw new Error();
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (
        (value.visitId && !uuid.test(value.visitId)) ||
        (value.mediaSessionId && !uuid.test(value.mediaSessionId)) ||
        (!value.visitId && value.mediaAttempted)
      )
        throw new Error();
      scope = value;
      providerMediaCreationNotReached = false;
      if (scope.visitId && scope.mediaAttempted) {
        const checkpoint = await readProviderMediaCheckpoint(
          runId,
          scope.visitId,
          root,
        );
        const resolved = resolveCheckpointMediaScope(
          scope,
          checkpoint,
          intakeStopped,
        );
        scope.mediaSessionId = resolved.mediaSessionId;
        providerMediaCreationNotReached =
          resolved.providerMediaCreationNotReached;
      }
    } catch {
      throw new SessionError("OWN_SCOPE_CHECKPOINT_UNAVAILABLE_KEY_RETAINED");
    }
  };
  let cookie = "",
    csrf = "";
  let attemptReportObserved = false;
  const finishOwnVisit = async () => {
    await loadScope();
    if (!scope.visitId) return;
    const headers = {
      Origin: providerSessionMetadata.origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      "Idempotency-Key": randomUUID(),
    };
    const response = await fetch(
      `${providerSessionMetadata.origin}/api/visits/${scope.visitId}`,
      { headers, redirect: "error", signal: AbortSignal.timeout(5000) },
    );
    if ([404, 410].includes(response.status)) return; // Physical verification still follows.
    if (!response.ok) throw new SessionError("OWN_VISIT_CLEANUP_PENDING");
    let visit = (await response.json()).visit;
    if (visit.id !== scope.visitId || visit.householdId !== "h1")
      throw new SessionError("OWN_VISIT_BINDING_MISMATCH");
    if (visit.mediaSessionId) {
      scope.mediaAttempted = true;
      scope.mediaSessionId = visit.mediaSessionId;
      await writeFile(resolve(evidence, "scope.json"), JSON.stringify(scope));
    }
    const change = async (type: string) =>
      (
        await localJson(`/api/visits/${scope.visitId}/commands`, {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": randomUUID() },
          body: JSON.stringify({
            type,
            expectedVersion: visit.version,
            ...(type === "close" ? { outcome: "NO_RESPONSE_RECORDED" } : {}),
          }),
        })
      ).body.visit;
    if (visit.status === "UNCLAIMED") visit = await change("claim");
    if (visit.status !== "CLOSED") {
      if (visit.handlerId !== "alex")
        throw new SessionError("OTHER_HANDLER_CLEANUP_REFUSED");
      visit = await change("close");
    }
    if (visit.status !== "CLOSED")
      throw new SessionError("OWN_VISIT_CLOSURE_PENDING");
    await change("delete");
  };
  const stopIntake = async () => {
    for (const child of [...commandChildren]) {
      await terminateOwned(child);
      commandChildren.delete(child);
    }
    await finishOwnVisit();
    await stopChild(web);
  };
  try {
    const outcome = await runProviderSessionFlow({
      status,
      storage: strategy ? "aws" : "local",
      failureCategory: safeFailure,
      prepare: async () => {
        if (
          !strategy &&
          existsSync(
            resolve(root, "output/provider-smoke/local-scope-retired.json"),
          )
        )
          throw new SessionError(
            "LOCAL_SCOPE_RETIRED_USE_APPROVED_REMOTE_BUDGET",
          );
        if ((await portOpen(3410)) || (await portOpen(3411)))
          throw new SessionError("OWNED_APP_PORTS_OCCUPIED_REFUSED");
        if (strategy) {
          await strategy.prepare((file, args, env = base, timeoutMs = 60000) =>
            command(file, args, env, timeoutMs, abort.signal),
          );
        } else {
          const inspect = await command(
            "docker",
            [
              "compose",
              "-p",
              "captiondoor_local",
              "--profile",
              "app",
              "ps",
              "--all",
              "--format",
              "json",
              "dynamodb",
            ],
            base,
            10000,
          );
          if (inspect.code)
            throw new SessionError("START_ORBSTACK_AND_RETRY_NO_DATA_RESET");
          const rows = inspect.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          const running = rows.some(
            (row) => row.Service === "dynamodb" && row.State === "running",
          );
          if ((await portOpen(8410)) && !running)
            throw new SessionError("FOREIGN_DATABASE_PORT_REFUSED");
          if (!running) {
            dbStarted = true; // Start may succeed even if its response is interrupted.
            const up = await command(
              "docker",
              [
                "compose",
                "-p",
                "captiondoor_local",
                "--profile",
                "app",
                "up",
                "-d",
                "dynamodb",
              ],
              base,
            );
            if (up.code) throw new SessionError("LOCAL_DATABASE_START_FAILED");
            dbStarted = true;
          }
          const setup = await helper(["setup"]);
          if (setup.result !== "PASS")
            throw new SessionError("LOCAL_TABLE_PREPARATION_FAILED");
        }
        await mkdir(evidence, { recursive: true });
        await writeFile(resolve(evidence, "scope.json"), JSON.stringify(scope));
        status(
          strategy
            ? "ISOLATED_AWS_TABLES_READY_NO_RING_REQUEST_YET"
            : "ISOLATED_LOCAL_TABLES_READY_NO_PROVIDER_REQUEST_YET",
        );
      },
      promptToken: () =>
        hiddenTerminalInput(
          "Paste EXISTING approved Ring Playground token (hidden; Enter to submit): ",
          { signal: abort.signal },
        ),
      generateKey: () => {
        const bytes = randomBytes(32);
        const key = bytes.toString("base64");
        bytes.fill(0);
        return key;
      },
      startBackends: async (secrets) => {
        backendEnv = strategy
          ? strategy.buildEnvironment(secrets)
          : buildProviderSessionEnvironment({
              inheritedEnv,
              cleanupApproved: true,
              secrets,
            });
        backendEnv.CAPTIONDOOR_PROVIDER_SESSION_ID = runId;
        backendEnv.CAPTIONDOOR_PROVIDER_CHECKPOINT_PROTOCOL = "v1";
        backendEnv.CAPTIONDOOR_PROVIDER_EVIDENCE_ROOT = root;
        web = startChild(
          [
            require.resolve("next/dist/bin/next"),
            "dev",
            "--webpack",
            "--hostname",
            "127.0.0.1",
            "--port",
            "3410",
          ],
          resolve(root, "apps/web"),
        );
        worker = startChild(
          ["--import", "tsx", "apps/worker/src/index.ts"],
          root,
        );
        const until = Date.now() + 90000;
        while (Date.now() < until) {
          if (cancelRequested) throw new SessionError("CANCELLED");
          if (
            [web, worker].some(
              (child) =>
                !child?.pid ||
                spawnFailed.has(child) ||
                child.exitCode !== null ||
                child.signalCode !== null,
            )
          )
            throw new SessionError("OWNED_BACKEND_START_FAILED");
          try {
            const a = (await localJson("/api/health")).body;
            const response = await fetch(
              `${providerSessionMetadata.workerOrigin}/health`,
              { redirect: "error", signal: AbortSignal.timeout(3000) },
            );
            const b = await response.json();
            assertProviderSmokeHealth(
              a,
              b,
              "captions",
              strategy?.tablePrefix ?? providerSessionMetadata.tablePrefix,
            );
            if (
              a.providerSessionId !== runId ||
              b.providerSessionId !== runId ||
              a.providerCheckpointProtocol !== "v1"
            )
              throw new SessionError("OWNED_BACKEND_IDENTITY_MISMATCH");
            if (
              [web, worker].some(
                (child) =>
                  !child?.pid ||
                  spawnFailed.has(child) ||
                  child.exitCode !== null ||
                  child.signalCode !== null,
              )
            )
              throw new SessionError("OWNED_BACKEND_START_FAILED");
            return;
          } catch {
            await wait(500);
          }
        }
        throw new SessionError("LOCAL_BACKEND_HEALTH_FAILED");
      },
      discover: async () => {
        const login = await localJson("/api/auth/demo", {
          method: "POST",
          headers: {
            Origin: providerSessionMetadata.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ identity: "alex" }),
        });
        cookie = login.cookies;
        csrf = login.body.csrf;
        const h = {
          Origin: providerSessionMetadata.origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": randomUUID(),
        };
        const boot = (await localJson("/api/me", { headers: h })).body;
        if (
          boot.household.id !== "h1" ||
          boot.user.id !== "alex" ||
          boot.visits.some((v: { status: string }) => v.status !== "CLOSED")
        )
          throw new SessionError(
            "EXISTING_ACTIVE_VISIT_OR_WRONG_TENANT_REFUSED",
          );
        await localJson("/api/settings", {
          method: "POST",
          headers: h,
          body: JSON.stringify({
            ...boot.settings,
            consent: { ring: true, transcription: true, sharing: false },
          }),
        });
        const data = (await localJson("/api/ring/devices", { headers: h }))
          .body;
        if (!Array.isArray(data.devices) || data.devices.length > 100)
          throw new SessionError("AUTHORIZED_DEVICE_LIST_INVALID");
        return data.devices.map((d: { id: string }) => ({ id: d.id }));
      },
      selectDevice: async (devices) => {
        devices.forEach((d, index) => {
          const suffix = String(d.id)
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(-4);
          status(`${index + 1}. Authorized device ending ${suffix}`);
        });
        const choice = await hiddenTerminalInput(
          "Choose device number (hidden): ",
          { maxLength: 3, signal: abort.signal },
        );
        return selectSessionDevice(devices, choice);
      },
      confirmAttempt: async () => {
        status(
          "LOCAL bell event + actual Playground incoming media + AWS Transcribe if audio exists. One <=30s attempt; cumulative limit90s/$10 including carry-forward. No Ring-speaker reply.",
        );
        const answer = await hiddenTerminalInput(
          "Type START to begin, or Enter to cancel (hidden): ",
          { maxLength: 5, signal: abort.signal },
        );
        if (answer !== "START" || cancelRequested)
          throw new SessionError("ATTEMPT_NOT_STARTED");
      },
      runAttempt: async (deviceId) => {
        clearTimeout(intakeDeadline);
        backendEnv!.CAPTIONDOOR_SMOKE_DEVICE_ID = deviceId;
        if (providerSmokePreflight(backendEnv!, "captions").result !== "READY")
          throw new SessionError("PROVIDER_PREFLIGHT_NOT_READY");
        const childEnv = providerSmokeChildEnvironment(
          backendEnv!,
          "captions",
          runId,
        );
        const result = await command(
          process.execPath,
          [
            require.resolve("@playwright/test/cli"),
            "test",
            "--config",
            "playwright.provider.config.ts",
          ],
          childEnv,
          150000,
        );
        await loadScope();
        const report = JSON.parse(
          await readFile(resolve(evidence, "result.json"), "utf8"),
        );
        attemptReportObserved = true;
        status(
          `PROVIDER_RESULT_${["PASS", "SKIP", "FAIL", "BLOCKED"].includes(report.result) ? report.result : "FAIL"}`,
        );
        if (result.code || report.result !== "PASS")
          throw new SessionError("PROVIDER_ATTEMPT_NOT_PASS");
      },
      stopIntake,
      verifyCleanup: async () => {
        if (web && owned.has(web)) await stopIntake();
        await loadScope(true);
        if (!scope.visitId && !attemptReportObserved)
          throw new SessionError("OWN_SCOPE_OUTCOME_UNCONFIRMED_KEY_RETAINED");
        const args = [
          "verify-cleanup",
          ...(scope.visitId ? ["--visit-id", scope.visitId] : []),
          ...(scope.mediaSessionId
            ? ["--media-session-id", scope.mediaSessionId]
            : []),
          ...(scope.mediaAttempted && !providerMediaCreationNotReached
            ? ["--media-attempted"]
            : []),
          "--recover-media",
        ];
        const env: NodeJS.ProcessEnv = { ...base, ...backendEnv };
        delete env.RING_PLAYGROUND_TOKEN;
        const result = await helper(args, env);
        result.providerMediaCreationNotReached =
          providerMediaCreationNotReached;
        result.scopeVerification = "BACKEND_CHECKPOINT_AFTER_OWNED_WEB_STOP";
        await writeFile(
          resolve(evidence, "cleanup-verification.json"),
          JSON.stringify(result, null, 2),
        );
        return result as any;
      },
      waitCleanupRetry: async () => {
        status(
          strategy
            ? "Cleanup not confirmed; key stays in memory. Restore approved AWS access if unavailable. Retrying in5seconds; do not close this terminal."
            : "Cleanup not confirmed; key stays in memory. Restore Local DB if unavailable. Retrying in5seconds; do not close this terminal.",
        );
        await wait(5000);
      },
      stopOwned: async () => {
        for (const child of [...commandChildren]) {
          await terminateOwned(child);
          commandChildren.delete(child);
        }
        for (const child of [...owned]) await stopChild(child);
        if (dbStarted) {
          const result = await command(
            "docker",
            [
              "compose",
              "-p",
              "captiondoor_local",
              "--profile",
              "app",
              "stop",
              "dynamodb",
            ],
            base,
          );
          if (result.code)
            throw new SessionError("OWNED_DATABASE_STOP_PENDING");
          dbStarted = false;
        }
      },
      discardSecrets: () => {
        if (backendEnv) {
          delete backendEnv.RING_PLAYGROUND_TOKEN;
          delete backendEnv.DEV_CREDENTIAL_KEY;
        }
        cookie = "";
        csrf = "";
      },
    });
    console.log(
      JSON.stringify({
        ...outcome,
        evidence,
        note: "Provider result and cleanup are separate. No raw tokens/audio/captions stored; prior fixed budget not reset.",
      }),
    );
    return outcome.result === "COMPLETED" ? 0 : 2;
  } finally {
    clearTimeout(intakeDeadline);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.removeListener(signal, cancel);
    await lock.close();
    await unlink(lockPath);
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
    .catch((error) => {
      console.error(safeFailure(error));
      process.exitCode = 2;
    });
