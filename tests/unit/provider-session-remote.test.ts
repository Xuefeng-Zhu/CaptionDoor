import { describe, expect, it, vi } from "vitest";
import { rootSmokeConfig } from "@captiondoor/domain";
import {
  parseRemoteSessionArgs,
  parseRemoteSessionBaseline,
  buildRemoteSessionBaseEnvironment,
  buildRemoteSessionEnvironment,
} from "../../scripts/provider-session-remote-config";
import { mainRemoteSession } from "../../scripts/provider-session-remote";
import {
  providerSmokePreflight,
  providerSmokeChildEnvironment,
  assertProviderSmokeHealth,
} from "../../scripts/provider-smoke-config";
import {
  remoteProviderBudgetEvidence,
  remoteProviderReceiptEvidence,
} from "../../scripts/remote-provider-evidence";

const args = [
  "--start",
  "--approved-aws-writes",
  "--approved-cloud-storage",
  "--approved-cleanup",
  "--profile",
  "fictional-temporary-role",
  "--baseline",
  "/tmp/fictional-reviewed-baseline.json",
];
const receipt = () => ({
  version: 1,
  source: "OPERATOR_REVIEWED_CARRY_FORWARD",
  scope: rootSmokeConfig.scope,
  tablePrefix: rootSmokeConfig.tablePrefix,
  accountId: rootSmokeConfig.accountId,
  region: rootSmokeConfig.region,
  reservedSeconds: 30,
  reservedMicrousd: 12000,
  attempts: 1,
  verifiedAt: "2026-10-22T12:00:00.000Z",
  localScopeRetired: true,
});
const base = () =>
  buildRemoteSessionBaseEnvironment(
    { NODE_ENV: "test" },
    "fictional-temporary-role",
    parseRemoteSessionBaseline(JSON.stringify(receipt())),
  );

