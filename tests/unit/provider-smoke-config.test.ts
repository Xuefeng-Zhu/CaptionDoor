import { describe, expect, it } from "vitest";
import {
  assertProviderSmokeHealth,
  parseProviderSmokeArgs,
  providerSmokeChildEnvironment,
  providerSmokePreflight,
  summarizeProviderCaptions,
  rootSmokeBudgetEvidence,
  rootSmokeReceiptEvidence,
} from "../../scripts/provider-smoke-config";

const base = {
  NODE_ENV: "development",
  CAPTIONDOOR_ENV: "local",
  CAPTIONDOOR_DB_MODE: "local",
  AUTH_MODE: "demo",
  RING_MODE: "playground",
  CAPTIONDOOR_PROVIDER_SMOKE: "1",
  APP_ORIGIN: "http://127.0.0.1:3410",
  DYNAMODB_ENDPOINT: "http://127.0.0.1:8410",
  CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmokeTestConfig",
  CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmokeTestVisits",
  CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmokeTestRuntime",
  CAPTIONDOOR_SMOKE_APPROVAL: "ring-audio",
  CAPTIONDOOR_SMOKE_DEVICE_ID: "fictional-selected-device",
  RING_PLAYGROUND_TOKEN: "fake-not-a-token",
  CREDENTIAL_ENCRYPTION_MODE: "development",
  DEV_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"),
  TRANSCRIBE_MODE: "fixture",
};
const aws = {
  ...base,
  CAPTIONDOOR_SMOKE_APPROVAL: "captions",
  TRANSCRIBE_MODE: "aws",
  TRANSCRIBE_AWS_ACCOUNT_ID: "123456789012",
  TRANSCRIBE_AWS_REGION: "us-east-1",
  AWS_PROFILE: "fictional-temporary-profile",
};
function health() {
  return {
    web: {
      status: "ok",
      database: "DynamoDB",
      databaseMode: "local",
      environment: "local",
      authMode: "demo",
      ringMode: "playground",
      transcribeMode: "fixture",
      providerSmoke: true,
      providerSmokeTablePrefix: "CaptionDoorProviderSmokeTest",
    },
    worker: {
      status: "ok",
      worker: "single",
      databaseMode: "local",
      environment: "local",
      transport: "local-due-poller",
      transcribe: "fixture",
      providerSmoke: true,
      providerSmokeTablePrefix: "CaptionDoorProviderSmokeTest",
    },
  };
}
describe("provider smoke zero-network preflight", () => {
  it("defaults to preflight and audio-only, never treats configuration as observed identity", () => {
    expect(parseProviderSmokeArgs([])).toEqual({
      help: false,
      run: false,
      stage: "ring-audio",
    });
    expect(providerSmokePreflight(base, "ring-audio")).toMatchObject({
      result: "READY",
      providerRequestsMade: false,
      identityVerified: false,
    });
    expect(providerSmokePreflight(aws, "captions").result).toBe("READY");
  });
  it("refuses missing configuration without leaking supplied secrets or URLs", () => {
    const result = providerSmokePreflight(
      {
        RING_PLAYGROUND_TOKEN: "SECRET_VALUE",
        DYNAMODB_ENDPOINT: "https://private:secret@example.invalid",
      },
      "captions",
    );
    expect(result.result).toBe("BLOCKED");
    expect(result.blockers).toContain(
      "EXPLICIT_TEMPORARY_NON_ROOT_CREDENTIAL_SOURCE_REQUIRED",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET_VALUE|private|example.invalid/,
    );
  });
  it.each([
    ["NODE_ENV", "production"],
    ["CAPTIONDOOR_DB_MODE", "aws"],
    ["AUTH_MODE", "cognito"],
    ["RING_MODE", "live"],
    ["APP_ORIGIN", "http://localhost:3410"],
    ["CAPTIONDOOR_RUNTIME_TABLE", "CaptionDoorRuntime"],
    ["CAPTIONDOOR_PROVIDER_SMOKE", "0"],
  ])("blocks unsafe %s", (key, value) => {
    expect(
      providerSmokePreflight({ ...base, [key]: value }, "ring-audio").result,
    ).toBe("BLOCKED");
  });
  it("requires stage-specific approval and never enables AWS in audio-only mode", () => {
    expect(
      providerSmokePreflight(
        { ...base, CAPTIONDOOR_SMOKE_APPROVAL: "captions" },
        "ring-audio",
      ).blockers,
    ).toContain("ACTION_SPECIFIC_APPROVAL_REQUIRED");
    expect(providerSmokePreflight(aws, "ring-audio").blockers).toContain(
      "STAGE_TRANSCRIPTION_MODE_MISMATCH",
    );
  });
  it("requires an explicit credential source, complete temporary credentials and dedicated AWS config", () => {
    expect(
      providerSmokePreflight({ ...aws, AWS_PROFILE: "" }, "captions").result,
    ).toBe("BLOCKED");
    expect(
      providerSmokePreflight(
        { ...aws, AWS_ACCESS_KEY_ID: "temporary-id" },
        "captions",
      ).blockers,
    ).toContain("INCOMPLETE_TEMPORARY_CREDENTIAL_ENVIRONMENT");
    expect(
      providerSmokePreflight(
        { ...aws, AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING: "http://127.0.0.1" },
        "captions",
      ).result,
    ).toBe("BLOCKED");
    expect(
      providerSmokePreflight({ ...aws, TRANSCRIBE_AWS_REGION: "" }, "captions")
        .result,
    ).toBe("BLOCKED");
  });
  it("accepts complete temporary environment credentials only as presence, not identity proof", () => {
    expect(
      providerSmokePreflight(
        {
          ...aws,
          AWS_PROFILE: "",
          AWS_ACCESS_KEY_ID: "fake-temporary",
          AWS_SECRET_ACCESS_KEY: "fake-secret",
          AWS_SESSION_TOKEN: "fake-session",
        },
        "captions",
      ),
    ).toMatchObject({ result: "READY", identityVerified: false });
  });
  it("strips credential sources, token, key, endpoints and debug settings from the browser child", () => {
    const child = providerSmokeChildEnvironment(
      {
        ...aws,
        HOME: "/fictional-home",
        AWS_ACCESS_KEY_ID: "SECRET",
        AWS_SECRET_ACCESS_KEY: "SECRET",
        AWS_SESSION_TOKEN: "SECRET",
        DEBUG: "pw:api",
        NODE_OPTIONS: "--inspect",
        AWS_SHARED_CREDENTIALS_FILE: "/secret-file",
        RING_CLIENT_SECRET: "SECRET",
      },
      "captions",
      "run-id",
    );
    expect(child.HOME).toBe("/fictional-home");
    expect(child.PLAYWRIGHT_NO_COPY_PROMPT).toBe("1");
    expect(child.TRANSCRIBE_AWS_ACCOUNT_ID).toBe("123456789012");
    for (const key of [
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_SHARED_CREDENTIALS_FILE",
      "RING_CLIENT_SECRET",
      "RING_PLAYGROUND_TOKEN",
      "DEV_CREDENTIAL_KEY",
      "DYNAMODB_ENDPOINT",
      "DEBUG",
      "NODE_OPTIONS",
    ])
      expect(child[key]).toBeUndefined();
  });
  it("requires matching actual table prefixes and server modes before provider metadata", () => {
    const { web, worker } = health();
    expect(() =>
      assertProviderSmokeHealth(
        web,
        worker,
        "ring-audio",
        "CaptionDoorProviderSmokeTest",
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderSmokeHealth(
        web,
        {
          ...worker,
          providerSmokeTablePrefix: "CaptionDoorProviderSmokeOther",
        },
        "ring-audio",
        "CaptionDoorProviderSmokeTest",
      ),
    ).toThrow();
    expect(() =>
      assertProviderSmokeHealth(
        { ...web, providerSmoke: false },
        worker,
        "ring-audio",
        "CaptionDoorProviderSmokeTest",
      ),
    ).toThrow();
    expect(() =>
      assertProviderSmokeHealth(
        web,
        worker,
        "captions",
        "CaptionDoorProviderSmokeTest",
      ),
    ).toThrow();
  });
  it("rejects unknown arguments rather than accepting implicit provider actions", () => {
    for (const args of [
      ["--reset"],
      ["--stage", "live"],
      ["--stage"],
      ["--run", "--run"],
    ])
      expect(() => parseProviderSmokeArgs(args)).toThrow(
        "INVALID_SMOKE_ARGUMENTS",
      );
    expect(parseProviderSmokeArgs(["--help"])).toEqual({
      help: true,
      run: false,
      stage: "ring-audio",
    });
  });
});

describe("provider caption evidence", () => {
  const final = {
    id: "media:result",
    kind: "caption" as const,
    createdAt: 1,
    expiresAt: 100,
    text: "Fictional unit caption.",
    source: "AWS" as const,
    isPartial: false,
    mediaSessionId: "media",
    resultId: "result",
  };
  it("counts only nonempty AWS finals for the exact media session", () => {
    expect(
      summarizeProviderCaptions(
        [
          final,
          { ...final, isPartial: true },
          { ...final, mediaSessionId: "other" },
          { ...final, text: " " },
          { ...final, resultId: undefined },
        ],
        "media",
      ),
    ).toEqual({ fixtureCaptions: 0, awsFinals: 1, uniqueAwsFinals: 1 });
  });
  it("exposes fixture contamination and duplicate final identities as counts", () => {
    expect(
      summarizeProviderCaptions(
        [final, { ...final }, { ...final, source: "FIXTURE" }],
        "media",
      ),
    ).toEqual({ fixtureCaptions: 1, awsFinals: 2, uniqueAwsFinals: 1 });
  });
  it("never includes caption content in the returned evidence", () => {
    expect(
      JSON.stringify(summarizeProviderCaptions([final], "media")),
    ).not.toContain(final.text);
  });
});

const rootEnv = {
  ...aws,
  TRANSCRIBE_AWS_ACCOUNT_ID: "256604024085",
  CAPTIONDOOR_ROOT_SMOKE: "1",
  CAPTIONDOOR_ROOT_SMOKE_APPROVAL: "captiondoor-root-verification-20261022",
  CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmoke20261022Config",
  CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmoke20261022Visits",
  CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmoke20261022Runtime",
};
function budget(reservedSeconds = 0) {
  return {
    scope: "captiondoor-root-verification-20261022",
    accountId: "256604024085",
    region: "us-east-1",
    tablePrefix: "CaptionDoorProviderSmoke20261022",
    maxAttemptSeconds: 30,
    maxSeconds: 90,
    maxMicrousd: 10000000,
    microusdPerSecond: 400,
    reservedSeconds,
    reservedMicrousd: reservedSeconds * 400,
    cumulativeEstimatedMicrousd: reservedSeconds * 400,
    attempts: reservedSeconds / 30,
    remainingSeconds: 90 - reservedSeconds,
    remainingMicrousd: 10000000 - reservedSeconds * 400,
    conservativeReservation: true,
    householdId: "fictional-private-household",
  };
}
describe("explicit root-only smoke preparation", () => {
  it("never implicitly enables root and keeps preflight identity unverified", () => {
    expect(providerSmokePreflight(aws, "captions")).toMatchObject({
      result: "READY",
      rootSmokeRequested: false,
      identityVerified: false,
    });
    expect(providerSmokePreflight(rootEnv, "captions")).toMatchObject({
      result: "READY",
      rootSmokeRequested: true,
      identityVerified: false,
      providerRequestsMade: false,
    });
    expect(providerSmokePreflight(rootEnv, "ring-audio").result).toBe(
      "BLOCKED",
    );
  });
  it.each([
    ["CAPTIONDOOR_ROOT_SMOKE", "0"],
    ["CAPTIONDOOR_ROOT_SMOKE_APPROVAL", "different-scope"],
    ["TRANSCRIBE_AWS_ACCOUNT_ID", "123456789012"],
    ["TRANSCRIBE_AWS_REGION", "us-west-2"],
    ["CAPTIONDOOR_CONFIG_TABLE", "CaptionDoorProviderSmokeOtherConfig"],
    ["NODE_ENV", "production"],
  ])("blocks incorrect explicit root config %s", (key, value) => {
    expect(
      providerSmokePreflight({ ...rootEnv, [key]: value }, "captions").blockers,
    ).toContain("EXPLICIT_FIXED_SCOPE_ROOT_SMOKE_APPROVAL_REQUIRED");
  });
  it("passes only nonsecret root markers and validated Local endpoint to the browser", () => {
    const child = providerSmokeChildEnvironment(
      rootEnv,
      "captions",
      "fake-run",
    );
    expect(child.CAPTIONDOOR_ROOT_SMOKE).toBe("1");
    expect(child.CAPTIONDOOR_ROOT_SMOKE_APPROVAL).toBe(
      rootEnv.CAPTIONDOOR_ROOT_SMOKE_APPROVAL,
    );
    expect(child.DYNAMODB_ENDPOINT).toBe("http://127.0.0.1:8410");
    expect(child.AWS_PROFILE).toBeUndefined();
    expect(child.RING_PLAYGROUND_TOKEN).toBeUndefined();
    expect(child.DEV_CREDENTIAL_KEY).toBeUndefined();
  });
  it("validates before/after conservative reservations and omits household and account details", () => {
    const evidence = rootSmokeBudgetEvidence(budget(60), rootEnv, true);
    expect(evidence).toMatchObject({
      maxSeconds: 90,
      maxAttemptSeconds: 30,
      reservedSeconds: 60,
      cumulativeEstimatedMicrousd: 24000,
      remainingSeconds: 30,
      attempts: 2,
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /fictional-private-household|256604024085/,
    );
    expect(() => rootSmokeBudgetEvidence(budget(90), rootEnv, true)).toThrow(
      "ROOT_SMOKE_BUDGET_EXHAUSTED",
    );
    expect(
      rootSmokeBudgetEvidence(budget(90), rootEnv, false).reservedSeconds,
    ).toBe(90);
  });
  it.each([
    { reservedSeconds: 91 },
    { reservedSeconds: -30 },
    { reservedSeconds: 15 },
    { reservedMicrousd: 1 },
    { cumulativeEstimatedMicrousd: 1 },
    { attempts: 1 },
    { remainingSeconds: 89 },
    { remainingMicrousd: 1 },
    { scope: "other" },
    { accountId: "123456789012" },
    { region: "us-west-2" },
    { conservativeReservation: false },
  ])("refuses malformed/corrupt budget summaries %j", (changed) => {
    expect(() =>
      rootSmokeBudgetEvidence({ ...budget(), ...changed }, rootEnv, true),
    ).toThrow("ROOT_SMOKE_BUDGET_INVALID");
  });
  it("requires an authenticated worker receipt before recording ROOT or NON_ROOT identity", () => {
    const now = 100000;
    const before = rootSmokeBudgetEvidence(budget(), rootEnv, true);
    const receipt = {
      scope: rootEnv.CAPTIONDOOR_ROOT_SMOKE_APPROVAL,
      attemptId: "private-attempt",
      maxSeconds: 30,
      expiresAt: now + 25000,
      cumulativeReservedSeconds: 30,
      cumulativeEstimatedMicrousd: 12000,
      identity: "ROOT",
    };
    expect(
      rootSmokeReceiptEvidence(receipt, before, rootEnv, now),
    ).toMatchObject({ identity: "ROOT", cumulativeReservedSeconds: 30 });
    expect(
      rootSmokeReceiptEvidence(
        { ...receipt, identity: "NON_ROOT" },
        before,
        rootEnv,
        now,
      ).identity,
    ).toBe("NON_ROOT");
    for (const changed of [
      { identity: "UNVERIFIED" },
      { scope: "other" },
      { expiresAt: now },
      { expiresAt: now + 31000 },
      { cumulativeReservedSeconds: 60 },
      { cumulativeEstimatedMicrousd: 1 },
    ])
      expect(() =>
        rootSmokeReceiptEvidence(
          { ...receipt, ...changed },
          before,
          rootEnv,
          now,
        ),
      ).toThrow("ROOT_SMOKE_CAPTURE_RECEIPT_INVALID");
    expect(
      JSON.stringify(rootSmokeReceiptEvidence(receipt, before, rootEnv, now)),
    ).not.toContain("private-attempt");
    const exhausted = rootSmokeBudgetEvidence(budget(90), rootEnv, false);
    expect(() =>
      rootSmokeReceiptEvidence(
        {
          ...receipt,
          cumulativeReservedSeconds: 120,
          cumulativeEstimatedMicrousd: 48000,
        },
        exhausted,
        rootEnv,
        now,
      ),
    ).toThrow("ROOT_SMOKE_CAPTURE_RECEIPT_INVALID");
    expect(() =>
      rootSmokeReceiptEvidence(
        receipt,
        { ...before, scope: "other" },
        rootEnv,
        now,
      ),
    ).toThrow("ROOT_SMOKE_CAPTURE_RECEIPT_INVALID");
  });
});
