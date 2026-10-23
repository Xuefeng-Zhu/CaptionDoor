import {
  assertRootSmokeEnvironment,
  rootSmokeConfig,
} from "@captiondoor/domain";
import {
  providerSmokePreflight,
  smokeOrigin,
  smokeWorkerOrigin,
  type SmokeEnvironment,
} from "./provider-smoke-config";

/** Safe to display. This describes an existing grant, not identity or provider proof. */
export const providerSessionMetadata = Object.freeze({
  stage: "captions" as const,
  scope: rootSmokeConfig.scope,
  accountId: rootSmokeConfig.accountId,
  region: rootSmokeConfig.region,
  awsProfile: "tally" as const,
  tablePrefix: rootSmokeConfig.tablePrefix,
  configTable: `${rootSmokeConfig.tablePrefix}Config`,
  visitsTable: `${rootSmokeConfig.tablePrefix}Visits`,
  runtimeTable: `${rootSmokeConfig.tablePrefix}Runtime`,
  origin: smokeOrigin,
  workerOrigin: smokeWorkerOrigin,
  databaseEndpoint: "http://127.0.0.1:8410",
  maxAttemptSeconds: rootSmokeConfig.maxAttemptSeconds,
  maxSeconds: rootSmokeConfig.maxSeconds,
  maxMicrousd: rootSmokeConfig.maxMicrousd,
});

type Failure =
  | "CLEANUP_APPROVAL_REQUIRED"
  | "PROMPT_TOKEN_REQUIRED"
  | "PROMPT_ENCRYPTION_KEY_REQUIRED"
  | "SELECTED_DEVICE_INVALID"
  | "INHERITED_SCOPE_CONFLICT"
  | "INHERITED_SECRET_CONFLICT"
  | "INHERITED_ENDPOINT_OR_CREDENTIAL_SOURCE"
  | "FIXED_SCOPE_INVALID";
export class ProviderSessionConfigError extends Error {
  constructor(readonly category: Failure) {
    // Only fixed categories are printable; never include environment or prompt values.
    super(category);
    this.name = "ProviderSessionConfigError";
  }
}
function fail(category: Failure): never {
  throw new ProviderSessionConfigError(category);
}

export type ProviderSessionSecrets = {
  token: string;
  keyBase64: string;
};
export type ProviderSessionOptions = {
  inheritedEnv: SmokeEnvironment;
  secrets: ProviderSessionSecrets;
  cleanupApproved: boolean;
  /** May be omitted while the user selects a device through the authenticated local UI. */
  deviceId?: string;
};

const fixedEnvironment = Object.freeze({
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  CAPTIONDOOR_ENV: "local",
  CAPTIONDOOR_DB_MODE: "local",
  AUTH_MODE: "demo",
  RING_MODE: "playground",
  TRANSCRIBE_MODE: "aws",
  CAPTIONDOOR_PROVIDER_SMOKE: "1",
  CAPTIONDOOR_SMOKE_APPROVAL: providerSessionMetadata.stage,
  CAPTIONDOOR_ROOT_SMOKE: "1",
  CAPTIONDOOR_ROOT_SMOKE_APPROVAL: providerSessionMetadata.scope,
  APP_ORIGIN: providerSessionMetadata.origin,
  WS_PUBLIC_URL: "ws://127.0.0.1:3411/ws",
  WORKER_HOST: "127.0.0.1",
  WORKER_PORT: "3411",
  DYNAMODB_ENDPOINT: providerSessionMetadata.databaseEndpoint,
  CAPTIONDOOR_CONFIG_TABLE: providerSessionMetadata.configTable,
  CAPTIONDOOR_VISITS_TABLE: providerSessionMetadata.visitsTable,
  CAPTIONDOOR_RUNTIME_TABLE: providerSessionMetadata.runtimeTable,
  AWS_ACCOUNT_ID: providerSessionMetadata.accountId,
  AWS_REGION: providerSessionMetadata.region,
  AWS_DEFAULT_REGION: providerSessionMetadata.region,
  AWS_PROFILE: providerSessionMetadata.awsProfile,
  AWS_DEFAULT_PROFILE: providerSessionMetadata.awsProfile,
  AWS_EC2_METADATA_DISABLED: "true",
  TRANSCRIBE_AWS_ACCOUNT_ID: providerSessionMetadata.accountId,
  TRANSCRIBE_AWS_REGION: providerSessionMetadata.region,
  CREDENTIAL_ENCRYPTION_MODE: "development",
});

export type ProviderSessionBaseOptions = Pick<
  ProviderSessionOptions,
  "inheritedEnv" | "cleanupApproved"
>;

