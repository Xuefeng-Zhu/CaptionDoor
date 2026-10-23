import { describe, expect, it } from "vitest";
import { remoteProviderSmokeConfig } from "@captiondoor/domain";
import {
  databaseClientOptions,
  resolveDatabaseConfig,
} from "../../packages/db/src/config";

type Env = Record<string, string | undefined>;
const local = (override: Env = {}): Env => ({
  NODE_ENV: "development",
  CAPTIONDOOR_DB_MODE: "local",
  CAPTIONDOOR_ENV: "local",
  DYNAMODB_ENDPOINT: "http://127.0.0.1:8410",
  ...override,
});
const remote = (override: Env = {}): Env => ({
  NODE_ENV: "development",
  CAPTIONDOOR_DB_MODE: "aws",
  CAPTIONDOOR_ENV: "remote-demo",
  AWS_ACCOUNT_ID: "000000000000", // Synthetic target metadata; never an AWS request.
  AWS_REGION: "us-east-1",
  CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorDevConfig",
  CAPTIONDOOR_VISITS_TABLE: "CaptionDoorDevVisits",
  CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorDevRuntime",
  APP_ORIGIN: "http://127.0.0.1:3410",
  ...override,
});
const production = (override: Env = {}): Env =>
  remote({
    NODE_ENV: "production",
    CAPTIONDOOR_ENV: "production",
    AUTH_MODE: "oidc",
    RING_MODE: "live",
    TRANSCRIBE_MODE: "aws",
    CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorConfig",
    CAPTIONDOOR_VISITS_TABLE: "CaptionDoorVisits",
    CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorRuntime",
    ...override,
  });
const remoteProvider = (override: Env = {}): Env => {
  const config = remoteProviderSmokeConfig;
  return remote({
    CAPTIONDOOR_ENV: "remote-provider",
    AUTH_MODE: "demo",
    RING_MODE: "playground",
    TRANSCRIBE_MODE: "aws",
    CAPTIONDOOR_PROVIDER_SMOKE: "1",
    CAPTIONDOOR_REMOTE_PROVIDER_SMOKE: "1",
    CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL: config.scope,
    CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL: config.scope,
    CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL: config.scope,
    CAPTIONDOOR_SMOKE_APPROVAL: "captions",
    CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: "30",
    CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: "12000",
    CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: "a".repeat(64),
    CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL: config.scope,
    AWS_ACCOUNT_ID: config.accountId,
    AWS_REGION: config.region,
    TRANSCRIBE_AWS_ACCOUNT_ID: config.accountId,
    TRANSCRIBE_AWS_REGION: config.region,
    CAPTIONDOOR_AWS_TABLE_PREFIX: config.tablePrefix,
    CAPTIONDOOR_CONFIG_TABLE: `${config.tablePrefix}Config`,
    CAPTIONDOOR_VISITS_TABLE: `${config.tablePrefix}Visits`,
    CAPTIONDOOR_RUNTIME_TABLE: `${config.tablePrefix}Runtime`,
    ...override,
  });
};

