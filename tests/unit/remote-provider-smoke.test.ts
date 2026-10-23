import { describe, expect, it } from "vitest";
import {
  assertActiveProviderSmokeEnvironment,
  assertProviderSmokeEnvironment,
  assertRemoteProviderSmokeEnvironment,
  assertRootSmokeEnvironment,
  remoteProviderSmokeConfig,
  rootSmokeConfig,
  type ProviderSmokeEnvironment,
} from "@captiondoor/domain";

// Fixed target metadata and synthetic receipts only. These tests make no AWS requests.
const remote = (
  overrides: ProviderSmokeEnvironment = {},
): ProviderSmokeEnvironment => ({
  NODE_ENV: "development",
  CAPTIONDOOR_ENV: "remote-provider",
  CAPTIONDOOR_DB_MODE: "aws",
  AUTH_MODE: "demo",
  RING_MODE: "playground",
  TRANSCRIBE_MODE: "aws",
  APP_ORIGIN: "http://127.0.0.1:3410",
  CAPTIONDOOR_PROVIDER_SMOKE: "1",
  CAPTIONDOOR_REMOTE_PROVIDER_SMOKE: "1",
  CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL: remoteProviderSmokeConfig.scope,
  CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL: remoteProviderSmokeConfig.scope,
  CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL:
    remoteProviderSmokeConfig.scope,
  CAPTIONDOOR_SMOKE_APPROVAL: "captions",
  CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: "30",
  CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: "12000",
  CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: "a".repeat(64),
  CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL:
    remoteProviderSmokeConfig.scope,
  AWS_ACCOUNT_ID: remoteProviderSmokeConfig.accountId,
  AWS_REGION: remoteProviderSmokeConfig.region,
  TRANSCRIBE_AWS_ACCOUNT_ID: remoteProviderSmokeConfig.accountId,
  TRANSCRIBE_AWS_REGION: remoteProviderSmokeConfig.region,
  CAPTIONDOOR_AWS_TABLE_PREFIX: remoteProviderSmokeConfig.tablePrefix,
  CAPTIONDOOR_CONFIG_TABLE: `${remoteProviderSmokeConfig.tablePrefix}Config`,
  CAPTIONDOOR_VISITS_TABLE: `${remoteProviderSmokeConfig.tablePrefix}Visits`,
  CAPTIONDOOR_RUNTIME_TABLE: `${remoteProviderSmokeConfig.tablePrefix}Runtime`,
  ...overrides,
});
const local = (): ProviderSmokeEnvironment => ({
  NODE_ENV: "development",
  CAPTIONDOOR_ENV: "local",
  CAPTIONDOOR_DB_MODE: "local",
  AUTH_MODE: "demo",
  RING_MODE: "playground",
  CAPTIONDOOR_PROVIDER_SMOKE: "1",
  APP_ORIGIN: "http://127.0.0.1:3410",
  CAPTIONDOOR_CONFIG_TABLE: `${rootSmokeConfig.tablePrefix}Config`,
  CAPTIONDOOR_VISITS_TABLE: `${rootSmokeConfig.tablePrefix}Visits`,
  CAPTIONDOOR_RUNTIME_TABLE: `${rootSmokeConfig.tablePrefix}Runtime`,
});

