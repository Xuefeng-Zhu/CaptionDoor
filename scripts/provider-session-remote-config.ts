import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  assertRemoteProviderSmokeEnvironment,
  remoteProviderSmokeConfig,
  rootSmokeConfig,
} from "@captiondoor/domain";

export class RemoteSessionError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}
export type RemoteSessionArgs =
  | { start: false }
  | {
      start: true;
      profile: string;
      baselinePath: string;
      allowRoot: boolean;
    };
export function parseRemoteSessionArgs(args: string[]): RemoteSessionArgs {
  if (!args.length || (args.length === 1 && args[0] === "--help"))
    return { start: false };
  const flags = new Set([
    "--start",
    "--approved-aws-writes",
    "--approved-cloud-storage",
    "--approved-cleanup",
  ]);
  const seen = new Set<string>();
  let profile = "",
    baselinePath = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg))
      throw new RemoteSessionError("INVALID_REMOTE_SESSION_ARGUMENTS");
    seen.add(arg);
    if (flags.has(arg) || arg === "--approved-root") continue;
    if (arg === "--profile") profile = args[++i] || "";
    else if (arg === "--baseline") baselinePath = args[++i] || "";
    else throw new RemoteSessionError("INVALID_REMOTE_SESSION_ARGUMENTS");
  }
  if (
    ![...flags].every((f) => seen.has(f)) ||
    !/^[A-Za-z0-9_.-]{1,80}$/.test(profile) ||
    !isAbsolute(baselinePath)
  )
    throw new RemoteSessionError(
      "EXPLICIT_REMOTE_APPROVAL_PROFILE_BASELINE_REQUIRED",
    );
  return {
    start: true,
    profile,
    baselinePath,
    allowRoot: seen.has("--approved-root"),
  };
}

