import { AppError } from "./index";
import type { ProviderSmokeEnvironment } from "./provider-smoke";

export const remoteProviderSmokeConfig = Object.freeze({
  scope: "captiondoor-remote-provider-verification-20261023",
  tablePrefix: "CaptionDoorDevProviderSmoke20261023",
  accountId: "256604024085",
  region: "us-east-1",
  maxAttemptSeconds: 30,
  maxSeconds: 90,
  maxMicrousd: 10000000,
  microusdPerSecond: 400,
} as const);

export type RemoteProviderSmokeConfig = typeof remoteProviderSmokeConfig & {
  previousSeconds: number;
  previousMicrousd: number;
  baselineSha256: string;
  allowRoot: boolean;
};

/** Validation only. Identity, cloud-data consent and budget evidence need separate verification. */
export function assertRemoteProviderSmokeEnvironment(
  env: ProviderSmokeEnvironment,
): RemoteProviderSmokeConfig {
  const config = remoteProviderSmokeConfig;
  const previousSecondsText = env.CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS;
  const previousMicrousdText =
    env.CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD;
  const previousSeconds = Number(previousSecondsText);
  const previousMicrousd = Number(previousMicrousdText);
  const baselineSha256 = env.CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256 || "";
  const rootApproval = env.CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL;
  const inheritedConflict = Object.entries(env).some(
    ([key, value]) =>
      value !== undefined &&
      (key.startsWith("CAPTIONDOOR_ROOT_SMOKE") ||
        key === "DYNAMODB_ENDPOINT" ||
        key === "AWS_ENDPOINT_URL" ||
        key.startsWith("AWS_ENDPOINT_URL_") ||
        key.startsWith("TRANSCRIBE_ENDPOINT") ||
        key.startsWith("TRANSCRIBE_STREAMING_ENDPOINT")),
  );
  if (
    inheritedConflict ||
    (rootApproval !== undefined && rootApproval !== config.scope) ||
    env.NODE_ENV === "production" ||
    env.CAPTIONDOOR_ENV !== "remote-provider" ||
    env.CAPTIONDOOR_DB_MODE !== "aws" ||
    env.AUTH_MODE !== "demo" ||
    env.RING_MODE !== "playground" ||
    env.TRANSCRIBE_MODE !== "aws" ||
    env.APP_ORIGIN !== "http://127.0.0.1:3410" ||
    env.CAPTIONDOOR_PROVIDER_SMOKE !== "1" ||
    env.CAPTIONDOOR_REMOTE_PROVIDER_SMOKE !== "1" ||
    env.CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL !== config.scope ||
    env.CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL !== config.scope ||
    env.CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL !== config.scope ||
    env.CAPTIONDOOR_SMOKE_APPROVAL !== "captions" ||
    env.CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL !== config.scope ||
    !/^(0|30|60|90)$/.test(previousSecondsText || "") ||
    !/^(0|[1-9]\d*)$/.test(previousMicrousdText || "") ||
    previousMicrousd !== previousSeconds * config.microusdPerSecond ||
    !/^[a-f0-9]{64}$/.test(baselineSha256) ||
    env.AWS_ACCOUNT_ID !== config.accountId ||
    env.AWS_REGION !== config.region ||
    env.TRANSCRIBE_AWS_ACCOUNT_ID !== config.accountId ||
    env.TRANSCRIBE_AWS_REGION !== config.region ||
    env.CAPTIONDOOR_AWS_TABLE_PREFIX !== config.tablePrefix ||
    env.CAPTIONDOOR_CONFIG_TABLE !== `${config.tablePrefix}Config` ||
    env.CAPTIONDOOR_VISITS_TABLE !== `${config.tablePrefix}Visits` ||
    env.CAPTIONDOOR_RUNTIME_TABLE !== `${config.tablePrefix}Runtime` ||
    env.AWS_ACCESS_KEY_ID === "captiondoorlocal" ||
    env.AWS_SECRET_ACCESS_KEY === "captiondoor-local" ||
    Boolean(env.SQS_QUEUE_URL)
  )
    throw new AppError(
      "REMOTE_PROVIDER_SMOKE_DISABLED",
      403,
      "The remote Playground test requires its exact isolated scope and reviewed prior budget receipt.",
    );
  return {
    ...config,
    previousSeconds,
    previousMicrousd,
    baselineSha256,
    allowRoot: rootApproval === config.scope,
  };
}
