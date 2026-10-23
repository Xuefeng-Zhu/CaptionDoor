import { AppError } from "./index";
import {
  assertProviderSmokeEnvironment,
  type ProviderSmokeEnvironment,
} from "./provider-smoke";

export type RootSmokeConfig = {
  scope: "captiondoor-root-verification-20261022";
  tablePrefix: "CaptionDoorProviderSmoke20261022";
  accountId: "256604024085";
  region: "us-east-1";
  maxAttemptSeconds: 30;
  maxSeconds: 90;
  maxMicrousd: 10000000;
  microusdPerSecond: 400;
};
export const rootSmokeConfig: Readonly<RootSmokeConfig> = Object.freeze({
  scope: "captiondoor-root-verification-20261022",
  tablePrefix: "CaptionDoorProviderSmoke20261022",
  accountId: "256604024085",
  region: "us-east-1",
  maxAttemptSeconds: 30,
  maxSeconds: 90,
  maxMicrousd: 10000000,
  microusdPerSecond: 400,
});
/** Explicit one-off policy only; this does not verify identity or reserve a paid attempt. */
export function assertRootSmokeEnvironment(
  env: ProviderSmokeEnvironment,
): RootSmokeConfig {
  const base = assertProviderSmokeEnvironment(env);
  let localEndpoint = false;
  try {
    const url = new URL(env.DYNAMODB_ENDPOINT || "");
    localEndpoint =
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port === "8410" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password;
  } catch {}
  if (
    env.CAPTIONDOOR_ROOT_SMOKE !== "1" ||
    env.CAPTIONDOOR_ROOT_SMOKE_APPROVAL !== rootSmokeConfig.scope ||
    env.CAPTIONDOOR_SMOKE_APPROVAL !== "captions" ||
    env.TRANSCRIBE_MODE !== "aws" ||
    env.TRANSCRIBE_AWS_ACCOUNT_ID !== rootSmokeConfig.accountId ||
    env.TRANSCRIBE_AWS_REGION !== rootSmokeConfig.region ||
    base.tablePrefix !== rootSmokeConfig.tablePrefix ||
    !localEndpoint
  )
    throw new AppError(
      "ROOT_SMOKE_DISABLED",
      403,
      "The one-off root transcription test requires its exact approved local scope.",
    );
  return { ...rootSmokeConfig };
}
