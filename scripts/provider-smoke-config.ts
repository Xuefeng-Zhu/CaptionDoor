import {
  assertProviderSmokeEnvironment,
  assertRootSmokeEnvironment,
  type ConversationItem,
} from "@captiondoor/domain";
import { resolveTranscribeAwsConfig } from "@captiondoor/integrations/audio/aws-identity";

export type SmokeStage = "ring-audio" | "captions";
export type SmokeEnvironment = Record<string, string | undefined>;
export const smokeOrigin = "http://127.0.0.1:3410";
export const smokeWorkerOrigin = "http://127.0.0.1:3411";
export type SmokePreflight = {
  result: "READY" | "BLOCKED";
  stage: SmokeStage;
  blockers: string[];
  tablePrefix?: string;
  providerRequestsMade: false;
  identityVerified: false;
  rootSmokeRequested: boolean;
};

/** Configuration and presence checks only: no files, credential resolution or network. */
export function providerSmokePreflight(
  env: SmokeEnvironment,
  stage: SmokeStage,
): SmokePreflight {
  const blockers: string[] = [];
  const rootMarkersPresent =
    env.CAPTIONDOOR_ROOT_SMOKE !== undefined ||
    env.CAPTIONDOOR_ROOT_SMOKE_APPROVAL !== undefined;
  const rootSmokeRequested = env.CAPTIONDOOR_ROOT_SMOKE === "1";
  if (rootMarkersPresent) {
    try {
      if (stage !== "captions") throw new Error("Invalid root smoke stage");
      assertRootSmokeEnvironment(env);
    } catch {
      blockers.push("EXPLICIT_FIXED_SCOPE_ROOT_SMOKE_APPROVAL_REQUIRED");
    }
  }
  let tablePrefix: string | undefined;
  try {
    tablePrefix = assertProviderSmokeEnvironment(env).tablePrefix;
  } catch {
    blockers.push("ISOLATED_LOCAL_CONFIGURATION_REQUIRED");
  }
  if (env.CAPTIONDOOR_SMOKE_APPROVAL !== stage)
    blockers.push("ACTION_SPECIFIC_APPROVAL_REQUIRED");
  if (!env.CAPTIONDOOR_SMOKE_DEVICE_ID?.trim())
    blockers.push("SELECTED_PLAYGROUND_DEVICE_REQUIRED");
  if (!env.RING_PLAYGROUND_TOKEN?.trim())
    blockers.push("APPROVED_PLAYGROUND_TOKEN_REQUIRED");
  if (
    env.CREDENTIAL_ENCRYPTION_MODE !== "development" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(env.DEV_CREDENTIAL_KEY || "") ||
    Buffer.from(env.DEV_CREDENTIAL_KEY || "", "base64").length !== 32
  )
    blockers.push("APPROVED_LOCAL_CREDENTIAL_ENCRYPTION_REQUIRED");
  let localEndpoint = false;
  try {
    const url = new URL(env.DYNAMODB_ENDPOINT || "");
    localEndpoint =
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port === "8410" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash;
  } catch {
    // The public result includes only the category, never the supplied URL.
  }
  if (!localEndpoint) blockers.push("HOST_LOCAL_DATABASE_ENDPOINT_REQUIRED");
  if (env.TRANSCRIBE_MODE !== (stage === "captions" ? "aws" : "fixture"))
    blockers.push("STAGE_TRANSCRIPTION_MODE_MISMATCH");
  if (stage === "captions") {
    try {
      resolveTranscribeAwsConfig(env);
    } catch {
      blockers.push("APPROVED_TRANSCRIBE_ACCOUNT_REGION_REQUIRED");
    }
    const temporaryEnvironment = !!(
      env.AWS_ACCESS_KEY_ID &&
      env.AWS_SECRET_ACCESS_KEY &&
      env.AWS_SESSION_TOKEN
    );
    if (!env.AWS_PROFILE?.trim() && !temporaryEnvironment)
      blockers.push(
        rootSmokeRequested
          ? "EXPLICIT_ROOT_SMOKE_CREDENTIAL_SOURCE_REQUIRED"
          : "EXPLICIT_TEMPORARY_NON_ROOT_CREDENTIAL_SOURCE_REQUIRED",
      );
    if (
      (env.AWS_ACCESS_KEY_ID ||
        env.AWS_SECRET_ACCESS_KEY ||
        env.AWS_SESSION_TOKEN) &&
      !temporaryEnvironment
    )
      blockers.push("INCOMPLETE_TEMPORARY_CREDENTIAL_ENVIRONMENT");
  }
  return {
    result: blockers.length ? "BLOCKED" : "READY",
    stage,
    blockers,
    tablePrefix,
    providerRequestsMade: false,
    identityVerified: false,
    rootSmokeRequested,
  };
}

