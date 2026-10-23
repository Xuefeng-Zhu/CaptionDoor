import { describe, expect, it } from "vitest";
import { remoteProviderSmokeConfig } from "@captiondoor/domain";
import { resolveDatabaseConfig } from "../../packages/db/src/config";
import {
  assertRemoteProviderSeedCollision,
  assertRemoteProviderStorageScope,
  buildRemoteProviderSeedRows,
} from "../../scripts/provider-session-remote-storage";

const nowSeconds = 1792771200;
const approved = (): NodeJS.ProcessEnv => {
  const config = remoteProviderSmokeConfig;
  return {
    NODE_ENV: "development",
    CAPTIONDOOR_ENV: "remote-provider",
    CAPTIONDOOR_DB_MODE: "aws",
    AUTH_MODE: "demo",
    RING_MODE: "playground",
    TRANSCRIBE_MODE: "aws",
    APP_ORIGIN: "http://127.0.0.1:3410",
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
  };
};

describe("pure bounded fictional remote-provider seed", () => {
  it("contains exactly the existing two households, three demo identities and health keys", () => {
    const rows = buildRemoteProviderSeedRows(nowSeconds);
    const keys = rows.map((row) => `${row.PK}|${row.SK}`);
    expect(rows).toHaveLength(17);
    expect(new Set(keys).size).toBe(rows.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "HOUSEHOLD#h1|PROFILE",
        "HOUSEHOLD#h2|PROFILE",
        "HOUSEHOLD#h1|MEMBER#alex",
        "HOUSEHOLD#h1|MEMBER#sam",
        "HOUSEHOLD#h2|MEMBER#jordan",
        "USER#alex|LOOKUP",
        "USER#sam|LOOKUP",
        "USER#jordan|LOOKUP",
        "HEALTH|HEALTH",
      ]),
    );
    expect(rows.find((row) => row.PK === "USER#alex")).toMatchObject({
      userId: "alex",
      householdId: "h1",
    });
    expect(rows.find((row) => row.PK === "USER#jordan")).toMatchObject({
      userId: "jordan",
      householdId: "h2",
    });
    for (const row of rows) {
      expect(row).toMatchObject({
        providerSeedNamespace: remoteProviderSmokeConfig.tablePrefix,
        providerSeedScope: remoteProviderSmokeConfig.scope,
        providerSeedVersion: 1,
        providerSeedCreatedAt: nowSeconds,
        expiresAt: nowSeconds + 3600,
      });
      expect(row.PK).not.toMatch(/BUDGET|SESSION|MEDIA|VISIT|JOB/);
      for (const name of Object.keys(row))
        expect(name).not.toMatch(/token|secret|credential|duePk|dueSk/i);
    }
  });

  it("keeps consent false, memberships finite and provider integration disconnected", () => {
    const rows = buildRemoteProviderSeedRows(nowSeconds);
    const profiles = rows.filter((row) => row.SK === "PROFILE");
    expect(profiles).toHaveLength(2);
    for (const profile of profiles)
      expect(profile.settings).toMatchObject({
        retentionHours: 1,
        consent: { ring: false, transcription: false, sharing: false },
      });
    expect(rows.find((row) => row.SK === "MEMBER#alex")).toMatchObject({
      role: "owner",
      grants: { membership: true },
      expiresAt: nowSeconds + 3600,
    });
    expect(rows.find((row) => row.SK === "MEMBER#sam")).toMatchObject({
      role: "member",
      grants: { membership: false },
    });
    for (const integration of rows.filter(
      (row) => row.SK === "INTEGRATION#ring",
    ))
      expect(integration).toMatchObject({
        mode: "playground",
        status: "NOT_CONNECTED",
        connected: false,
      });
  });

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects an unsafe seed clock %s",
    (clock) => {
      expect(() => buildRemoteProviderSeedRows(clock)).toThrow(
        "REMOTE_PROVIDER_SEED_TIME_INVALID",
      );
    },
  );

  it("keeps row builders independent without mutating shared settings or grant objects", () => {
    const first = buildRemoteProviderSeedRows(nowSeconds);
    (first.find((row) => row.SK === "PROFILE")!.settings as any).presets.push(
      "changed",
    );
    (first.find((row) => row.SK === "MEMBER#alex")!.grants as any).camera =
      false;
    const next = buildRemoteProviderSeedRows(nowSeconds);
    expect(
      (next.find((row) => row.SK === "PROFILE")!.settings as any).presets,
    ).not.toContain("changed");
    expect(
      (next.find((row) => row.SK === "MEMBER#alex")!.grants as any).camera,
    ).toBe(true);
  });

  it("accepts an existing live seed without renewing its original expiry or replacing settings", () => {
    const expected = buildRemoteProviderSeedRows(nowSeconds)[0];
    const existing = {
      ...expected,
      providerSeedCreatedAt: nowSeconds - 1800,
      expiresAt: nowSeconds + 1800,
      settings: { changedByResident: true },
    };
    const before = structuredClone(existing);
    expect(() =>
      assertRemoteProviderSeedCollision(expected, existing, nowSeconds),
    ).not.toThrow();
    expect(existing).toEqual(before);
  });

  it.each([
    { providerSeedNamespace: undefined },
    { providerSeedNamespace: "CaptionDoorDev" },
    { providerSeedScope: undefined },
    { providerSeedScope: "other" },
    { providerSeedVersion: 2 },
    { providerSeedCreatedAt: undefined },
    { providerSeedCreatedAt: nowSeconds + 1 },
    { expiresAt: undefined },
    { expiresAt: nowSeconds + 3601 },
    { PK: "HOUSEHOLD#other" },
    { SK: "OTHER" },
  ])(
    "refuses unmarked, decorated or overlong seed collisions %j",
    (override) => {
      const row = buildRemoteProviderSeedRows(nowSeconds)[0];
      expect(() =>
        assertRemoteProviderSeedCollision(
          row,
          { ...row, ...override },
          nowSeconds,
        ),
      ).toThrow("REMOTE_PROVIDER_SEED_COLLISION");
    },
  );

  it.each([nowSeconds - 1, nowSeconds])(
    "does not silently refresh marked expiry %i",
    (expiry) => {
      const row = buildRemoteProviderSeedRows(nowSeconds)[0];
      expect(() =>
        assertRemoteProviderSeedCollision(
          row,
          {
            ...row,
            providerSeedCreatedAt: nowSeconds - 3600,
            expiresAt: expiry,
          },
          nowSeconds,
        ),
      ).toThrow("REMOTE_PROVIDER_SEED_EXPIRED");
    },
  );
});