/** Preparation environment only: no token, encryption key or credential generation. */
export function buildProviderSessionBaseEnvironment({
  inheritedEnv,
  cleanupApproved,
}: ProviderSessionBaseOptions): NodeJS.ProcessEnv {
  if (cleanupApproved !== true) fail("CLEANUP_APPROVAL_REQUIRED");
  for (const [name, expected] of Object.entries(fixedEnvironment))
    if (inheritedEnv[name] && inheritedEnv[name] !== expected)
      fail("INHERITED_SCOPE_CONFLICT");
  if (inheritedEnv.CAPTIONDOOR_SMOKE_DEVICE_ID)
    fail("INHERITED_SCOPE_CONFLICT");
  if (inheritedEnv.RING_PLAYGROUND_TOKEN || inheritedEnv.DEV_CREDENTIAL_KEY)
    fail("INHERITED_SECRET_CONFLICT");
  if (
    Object.keys(inheritedEnv).some(
      (name) =>
        !!inheritedEnv[name] &&
        (name === "AWS_ENDPOINT_URL" ||
          name.startsWith("AWS_ENDPOINT_URL_") ||
          [
            "AWS_CONFIG_FILE",
            "AWS_SHARED_CREDENTIALS_FILE",
            "AWS_LOGIN_CACHE_DIRECTORY",
            "CAPTIONDOOR_AWS_TABLE_PREFIX",
            "SQS_QUEUE_URL",
          ].includes(name)),
    )
  )
    fail("INHERITED_ENDPOINT_OR_CREDENTIAL_SOURCE");

  // Start clean: do not forward AWS keys, OAuth secrets, debug flags, NODE_OPTIONS,
  // browser overrides, proxy configuration or private content from the caller.
  const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const name of [
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
    if (inheritedEnv[name]) env[name] = inheritedEnv[name];
  Object.assign(env, fixedEnvironment);
  try {
    assertRootSmokeEnvironment(env);
    const allowed = new Set([
      "SELECTED_PLAYGROUND_DEVICE_REQUIRED",
      "APPROVED_PLAYGROUND_TOKEN_REQUIRED",
      "APPROVED_LOCAL_CREDENTIAL_ENCRYPTION_REQUIRED",
    ]);
    if (
      providerSmokePreflight(env, "captions").blockers.some(
        (category) => !allowed.has(category),
      )
    )
      fail("FIXED_SCOPE_INVALID");
  } catch {
    fail("FIXED_SCOPE_INVALID");
  }
  return env;
}

/** Pure process configuration only: no generation, files, credential resolution or network.
 * The returned environment contains secrets: give it only to the backend/coordinator.
 * Browser children must use providerSmokeChildEnvironment, never this object directly.
 */
export function buildProviderSessionEnvironment({
  inheritedEnv,
  secrets,
  cleanupApproved,
  deviceId,
}: ProviderSessionOptions): NodeJS.ProcessEnv {
  if (cleanupApproved !== true) fail("CLEANUP_APPROVAL_REQUIRED");
  const token = secrets.token;
  const key = secrets.keyBase64;
  if (!token || /[\s\x00-\x1f\x7f]/.test(token)) fail("PROMPT_TOKEN_REQUIRED");
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    Buffer.from(key, "base64").length !== 32 ||
    Buffer.from(key, "base64").toString("base64") !== key
  )
    fail("PROMPT_ENCRYPTION_KEY_REQUIRED");
  if (
    deviceId !== undefined &&
    (!deviceId.trim() ||
      deviceId !== deviceId.trim() ||
      deviceId.length > 256 ||
      /[\x00-\x1f\x7f]/.test(deviceId))
  )
    fail("SELECTED_DEVICE_INVALID");
  if (
    inheritedEnv.CAPTIONDOOR_SMOKE_DEVICE_ID &&
    inheritedEnv.CAPTIONDOOR_SMOKE_DEVICE_ID !== deviceId
  )
    fail("INHERITED_SCOPE_CONFLICT");
  for (const [name, expected] of [
    ["RING_PLAYGROUND_TOKEN", token],
    ["DEV_CREDENTIAL_KEY", key],
  ])
    if (inheritedEnv[name] && inheritedEnv[name] !== expected)
      fail("INHERITED_SECRET_CONFLICT");

  const env = buildProviderSessionBaseEnvironment({
    inheritedEnv: {
      ...inheritedEnv,
      RING_PLAYGROUND_TOKEN: undefined,
      DEV_CREDENTIAL_KEY: undefined,
      CAPTIONDOOR_SMOKE_DEVICE_ID: undefined,
    },
    cleanupApproved,
  });
  Object.assign(env, {
    RING_PLAYGROUND_TOKEN: token,
    DEV_CREDENTIAL_KEY: key,
    ...(deviceId ? { CAPTIONDOOR_SMOKE_DEVICE_ID: deviceId } : {}),
  });
  if (
    providerSmokePreflight(env, "captions").blockers.some(
      (category) => category !== "SELECTED_PLAYGROUND_DEVICE_REQUIRED",
    )
  )
    fail("FIXED_SCOPE_INVALID");
  return env;
}