describe("explicit DynamoDB configuration without a storage fallback", () => {
  it.each([
    { CAPTIONDOOR_DB_MODE: undefined },
    { CAPTIONDOOR_DB_MODE: "auto" },
    { CAPTIONDOOR_ENV: undefined },
    { CAPTIONDOOR_ENV: "staging" },
    { CAPTIONDOOR_DB_MODE: "aws" },
    { CAPTIONDOOR_ENV: "remote-demo" },
  ])("refuses ambiguous or mismatched target selection: %j", (override) => {
    expect(() => resolveDatabaseConfig(local(override))).toThrow();
  });

  it("uses only the isolated Local endpoint and local test credentials", () => {
    const config = resolveDatabaseConfig(local());
    expect(config.mode).toBe("local");
    expect(config.environment).toBe("local");
    expect(config.accountId).toBeUndefined();
    expect(config.tables).toEqual({
      config: "CaptionDoorConfig",
      visits: "CaptionDoorVisits",
      runtime: "CaptionDoorRuntime",
    });
    expect(config.pollIntervalMs).toBe(500);
    expect(databaseClientOptions(config)).toMatchObject({
      endpoint: "http://127.0.0.1:8410/",
      credentials: {
        accessKeyId: "captiondoorlocal",
        secretAccessKey: "captiondoor-local",
      },
      ignoreConfiguredEndpointUrls: true,
    });
  });

  it.each(["http://localhost:8410", "http://dynamodb:8000/"])(
    "supports the documented host or Compose Local address %s",
    (endpoint) => {
      expect(
        resolveDatabaseConfig(local({ DYNAMODB_ENDPOINT: endpoint })).mode,
      ).toBe("local");
    },
  );

  it.each([
    undefined,
    "",
    "http://127.0.0.1:8000",
    "http://dynamodb:8410",
    "http://other-project:8410",
    "https://127.0.0.1:8410",
    "http://user:password@127.0.0.1:8410",
    "http://127.0.0.1:8410/other",
    "http://127.0.0.1:8410/?target=shared",
    "http://127.0.0.1:8410/#other",
    "https://dynamodb.us-east-1.amazonaws.com",
  ])("refuses missing, shared or decorated Local endpoint %s", (endpoint) => {
    expect(() =>
      resolveDatabaseConfig(local({ DYNAMODB_ENDPOINT: endpoint })),
    ).toThrow();
  });

  it("keeps dedicated Local integration-test tables in one project namespace", () => {
    const config = resolveDatabaseConfig(
      local({
        CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorPersistenceTestConfig",
        CAPTIONDOOR_VISITS_TABLE: "CaptionDoorPersistenceTestVisits",
        CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorPersistenceTestRuntime",
      }),
    );
    expect(config.tables.runtime).toBe("CaptionDoorPersistenceTestRuntime");
    for (const override of [
      { CAPTIONDOOR_CONFIG_TABLE: "TallyConfig" },
      { CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorRuntime" },
      { CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorOtherConfig" },
    ])
      expect(() => resolveDatabaseConfig(local(override))).toThrow();
  });

  it("uses the normal AWS credential chain without a local endpoint or dummy credentials", () => {
    const config = resolveDatabaseConfig(
      remote({ AWS_PROFILE: "approved-session-fixture" }),
    );
    expect(config).toMatchObject({
      mode: "aws",
      environment: "remote-demo",
      region: "us-east-1",
      accountId: "000000000000",
      pollIntervalMs: 5000,
    });
    expect(config.endpoint).toBeUndefined();
    const options = databaseClientOptions(config);
    expect(options).not.toHaveProperty("credentials");
    expect(options).not.toHaveProperty("endpoint");
    expect(options.ignoreConfiguredEndpointUrls).toBe(true);
  });

  it.each([
    "DYNAMODB_ENDPOINT",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_ENDPOINT_URL_STS",
  ])("refuses inherited endpoint override %s in AWS mode", (key) => {
    expect(() =>
      resolveDatabaseConfig(remote({ [key]: "http://127.0.0.1:8410" })),
    ).toThrow(/endpoint overrides/);
  });

  it.each([
    { AWS_REGION: undefined },
    { AWS_REGION: "us-east-1/extra" },
    { AWS_ACCOUNT_ID: undefined },
    { AWS_ACCOUNT_ID: "123" },
    { CAPTIONDOOR_CONFIG_TABLE: undefined },
    { CAPTIONDOOR_VISITS_TABLE: undefined },
    { CAPTIONDOOR_RUNTIME_TABLE: undefined },
  ])("requires complete explicit AWS metadata: %j", (override) => {
    expect(() => resolveDatabaseConfig(remote(override))).toThrow();
  });

  it.each([
    { AWS_ACCESS_KEY_ID: "captiondoorlocal" },
    { AWS_SECRET_ACCESS_KEY: "captiondoor-local" },
  ])(
    "refuses known DynamoDB Local fixture credentials remotely: %j",
    (override) => {
      expect(() => resolveDatabaseConfig(remote(override))).toThrow(
        /dummy credentials/,
      );
    },
  );

  it("requires all AWS table names to match the approved environment namespace", () => {
    const config = resolveDatabaseConfig(
      remote({
        CAPTIONDOOR_AWS_TABLE_PREFIX: "CaptionDoorDev-review1",
        CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorDev-review1Config",
        CAPTIONDOOR_VISITS_TABLE: "CaptionDoorDev-review1Visits",
        CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorDev-review1Runtime",
      }),
    );
    expect(config.tables.config).toBe("CaptionDoorDev-review1Config");
    for (const override of [
      { CAPTIONDOOR_AWS_TABLE_PREFIX: "Tally" },
      { CAPTIONDOOR_AWS_TABLE_PREFIX: "CaptionDoorProd" },
      { CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorConfig" },
      { CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorOtherRuntime" },
    ])
      expect(() => resolveDatabaseConfig(remote(override))).toThrow();
  });
});

describe("remote demo and production boundaries", () => {
  it.each([
    { AUTH_MODE: "oidc" },
    { RING_MODE: "playground" },
    { RING_MODE: "live" },
    { TRANSCRIBE_MODE: "aws" },
    { SQS_QUEUE_URL: "https://sqs.fixture.invalid/jobs" },
  ])(
    "keeps database-only remote demo separate from other cloud adapters: %j",
    (override) => {
      expect(() => resolveDatabaseConfig(remote(override))).toThrow(
        /Database-only remote demo/,
      );
    },
  );

  it.each([
    "https://public.example",
    "http://user:password@localhost:3410",
    "http://localhost:3410/other",
    "http://localhost:3410/?redirect=external",
    "file://localhost/",
  ])("does not expose demo auth through an unsafe origin %s", (origin) => {
    expect(() =>
      resolveDatabaseConfig(remote({ APP_ORIGIN: origin })),
    ).toThrow();
  });

  it("preserves real production mode and namespace requirements", () => {
    expect(resolveDatabaseConfig(production()).environment).toBe("production");
    for (const override of [
      { AUTH_MODE: "demo" },
      { RING_MODE: "demo" },
      { TRANSCRIBE_MODE: "fixture" },
      { CAPTIONDOOR_ENV: "remote-demo" },
      { CAPTIONDOOR_DB_MODE: "local" },
      { NODE_ENV: "development" },
      { CAPTIONDOOR_AWS_TABLE_PREFIX: "CaptionDoorDev" },
    ])
      expect(() => resolveDatabaseConfig(production(override))).toThrow();
  });

  it.each(["0", "999", "60001", "1.5", "NaN", "Infinity"])(
    "rejects unsafe AWS polling interval %s",
    (value) => {
      expect(() =>
        resolveDatabaseConfig(
          remote({ CAPTIONDOOR_JOB_POLL_INTERVAL_MS: value }),
        ),
      ).toThrow(/polling/);
    },
  );

  it("allows documented polling bounds while keeping remote defaults slower than Local", () => {
    expect(
      resolveDatabaseConfig(local({ CAPTIONDOOR_JOB_POLL_INTERVAL_MS: "100" }))
        .pollIntervalMs,
    ).toBe(100);
    expect(
      resolveDatabaseConfig(
        remote({ CAPTIONDOOR_JOB_POLL_INTERVAL_MS: "1000" }),
      ).pollIntervalMs,
    ).toBe(1000);
    expect(
      resolveDatabaseConfig(
        remote({ CAPTIONDOOR_JOB_POLL_INTERVAL_MS: "60000" }),
      ).pollIntervalMs,
    ).toBe(60000);
    expect(resolveDatabaseConfig(remote()).pollIntervalMs).toBeGreaterThan(
      resolveDatabaseConfig(local()).pollIntervalMs,
    );
  });
});

describe("isolated remote provider database configuration", () => {
  it("validates only the exact provider namespace and leaves AWS credentials to the verified session", () => {
    const config = resolveDatabaseConfig(remoteProvider());
    expect(config).toEqual({
      mode: "aws",
      environment: "remote-provider",
      region: remoteProviderSmokeConfig.region,
      accountId: remoteProviderSmokeConfig.accountId,
      tables: {
        config: `${remoteProviderSmokeConfig.tablePrefix}Config`,
        visits: `${remoteProviderSmokeConfig.tablePrefix}Visits`,
        runtime: `${remoteProviderSmokeConfig.tablePrefix}Runtime`,
      },
      pollIntervalMs: 5000,
    });
    expect(databaseClientOptions(config)).toEqual({
      region: remoteProviderSmokeConfig.region,
      maxAttempts: 3,
      ignoreConfiguredEndpointUrls: true,
    });
  });

  it.each([
    { CAPTIONDOOR_REMOTE_PROVIDER_SMOKE: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: "0" },
    { CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: undefined },
    { CAPTIONDOOR_ROOT_SMOKE: "0" },
    { CAPTIONDOOR_ROOT_SMOKE_APPROVAL: "" },
    { CAPTIONDOOR_ROOT_SMOKE_OTHER: "1" },
    { CAPTIONDOOR_ENV: "remote-demo" },
    { CAPTIONDOOR_ENV: "local" },
    { CAPTIONDOOR_DB_MODE: "local" },
    { CAPTIONDOOR_AWS_TABLE_PREFIX: "CaptionDoorDev" },
    { CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorConfig" },
    { CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorDevProviderSmoke20261024Runtime" },
    { APP_ORIGIN: "https://public.fixture.invalid" },
    { AWS_ACCOUNT_ID: "000000000000" },
    { AWS_REGION: "us-west-2" },
    { TRANSCRIBE_AWS_REGION: "us-west-2" },
  ])(
    "fails closed before constructing a database client for %j",
    (override) => {
      expect(() => resolveDatabaseConfig(remoteProvider(override))).toThrow();
    },
  );

  it.each([
    "DYNAMODB_ENDPOINT",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_ENDPOINT_URL_STS",
    "AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING",
    "AWS_ENDPOINT_URL_UNKNOWN",
    "TRANSCRIBE_ENDPOINT",
  ])("rejects defined provider endpoint override %s, even empty", (key) => {
    for (const value of ["", "http://127.0.0.1:8410"])
      expect(() =>
        resolveDatabaseConfig(remoteProvider({ [key]: value })),
      ).toThrow();
  });

  it("does not grant the dedicated provider namespace to fixture-only remote demo", () => {
    const provider = remoteProvider();
    expect(() =>
      resolveDatabaseConfig(
        remote({
          CAPTIONDOOR_AWS_TABLE_PREFIX: provider.CAPTIONDOOR_AWS_TABLE_PREFIX,
          CAPTIONDOOR_CONFIG_TABLE: provider.CAPTIONDOOR_CONFIG_TABLE,
          CAPTIONDOOR_VISITS_TABLE: provider.CAPTIONDOOR_VISITS_TABLE,
          CAPTIONDOOR_RUNTIME_TABLE: provider.CAPTIONDOOR_RUNTIME_TABLE,
        }),
      ),
    ).toThrow(/namespace/);
    expect(() =>
      resolveDatabaseConfig(local({ CAPTIONDOOR_REMOTE_PROVIDER_SMOKE: "" })),
    ).toThrow();
  });
});