describe("isolated remote provider configuration validation", () => {
  it("returns only bounded target and reviewed receipt metadata without requiring credentials", () => {
    expect(assertRemoteProviderSmokeEnvironment(remote())).toEqual({
      ...remoteProviderSmokeConfig,
      previousSeconds: 30,
      previousMicrousd: 12000,
      baselineSha256: "a".repeat(64),
      allowRoot: false,
    });
    expect(Object.isFrozen(remoteProviderSmokeConfig)).toBe(true);
    expect(remote()).not.toHaveProperty("AWS_ACCESS_KEY_ID");
  });

  it("allows the explicitly approved root option only within the complete remote scope", () => {
    const withRoot = remote({
      CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL:
        remoteProviderSmokeConfig.scope,
    });
    expect(assertRemoteProviderSmokeEnvironment(withRoot).allowRoot).toBe(true);
    expect(assertRemoteProviderSmokeEnvironment(remote()).allowRoot).toBe(
      false,
    );
    for (const value of ["", "0", "1", rootSmokeConfig.scope])
      expect(() =>
        assertRemoteProviderSmokeEnvironment(
          remote({ CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL: value }),
        ),
      ).toThrow();
    for (const override of [
      { CAPTIONDOOR_ENV: "remote-demo" },
      { CAPTIONDOOR_ENV: "local" },
      { CAPTIONDOOR_ENV: "production", NODE_ENV: "production" },
      { CAPTIONDOOR_DB_MODE: "local" },
      { AWS_ACCOUNT_ID: "000000000000" },
      { CAPTIONDOOR_ROOT_SMOKE: "1" },
    ])
      expect(() =>
        assertRemoteProviderSmokeEnvironment({ ...withRoot, ...override }),
      ).toThrow();
  });

  it.each([
    { NODE_ENV: "production" },
    { CAPTIONDOOR_ENV: "remote-demo" },
    { CAPTIONDOOR_ENV: "local" },
    { CAPTIONDOOR_ENV: undefined },
    { CAPTIONDOOR_DB_MODE: "local" },
    { AUTH_MODE: undefined },
    { AUTH_MODE: "oidc" },
    { RING_MODE: "demo" },
    { RING_MODE: "live" },
    { TRANSCRIBE_MODE: "fixture" },
    { CAPTIONDOOR_PROVIDER_SMOKE: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_SMOKE: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_SMOKE: "true" },
    { CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL: rootSmokeConfig.scope },
    { CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL: "approved" },
    { CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL: "approved" },
    { CAPTIONDOOR_SMOKE_APPROVAL: undefined },
    { CAPTIONDOOR_SMOKE_APPROVAL: "discovery" },
    { AWS_ACCOUNT_ID: "000000000000" },
    { AWS_REGION: "us-west-2" },
    { TRANSCRIBE_AWS_ACCOUNT_ID: "000000000000" },
    { TRANSCRIBE_AWS_REGION: "us-west-2" },
    { CAPTIONDOOR_AWS_TABLE_PREFIX: undefined },
    { CAPTIONDOOR_AWS_TABLE_PREFIX: "CaptionDoorDev" },
    { CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorDevConfig" },
    { CAPTIONDOOR_VISITS_TABLE: undefined },
    { CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorDevProviderSmoke20261024Runtime" },
    { AWS_ACCESS_KEY_ID: "captiondoorlocal" },
    { AWS_SECRET_ACCESS_KEY: "captiondoor-local" },
    { SQS_QUEUE_URL: "https://sqs.fixture.invalid/jobs" },
  ])(
    "fails closed for modes, scope, targets or adapter changes %j",
    (overrides) => {
      expect(() =>
        assertRemoteProviderSmokeEnvironment(remote(overrides)),
      ).toThrow(
        expect.objectContaining({
          code: "REMOTE_PROVIDER_SMOKE_DISABLED",
          status: 403,
        }),
      );
    },
  );

  it.each([
    undefined,
    "http://localhost:3410",
    "http://127.0.0.1:3410/",
    "https://127.0.0.1:3443",
    "http://127.0.0.1:3411",
    "https://public.fixture.invalid",
    "http://127.0.0.1:3410/?token=fixture",
  ])(
    "keeps demo authentication at the exact approved loopback origin %s",
    (origin) => {
      expect(() =>
        assertRemoteProviderSmokeEnvironment(remote({ APP_ORIGIN: origin })),
      ).toThrow();
    },
  );

  it.each([
    "CAPTIONDOOR_ROOT_SMOKE",
    "CAPTIONDOOR_ROOT_SMOKE_APPROVAL",
    "CAPTIONDOOR_ROOT_SMOKE_UNKNOWN",
    "DYNAMODB_ENDPOINT",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_ENDPOINT_URL_STS",
    "AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING",
    "AWS_ENDPOINT_URL_NEW_SERVICE",
    "TRANSCRIBE_ENDPOINT",
    "TRANSCRIBE_ENDPOINT_URL",
    "TRANSCRIBE_STREAMING_ENDPOINT",
  ])("rejects every defined inherited root marker or endpoint %s", (key) => {
    for (const value of ["", "0", "https://override.fixture.invalid"])
      expect(() =>
        assertRemoteProviderSmokeEnvironment(remote({ [key]: value })),
      ).toThrow();
    expect(() =>
      assertRemoteProviderSmokeEnvironment(remote({ [key]: undefined })),
    ).not.toThrow();
  });

  it.each([
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: "" },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: "00" },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: "29" },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: "120" },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: "0" },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: "12000.0" },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: "012000" },
    { CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: "Infinity" },
    { CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: "A".repeat(64) },
    { CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: "a".repeat(63) },
    { CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL: "approved" },
  ])(
    "requires explicit conservative reviewed prior usage metadata %j",
    (overrides) => {
      expect(() =>
        assertRemoteProviderSmokeEnvironment(remote(overrides)),
      ).toThrow();
    },
  );

  it.each([0, 30, 60, 90])(
    "carries the stated prior %i seconds without resetting the ceiling",
    (seconds) => {
      const config = assertRemoteProviderSmokeEnvironment(
        remote({
          CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: String(seconds),
          CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: String(seconds * 400),
        }),
      );
      expect(config.previousSeconds).toBe(seconds);
      expect(config.previousMicrousd).toBe(seconds * 400);
      expect(config.maxSeconds).toBe(90);
      expect(config.maxMicrousd).toBe(10000000);
    },
  );
});