export function assertProviderSmokeHealth(
  web: unknown,
  worker: unknown,
  stage: SmokeStage,
  tablePrefix: string,
): void {
  const a = web as Record<string, unknown> | null;
  const b = worker as Record<string, unknown> | null;
  const transcription = stage === "captions" ? "aws" : "fixture";
  if (
    !a ||
    !b ||
    a.status !== "ok" ||
    a.database !== "DynamoDB" ||
    a.databaseMode !== "local" ||
    a.environment !== "local" ||
    a.authMode !== "demo" ||
    a.ringMode !== "playground" ||
    a.transcribeMode !== transcription ||
    a.providerSmoke !== true ||
    a.providerSmokeTablePrefix !== tablePrefix ||
    b.status !== "ok" ||
    b.worker !== "single" ||
    b.databaseMode !== "local" ||
    b.environment !== "local" ||
    b.transport !== "local-due-poller" ||
    b.transcribe !== transcription ||
    b.providerSmoke !== true ||
    b.providerSmokeTablePrefix !== tablePrefix
  )
    throw new Error("PROVIDER_SMOKE_HEALTH_MISMATCH");
}

/** Browser code talks only to the local app; provider secrets stay in the servers. */
export function providerSmokeChildEnvironment(
  env: SmokeEnvironment,
  stage: SmokeStage,
  runId: string,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    NODE_ENV: env.NODE_ENV === "test" ? "test" : "development",
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
  ])
    if (env[key]) child[key] = env[key];
  for (const key of [
    "CAPTIONDOOR_ENV",
    "CAPTIONDOOR_DB_MODE",
    "AUTH_MODE",
    "RING_MODE",
    "CAPTIONDOOR_PROVIDER_SMOKE",
    "APP_ORIGIN",
    "CAPTIONDOOR_CONFIG_TABLE",
    "CAPTIONDOOR_VISITS_TABLE",
    "CAPTIONDOOR_RUNTIME_TABLE",
    "TRANSCRIBE_MODE",
    "TRANSCRIBE_AWS_ACCOUNT_ID",
    "TRANSCRIBE_AWS_REGION",
    "CAPTIONDOOR_SMOKE_APPROVAL",
    "CAPTIONDOOR_SMOKE_DEVICE_ID",
    "CAPTIONDOOR_ROOT_SMOKE",
    "CAPTIONDOOR_ROOT_SMOKE_APPROVAL",
  ])
    if (env[key]) child[key] = env[key];
  if (env.CAPTIONDOOR_ROOT_SMOKE === "1") {
    assertRootSmokeEnvironment(env);
    child.DYNAMODB_ENDPOINT = env.DYNAMODB_ENDPOINT;
  }
  return {
    ...child,
    PLAYWRIGHT_NO_COPY_PROMPT: "1",
    CAPTIONDOOR_PROVIDER_SMOKE_RUN: "1",
    CAPTIONDOOR_SMOKE_STAGE: stage,
    CAPTIONDOOR_SMOKE_RUN_ID: runId,
  };
}

export function parseProviderSmokeArgs(args: string[]): {
  help: boolean;
  run: boolean;
  stage: SmokeStage;
} {
  let stage: SmokeStage = "ring-audio";
  let seenStage = false;
  let run = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" && !help) help = true;
    else if (args[i] === "--run" && !run) run = true;
    else if (args[i] === "--stage" && !seenStage) {
      const value = args[++i];
      if (value !== "ring-audio" && value !== "captions")
        throw new Error("INVALID_SMOKE_ARGUMENTS");
      stage = value;
      seenStage = true;
    } else throw new Error("INVALID_SMOKE_ARGUMENTS");
  }
  return { help, run, stage };
}

/** Keeps actual caption text in memory only; evidence contains counts, never content. */
export function summarizeProviderCaptions(
  items: ConversationItem[],
  mediaSessionId: string,
) {
  const captions = items.filter((item) => item.kind === "caption");
  const finals = captions.filter(
    (item) =>
      item.source === "AWS" &&
      item.isPartial === false &&
      item.mediaSessionId === mediaSessionId &&
      !!item.resultId &&
      item.text.trim().length > 0,
  );
  return {
    fixtureCaptions: captions.filter((item) => item.source === "FIXTURE")
      .length,
    awsFinals: finals.length,
    uniqueAwsFinals: new Set(
      finals.map((item) => `${item.mediaSessionId}:${item.resultId}`),
    ).size,
  };
}