export type RemoteSessionBaseline = {
  previousSeconds: number;
  previousMicrousd: number;
  baselineSha256: string;
};
/** Parse reviewed non-secret evidence only. This never manufactures a zero baseline. */
export function parseRemoteSessionBaseline(
  bytes: string,
): RemoteSessionBaseline {
  try {
    if (Buffer.byteLength(bytes) > 8192) throw new Error();
    const value = JSON.parse(bytes);
    const allowed = [
      "version",
      "source",
      "scope",
      "tablePrefix",
      "accountId",
      "region",
      "reservedSeconds",
      "reservedMicrousd",
      "attempts",
      "verifiedAt",
      "localScopeRetired",
    ];
    if (
      !value ||
      Object.keys(value).length !== allowed.length ||
      Object.keys(value).some((k) => !allowed.includes(k)) ||
      value.version !== 1 ||
      ![
        "DYNAMODB_LOCAL_STRONG_READ",
        "OPERATOR_REVIEWED_CARRY_FORWARD",
      ].includes(value.source) ||
      value.scope !== rootSmokeConfig.scope ||
      value.tablePrefix !== rootSmokeConfig.tablePrefix ||
      value.accountId !== rootSmokeConfig.accountId ||
      value.region !== rootSmokeConfig.region ||
      ![0, 30, 60, 90].includes(value.reservedSeconds) ||
      value.reservedMicrousd !==
        value.reservedSeconds * rootSmokeConfig.microusdPerSecond ||
      value.attempts !== value.reservedSeconds / 30 ||
      value.localScopeRetired !== true ||
      typeof value.verifiedAt !== "string" ||
      !Number.isFinite(Date.parse(value.verifiedAt)) ||
      Date.parse(value.verifiedAt) > Date.now()
    )
      throw new Error();
    return {
      previousSeconds: value.reservedSeconds,
      previousMicrousd: value.reservedMicrousd,
      baselineSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    throw new RemoteSessionError("REVIEWED_CARRY_FORWARD_RECEIPT_REQUIRED");
  }
}

export function buildRemoteSessionBaseEnvironment(
  inherited: NodeJS.ProcessEnv,
  profile: string,
  baseline: RemoteSessionBaseline,
  allowRoot = false,
): NodeJS.ProcessEnv {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(profile))
    throw new RemoteSessionError("EXPLICIT_REMOTE_PROFILE_REQUIRED");
  for (const [key, value] of Object.entries(inherited)) {
    if (
      value !== undefined &&
      (/^CAPTIONDOOR_ROOT_SMOKE/.test(key) ||
        /^(AWS_ENDPOINT_URL|DYNAMODB_ENDPOINT|TRANSCRIBE_ENDPOINT)/.test(key) ||
        [
          "AWS_CONFIG_FILE",
          "AWS_SHARED_CREDENTIALS_FILE",
          "AWS_LOGIN_CACHE_DIRECTORY",
          "RING_PLAYGROUND_TOKEN",
          "DEV_CREDENTIAL_KEY",
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SESSION_TOKEN",
        ].includes(key))
    )
      throw new RemoteSessionError("INHERITED_REMOTE_SECRET_OR_SCOPE_CONFLICT");
  }
  const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SYSTEMROOT",
  ])
    if (inherited[key]) env[key] = inherited[key];
  const c = remoteProviderSmokeConfig;
  Object.assign(env, {
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    CAPTIONDOOR_ENV: "remote-provider",
    CAPTIONDOOR_DB_MODE: "aws",
    AUTH_MODE: "demo",
    RING_MODE: "playground",
    TRANSCRIBE_MODE: "aws",
    CAPTIONDOOR_PROVIDER_SMOKE: "1",
    CAPTIONDOOR_REMOTE_PROVIDER_SMOKE: "1",
    CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL: c.scope,
    CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL: c.scope,
    CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL: c.scope,
    CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL: c.scope,
    CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: String(
      baseline.previousSeconds,
    ),
    CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: String(
      baseline.previousMicrousd,
    ),
    CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: baseline.baselineSha256,
    CAPTIONDOOR_SMOKE_APPROVAL: "captions",
    AWS_ACCOUNT_ID: c.accountId,
    AWS_REGION: c.region,
    AWS_DEFAULT_REGION: c.region,
    AWS_PROFILE: profile,
    AWS_DEFAULT_PROFILE: profile,
    AWS_EC2_METADATA_DISABLED: "true",
    TRANSCRIBE_AWS_ACCOUNT_ID: c.accountId,
    TRANSCRIBE_AWS_REGION: c.region,
    CAPTIONDOOR_AWS_TABLE_PREFIX: c.tablePrefix,
    CAPTIONDOOR_CONFIG_TABLE: `${c.tablePrefix}Config`,
    CAPTIONDOOR_VISITS_TABLE: `${c.tablePrefix}Visits`,
    CAPTIONDOOR_RUNTIME_TABLE: `${c.tablePrefix}Runtime`,
    CAPTIONDOOR_JOB_POLL_INTERVAL_MS: "5000",
    APP_ORIGIN: "http://127.0.0.1:3410",
    WS_PUBLIC_URL: "ws://127.0.0.1:3411/ws",
    WORKER_HOST: "127.0.0.1",
    WORKER_PORT: "3411",
    CREDENTIAL_ENCRYPTION_MODE: "development",
  });
  if (allowRoot) env.CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL = c.scope;
  assertRemoteProviderSmokeEnvironment(env);
  return env;
}

export function buildRemoteSessionEnvironment(
  base: NodeJS.ProcessEnv,
  secrets: { token: string; keyBase64: string },
): NodeJS.ProcessEnv {
  assertRemoteProviderSmokeEnvironment(base);
  if (
    !secrets.token ||
    /[\s\x00-\x1f\x7f]/.test(secrets.token) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(secrets.keyBase64) ||
    Buffer.from(secrets.keyBase64, "base64").length !== 32
  )
    throw new RemoteSessionError("PROMPT_REMOTE_SECRETS_REQUIRED");
  return {
    ...base,
    RING_PLAYGROUND_TOKEN: secrets.token,
    DEV_CREDENTIAL_KEY: secrets.keyBase64,
  };
}