describe("Local and remote provider dispatcher boundaries", () => {
  it("preserves the original isolated Local guard and root test scope", () => {
    expect(assertActiveProviderSmokeEnvironment(local())).toEqual({
      tablePrefix: rootSmokeConfig.tablePrefix,
    });
    expect(
      assertRootSmokeEnvironment({
        ...local(),
        DYNAMODB_ENDPOINT: "http://127.0.0.1:8410",
        CAPTIONDOOR_ROOT_SMOKE: "1",
        CAPTIONDOOR_ROOT_SMOKE_APPROVAL: rootSmokeConfig.scope,
        CAPTIONDOOR_SMOKE_APPROVAL: "captions",
        TRANSCRIBE_MODE: "aws",
        TRANSCRIBE_AWS_ACCOUNT_ID: rootSmokeConfig.accountId,
        TRANSCRIBE_AWS_REGION: rootSmokeConfig.region,
      }),
    ).toEqual(rootSmokeConfig);
    expect(() => assertRootSmokeEnvironment(remote())).toThrow();
    expect(() => assertProviderSmokeEnvironment(remote())).toThrow();
  });

  it("dispatches exact remote configuration and refuses mixed remote markers in Local mode", () => {
    expect(assertActiveProviderSmokeEnvironment(remote())).toMatchObject({
      tablePrefix: remoteProviderSmokeConfig.tablePrefix,
      previousSeconds: 30,
    });
    for (const key of [
      "CAPTIONDOOR_REMOTE_PROVIDER_SMOKE",
      "CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL",
      "CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256",
      "CAPTIONDOOR_REMOTE_PROVIDER_UNKNOWN",
    ])
      for (const value of ["", "0", "1"])
        for (const validate of [
          assertProviderSmokeEnvironment,
          assertActiveProviderSmokeEnvironment,
        ])
          expect(() => validate({ ...local(), [key]: value })).toThrow();
  });
});