export type RootSmokeBudgetEvidence = {
  scope: string;
  maxAttemptSeconds: number;
  maxSeconds: number;
  maxMicrousd: number;
  reservedSeconds: number;
  cumulativeEstimatedMicrousd: number;
  remainingSeconds: number;
  remainingEstimatedMicrousd: number;
  attempts: number;
};
/** Validate a durable Local reservation summary; this is never actual AWS billing. */
export function rootSmokeBudgetEvidence(
  summary: unknown,
  env: SmokeEnvironment,
  requireCapacity: boolean,
): RootSmokeBudgetEvidence {
  const config = assertRootSmokeEnvironment(env);
  const value = summary as Record<string, unknown> | null;
  if (
    !value ||
    value.scope !== config.scope ||
    value.accountId !== config.accountId ||
    value.region !== config.region ||
    value.tablePrefix !== config.tablePrefix ||
    value.maxAttemptSeconds !== config.maxAttemptSeconds ||
    value.maxSeconds !== config.maxSeconds ||
    value.maxMicrousd !== config.maxMicrousd ||
    value.microusdPerSecond !== config.microusdPerSecond ||
    value.conservativeReservation !== true
  )
    throw new Error("ROOT_SMOKE_BUDGET_INVALID");
  const reserved = value.reservedSeconds;
  const estimated = value.cumulativeEstimatedMicrousd;
  const attempts = value.attempts;
  if (
    typeof reserved !== "number" ||
    !Number.isSafeInteger(reserved) ||
    reserved < 0 ||
    reserved > config.maxSeconds ||
    reserved % config.maxAttemptSeconds !== 0 ||
    typeof attempts !== "number" ||
    attempts !== reserved / config.maxAttemptSeconds ||
    typeof estimated !== "number" ||
    !Number.isSafeInteger(estimated) ||
    estimated !== reserved * config.microusdPerSecond ||
    value.reservedMicrousd !== estimated ||
    estimated > config.maxMicrousd ||
    value.remainingSeconds !== config.maxSeconds - reserved ||
    value.remainingMicrousd !== config.maxMicrousd - estimated
  )
    throw new Error("ROOT_SMOKE_BUDGET_INVALID");
  if (
    requireCapacity &&
    (config.maxSeconds - reserved < config.maxAttemptSeconds ||
      config.maxMicrousd - estimated <
        config.maxAttemptSeconds * config.microusdPerSecond)
  )
    throw new Error("ROOT_SMOKE_BUDGET_EXHAUSTED");
  return {
    scope: config.scope,
    maxAttemptSeconds: config.maxAttemptSeconds,
    maxSeconds: config.maxSeconds,
    maxMicrousd: config.maxMicrousd,
    reservedSeconds: reserved,
    cumulativeEstimatedMicrousd: estimated,
    remainingSeconds: config.maxSeconds - reserved,
    remainingEstimatedMicrousd: config.maxMicrousd - estimated,
    attempts,
  };
}
export type RootSmokeReceiptEvidence = {
  identity: "ROOT" | "NON_ROOT";
  expiresAt: number;
  maxSeconds: number;
  cumulativeReservedSeconds: number;
  cumulativeEstimatedMicrousd: number;
};
/** Only use for an authenticated own-visit capture-ready frame from the worker. */
export function rootSmokeReceiptEvidence(
  receipt: unknown,
  before: RootSmokeBudgetEvidence,
  env: SmokeEnvironment,
  now = Date.now(),
): RootSmokeReceiptEvidence {
  const config = assertRootSmokeEnvironment(env);
  const value = receipt as Record<string, unknown> | null;
  const cumulative = before.reservedSeconds + config.maxAttemptSeconds;
  if (
    before.scope !== config.scope ||
    before.maxAttemptSeconds !== config.maxAttemptSeconds ||
    before.maxSeconds !== config.maxSeconds ||
    before.maxMicrousd !== config.maxMicrousd ||
    cumulative > config.maxSeconds
  )
    throw new Error("ROOT_SMOKE_CAPTURE_RECEIPT_INVALID");
  if (
    !value ||
    value.scope !== config.scope ||
    typeof value.attemptId !== "string" ||
    !value.attemptId ||
    value.attemptId.length > 256 ||
    value.maxSeconds !== config.maxAttemptSeconds ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + config.maxAttemptSeconds * 1000 ||
    value.cumulativeReservedSeconds !== cumulative ||
    value.cumulativeEstimatedMicrousd !==
      cumulative * config.microusdPerSecond ||
    (value.identity !== "ROOT" && value.identity !== "NON_ROOT")
  )
    throw new Error("ROOT_SMOKE_CAPTURE_RECEIPT_INVALID");
  return {
    identity: value.identity,
    expiresAt: value.expiresAt,
    maxSeconds: config.maxAttemptSeconds,
    cumulativeReservedSeconds: cumulative,
    cumulativeEstimatedMicrousd: cumulative * config.microusdPerSecond,
  };
}
