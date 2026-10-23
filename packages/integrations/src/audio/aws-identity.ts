import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { TranscribeStreamingClient } from "@aws-sdk/client-transcribe-streaming";
import { AppError } from "@captiondoor/domain";

import {
  assertRootSmokePermit,
  recordRootSmokeIdentity,
  type RootSmokePermit,
} from "./root-smoke-permit";

type Env = Record<string, string | undefined>;
export type TranscribeAwsConfig = { accountId: string; region: string };
export type TranscribeAwsIdentity = { Account?: string; Arn?: string };

/** A Local database does not authorize use of any AWS account or its default Region. */
export function resolveTranscribeAwsConfig(env: Env): TranscribeAwsConfig {
  const accountId = env.TRANSCRIBE_AWS_ACCOUNT_ID || "";
  const region = env.TRANSCRIBE_AWS_REGION || "";
  if (
    !/^\d{12}$/.test(accountId) ||
    /^0{12}$/.test(accountId) ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)
  )
    throw new AppError(
      "TRANSCRIBE_CONFIGURATION_REQUIRED",
      503,
      "AWS transcription requires its explicitly approved account and Region.",
    );
  if (
    Object.keys(env).some(
      (key) =>
        (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_")) &&
        !!env[key],
    ) ||
    env.AWS_ACCESS_KEY_ID === "captiondoorlocal" ||
    env.AWS_SECRET_ACCESS_KEY === "captiondoor-local"
  )
    throw new AppError(
      "TRANSCRIBE_CONFIGURATION_INVALID",
      503,
      "AWS transcription rejects endpoint overrides and local dummy credentials.",
    );
  return { accountId, region };
}

/** One verified identity per short-lived streaming client; failures permit an explicit retry. */
export function createTranscribeIdentityGuard(
  config: TranscribeAwsConfig,
  load: () => Promise<TranscribeAwsIdentity>,
  rootPermit?: RootSmokePermit,
  env: Env = process.env,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending)
      pending = Promise.resolve()
        .then(load)
        .then((identity) => {
          const arn = identity.Arn?.match(
            /^arn:[a-z0-9-]+:(iam|sts)::(\d{12}):(.+)$/,
          );
          if (rootPermit) assertRootSmokePermit(rootPermit, config, env);
          const approvedRoot =
            !!rootPermit && arn?.[1] === "iam" && arn[3] === "root";
          if (
            identity.Account !== config.accountId ||
            !arn ||
            arn[2] !== config.accountId ||
            !(
              approvedRoot ||
              (arn[1] === "iam" && /^user\/.+/.test(arn[3])) ||
              (arn[1] === "sts" &&
                /^(assumed-role|federated-user)\/.+/.test(arn[3]))
            )
          )
            throw new Error("Unapproved AWS transcription identity");
          if (rootPermit)
            recordRootSmokeIdentity(
              rootPermit,
              approvedRoot ? "ROOT" : "NON_ROOT",
            );
        })
        .catch(() => {
          pending = undefined;
          throw new AppError(
            "TRANSCRIBE_AWS_IDENTITY_UNVERIFIED",
            503,
            "AWS transcription requires the approved account and a verified non-root identity.",
          );
        });
    return pending;
  };
}

/** Normal SDK credential chain only. Neither construction nor config validation makes a request. */
export function createVerifiedTranscribeClient(
  signal: AbortSignal,
  env: Env = process.env,
  rootPermit?: RootSmokePermit,
) {
  const config = resolveTranscribeAwsConfig(env);
  if (rootPermit) assertRootSmokePermit(rootPermit, config, env);
  const client = new TranscribeStreamingClient({
    region: config.region,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  });
  const identityClient = new STSClient({
    region: config.region,
    credentials: client.config.credentials,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  });
  const verify = createTranscribeIdentityGuard(
    config,
    () =>
      identityClient.send(new GetCallerIdentityCommand({}), {
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      }),
    rootPermit,
    env,
  );
  return {
    client,
    verify,
    destroy() {
      identityClient.destroy();
      client.destroy();
    },
  };
}