describe("pure captured repository scope gate", () => {
  it("requires exact runtime configuration without loading a repository client", () => {
    const env = approved();
    expect(() =>
      assertRemoteProviderStorageScope(env, resolveDatabaseConfig(env)),
    ).not.toThrow();
  });

  it.each([
    { mode: "local" as const },
    { environment: "remote-demo" as const },
    { accountId: "000000000000" },
    { region: "us-west-2" },
    { pollIntervalMs: 1000 },
    { endpoint: "http://127.0.0.1:8410" },
    {
      tables: {
        config: "CaptionDoorConfig",
        visits: "CaptionDoorVisits",
        runtime: "CaptionDoorRuntime",
      },
    },
  ])(
    "rejects captured config drift %j before any SDK operation",
    (override) => {
      const env = approved();
      expect(() =>
        assertRemoteProviderStorageScope(env, {
          ...resolveDatabaseConfig(env),
          ...override,
        }),
      ).toThrow("REMOTE_PROVIDER_STORAGE_SCOPE_REQUIRED");
    },
  );

  it.each([
    { CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL: undefined },
    { CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL: undefined },
    { CAPTIONDOOR_ROOT_SMOKE: "0" },
    { AWS_ENDPOINT_URL: "" },
  ])(
    "rejects revoked scope or inherited conflicts before any SDK operation %j",
    (override) => {
      const env = approved();
      const captured = resolveDatabaseConfig(env);
      expect(() =>
        assertRemoteProviderStorageScope({ ...env, ...override }, captured),
      ).toThrow("REMOTE_PROVIDER_STORAGE_SCOPE_REQUIRED");
    },
  );
});