describe("remote hidden-intake boundary", () => {
  it("requires all cloud approvals, profile and an absolute evidence path", () => {
    expect(parseRemoteSessionArgs(args)).toMatchObject({
      start: true,
      profile: "fictional-temporary-role",
    });
    for (const flag of [
      "--approved-aws-writes",
      "--approved-cloud-storage",
      "--approved-cleanup",
    ])
      expect(() =>
        parseRemoteSessionArgs(args.filter((x) => x !== flag)),
      ).toThrow();
    expect(() =>
      parseRemoteSessionArgs([...args, "--token=fictional-do-not-output"]),
    ).toThrow("INVALID_REMOTE_SESSION_ARGUMENTS");
    expect(() =>
      parseRemoteSessionArgs(
        args.map((x) => (x.startsWith("/tmp/") ? "relative.json" : x)),
      ),
    ).toThrow();
  });
  it("carries the explicit root approval only through the fixed remote scope", () => {
    const parsed = parseRemoteSessionArgs([...args, "--approved-root"]);
    expect(parsed).toMatchObject({ start: true, allowRoot: true });
    const env = buildRemoteSessionBaseEnvironment(
      { NODE_ENV: "test" },
      "tally",
      parseRemoteSessionBaseline(JSON.stringify(receipt())),
      true,
    );
    expect(env.CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL).toBe(
      env.CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL,
    );
    const child = providerSmokeChildEnvironment(
      env,
      "captions",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(child.CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL).toBe(
      env.CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL,
    );
    expect(child).not.toHaveProperty("AWS_PROFILE");
    expect(base()).not.toHaveProperty(
      "CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL",
    );
  });
  it("help never reads credentials or echoes inherited values", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("RING_PLAYGROUND_TOKEN", "fictional-do-not-output");
    try {
      expect(await mainRemoteSession(["--help"])).toBe(0);
      expect(log.mock.calls.flat().join(" ")).not.toContain(
        "fictional-do-not-output",
      );
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it("refuses non-TTY execution before trying to read a baseline or start services", async () => {
    const previous = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      await expect(mainRemoteSession(args)).rejects.toThrow(
        "INTERACTIVE_USER_TERMINAL_REQUIRED",
      );
    } finally {
      if (previous) Object.defineProperty(process.stdin, "isTTY", previous);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  });
  it.each([
    { reservedSeconds: undefined },
    { reservedSeconds: 0 },
    { reservedMicrousd: 0 },
    { attempts: 0 },
    { scope: "new-budget-scope" },
    { localScopeRetired: false },
    { source: "ASSUME_ZERO" },
    { accessToken: "fictional-do-not-output" },
  ])(
    "refuses missing, inconsistent or unreviewed carry-forward %j",
    (change) => {
      expect(() =>
        parseRemoteSessionBaseline(JSON.stringify({ ...receipt(), ...change })),
      ).toThrow("REVIEWED_CARRY_FORWARD_RECEIPT_REQUIRED");
    },
  );
  it("hashes actual reviewed bytes and carries counters forward", () => {
    const raw = JSON.stringify(receipt()),
      a = parseRemoteSessionBaseline(raw),
      b = parseRemoteSessionBaseline(raw + "\n");
    expect(a.previousSeconds).toBe(30);
    expect(a.previousMicrousd).toBe(12000);
    expect(a.baselineSha256).not.toBe(b.baselineSha256);
    expect(() =>
      parseRemoteSessionBaseline(
        JSON.stringify({
          ...receipt(),
          verifiedAt: "2999-01-01T00:00:00.000Z",
        }),
      ),
    ).toThrow();
  });
  it.each([
    "AWS_ACCESS_KEY_ID",
    "AWS_SESSION_TOKEN",
    "RING_PLAYGROUND_TOKEN",
    "DEV_CREDENTIAL_KEY",
    "AWS_ENDPOINT_URL",
    "CAPTIONDOOR_ROOT_SMOKE",
  ])("refuses inherited secret or old scope %s", (key) => {
    expect(() =>
      buildRemoteSessionBaseEnvironment(
        { NODE_ENV: "test", [key]: "fictional-do-not-output" },
        "fictional-role",
        parseRemoteSessionBaseline(JSON.stringify(receipt())),
      ),
    ).toThrow("INHERITED_REMOTE_SECRET_OR_SCOPE_CONFLICT");
  });
  it("keeps all provider/AWS credentials out of the browser child", () => {
    const backend = buildRemoteSessionEnvironment(base(), {
      token: "fictional-do-not-output",
      keyBase64: Buffer.alloc(32, 7).toString("base64"),
    });
    backend.CAPTIONDOOR_SMOKE_DEVICE_ID = "fictional-device";
    expect(providerSmokePreflight(backend, "captions").result).toBe("READY");
    const child = providerSmokeChildEnvironment(
      backend,
      "captions",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(child.CAPTIONDOOR_ENV).toBe("remote-provider");
    for (const key of [
      "RING_PLAYGROUND_TOKEN",
      "DEV_CREDENTIAL_KEY",
      "AWS_PROFILE",
      "AWS_DEFAULT_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SESSION_TOKEN",
    ])
      expect(child).not.toHaveProperty(key);
    expect(JSON.stringify(child)).not.toContain("fictional-do-not-output");
  });
});

describe("remote provider evidence boundaries", () => {
  const summary = () => {
    const env = base();
    return {
      scope: env.CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL,
      accountId: env.AWS_ACCOUNT_ID,
      region: env.AWS_REGION,
      tablePrefix: env.CAPTIONDOOR_AWS_TABLE_PREFIX,
      previousSeconds: 30,
      previousMicrousd: 12000,
      baselineSha256: env.CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256,
      maxAttemptSeconds: 30,
      maxSeconds: 90,
      maxMicrousd: 10000000,
      microusdPerSecond: 400,
      conservativeReservation: true,
      reservedSeconds: 60,
      reservedMicrousd: 24000,
      cumulativeEstimatedMicrousd: 24000,
      attempts: 1,
      remainingSeconds: 30,
      remainingMicrousd: 9976000,
    };
  };
  it("rejects a remote reset and mismatched baseline", () => {
    expect(
      remoteProviderBudgetEvidence(summary(), base(), true).reservedSeconds,
    ).toBe(60);
    for (const changed of [
      { reservedSeconds: 30 },
      { previousSeconds: 0 },
      { baselineSha256: "b".repeat(64) },
      { attempts: 2 },
    ])
      expect(() =>
        remoteProviderBudgetEvidence(
          { ...summary(), ...changed },
          base(),
          false,
        ),
      ).toThrow();
  });
  it("requires worker receipt and verified NON_ROOT identity", () => {
    const env = base(),
      before = remoteProviderBudgetEvidence(summary(), env, true),
      now = Date.now();
    const value = {
      scope: before.scope,
      previousSeconds: 30,
      previousMicrousd: 12000,
      baselineSha256: env.CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256,
      attemptId: "11111111-1111-4111-8111-111111111111",
      identity: "NON_ROOT",
      maxSeconds: 30,
      expiresAt: now + 20000,
      cumulativeReservedSeconds: 90,
      cumulativeEstimatedMicrousd: 36000,
    };
    expect(
      remoteProviderReceiptEvidence(value, before, env, now).identity,
    ).toBe("NON_ROOT");
    for (const changed of [
      { identity: "ROOT" },
      { expiresAt: now + 30001 },
      { cumulativeReservedSeconds: 60 },
      { baselineSha256: "b".repeat(64) },
    ])
      expect(() =>
        remoteProviderReceiptEvidence(
          { ...value, ...changed },
          before,
          env,
          now,
        ),
      ).toThrow();
  });
  it("distinguishes actual captured remote health from Local fixture health", () => {
    const env = base(),
      prefix = env.CAPTIONDOOR_AWS_TABLE_PREFIX!;
    const web = {
      status: "ok",
      database: "DynamoDB",
      databaseMode: "aws",
      environment: "remote-provider",
      authMode: "demo",
      ringMode: "playground",
      transcribeMode: "aws",
      providerSmoke: true,
      providerSmokeTablePrefix: prefix,
    };
    const worker = {
      status: "ok",
      worker: "single",
      databaseMode: "aws",
      environment: "remote-provider",
      transport: "aws-due-poller",
      transcribe: "aws",
      providerSmoke: true,
      providerSmokeTablePrefix: prefix,
    };
    expect(() =>
      assertProviderSmokeHealth(web, worker, "captions", prefix),
    ).not.toThrow();
    expect(() =>
      assertProviderSmokeHealth(
        { ...web, databaseMode: "local" },
        worker,
        "captions",
        prefix,
      ),
    ).toThrow();
  });
});
