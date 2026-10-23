import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import {
  assertRemoteProviderSmokeEnvironment,
  validateModes,
} from "@captiondoor/domain";

type Env = Record<string, string | undefined>;
export type DatabaseTables = {
  config: string;
  visits: string;
  runtime: string;
};
export type DatabaseConfig = {
  mode: "local" | "aws";
  environment: "local" | "remote-demo" | "remote-provider" | "production";
  region: string;
  tables: DatabaseTables;
  pollIntervalMs: number;
  endpoint?: string;
  accountId?: string;
};
const suffixes = {
  config: "Config",
  visits: "Visits",
  runtime: "Runtime",
} as const;

export function resolveDatabaseConfig(env: Env): DatabaseConfig {
  validateModes(env);
  const mode = env.CAPTIONDOOR_DB_MODE;
  const environment = env.CAPTIONDOOR_ENV;
  const remoteProvider =
    environment === "remote-provider" ||
    Object.entries(env).some(
      ([key, value]) =>
        key.startsWith("CAPTIONDOOR_REMOTE_PROVIDER_") && value !== undefined,
    )
      ? assertRemoteProviderSmokeEnvironment(env)
      : undefined;
  if (mode !== "local" && mode !== "aws")
    throw new Error(
      "Set CAPTIONDOOR_DB_MODE explicitly to local or aws. No database fallback is used.",
    );
  if (
    !["local", "remote-demo", "remote-provider", "production"].includes(
      environment || "",
    )
  )
    throw new Error(
      "Set CAPTIONDOOR_ENV explicitly to local, remote-demo, remote-provider or production.",
    );
  if (
    env.NODE_ENV === "production" &&
    (mode !== "aws" || environment !== "production")
  )
    throw new Error(
      "Production requires the AWS database and production environment.",
    );
  if (environment === "production" && env.NODE_ENV !== "production")
    throw new Error(
      "The production database environment requires NODE_ENV=production.",
    );
  if ((mode === "local") !== (environment === "local"))
    throw new Error(
      "Local database and local application environment must be selected together.",
    );

  const region = env.AWS_REGION || (mode === "local" ? "us-east-1" : "");
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region))
    throw new Error("An explicit valid AWS_REGION is required in AWS mode.");
  const rawPoll = env.CAPTIONDOOR_JOB_POLL_INTERVAL_MS;
  const pollIntervalMs = rawPoll
    ? Number(rawPoll)
    : mode === "aws"
      ? 5000
      : 500;
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < (mode === "aws" ? 1000 : 100) ||
    pollIntervalMs > 60000
  )
    throw new Error(
      "Job polling must be 1000–60000ms in AWS mode or 100–60000ms locally.",
    );

  const tables: DatabaseTables = {
    config:
      env.CAPTIONDOOR_CONFIG_TABLE ||
      (mode === "local" ? "CaptionDoorConfig" : ""),
    visits:
      env.CAPTIONDOOR_VISITS_TABLE ||
      (mode === "local" ? "CaptionDoorVisits" : ""),
    runtime:
      env.CAPTIONDOOR_RUNTIME_TABLE ||
      (mode === "local" ? "CaptionDoorRuntime" : ""),
  };
  if (mode === "local") {
    const endpoint = env.DYNAMODB_ENDPOINT;
    let url: URL;
    try {
      url = new URL(endpoint || "");
    } catch {
      throw new Error(
        "Local mode requires an explicit DynamoDB Local endpoint.",
      );
    }
    const isolated =
      (["127.0.0.1", "localhost"].includes(url.hostname) &&
        url.port === "8410") ||
      (url.hostname === "dynamodb" && url.port === "8000");
    if (
      !isolated ||
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Local database must use isolated loopback:8410 or Compose dynamodb:8000.",
      );
    const prefixes = Object.entries(tables).map(([kind, name]) => {
      const suffix = suffixes[kind as keyof DatabaseTables];
      if (
        !/^CaptionDoor[A-Za-z0-9_-]{0,100}$/.test(name) ||
        !name.endsWith(suffix)
      )
        throw new Error(
          "Local table names must use one CaptionDoor namespace and role suffixes.",
        );
      return name.slice(0, -suffix.length);
    });
    if (new Set(prefixes).size !== 1)
      throw new Error("All database tables must share one namespace.");
    return {
      mode,
      environment: "local",
      endpoint: url.toString(),
      region,
      tables,
      pollIntervalMs,
    };
  }

  if (
    [
      env.DYNAMODB_ENDPOINT,
      env.AWS_ENDPOINT_URL,
      env.AWS_ENDPOINT_URL_DYNAMODB,
      env.AWS_ENDPOINT_URL_STS,
    ].some(Boolean)
  )
    throw new Error(
      "AWS mode rejects local/custom endpoint overrides. No fallback is used.",
    );
  if (!/^\d{12}$/.test(env.AWS_ACCOUNT_ID || ""))
    throw new Error(
      "AWS mode requires the explicitly approved AWS_ACCOUNT_ID.",
    );
  if (
    env.AWS_ACCESS_KEY_ID === "captiondoorlocal" ||
    env.AWS_SECRET_ACCESS_KEY === "captiondoor-local"
  )
    throw new Error(
      "DynamoDB Local dummy credentials cannot be used in AWS mode.",
    );
  const prefix =
    env.CAPTIONDOOR_AWS_TABLE_PREFIX ||
    (environment === "remote-demo" ? "CaptionDoorDev" : "CaptionDoor");
  const validPrefix =
    environment === "remote-provider"
      ? prefix === remoteProvider?.tablePrefix
      : environment === "remote-demo"
        ? /^CaptionDoorDev(?:-[a-z0-9][a-z0-9-]{0,39})?$/.test(prefix)
        : /^CaptionDoor(?:Prod(?:-[a-z0-9][a-z0-9-]{0,39})?)?$/.test(prefix);
  if (!validPrefix)
    throw new Error(
      "AWS table namespace does not match the selected environment.",
    );
  for (const [kind, suffix] of Object.entries(suffixes))
    if (tables[kind as keyof DatabaseTables] !== `${prefix}${suffix}`)
      throw new Error(
        "AWS mode requires all three explicit table names in its isolated namespace.",
      );
  if (environment === "remote-demo") {
    const origin = new URL(env.APP_ORIGIN || "http://127.0.0.1:3410");
    if (
      !["127.0.0.1", "localhost"].includes(origin.hostname) ||
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error(
        "Remote demo authentication is restricted to a loopback app origin.",
      );
    if (
      (env.AUTH_MODE || "demo") !== "demo" ||
      (env.RING_MODE || "demo") !== "demo" ||
      (env.TRANSCRIBE_MODE || "fixture") !== "fixture" ||
      env.SQS_QUEUE_URL
    )
      throw new Error(
        "Database-only remote demo uses demo auth, simulated Ring, fixture captions and the bounded due poller.",
      );
  }
  return {
    mode,
    environment: environment as
      "remote-demo" | "remote-provider" | "production",
    region,
    accountId: env.AWS_ACCOUNT_ID!,
    tables,
    pollIntervalMs,
  };
}

export function databaseClientOptions(
  config: DatabaseConfig,
): DynamoDBClientConfig {
  if (config.mode === "local")
    return {
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: "captiondoorlocal",
        secretAccessKey: "captiondoor-local",
      },
      maxAttempts: 3,
      ignoreConfiguredEndpointUrls: true,
    };
  // Normal SDK provider chain only: role/SSO/session credentials are never embedded here.
  return {
    region: config.region,
    maxAttempts: 3,
    ignoreConfiguredEndpointUrls: true,
  };
}
