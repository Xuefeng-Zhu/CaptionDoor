import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armRootSmokeDeadline,
  assertRootSmokePermit,
  issueRootSmokePermit,
  rootSmokeReceipt,
  type RootSmokePermit,
  type RootSmokeReservation,
} from "../../packages/integrations/src/audio/root-smoke-permit";
const env = {
  NODE_ENV: "development",
  CAPTIONDOOR_ENV: "local",
  CAPTIONDOOR_DB_MODE: "local",
  AUTH_MODE: "demo",
  RING_MODE: "playground",
  CAPTIONDOOR_PROVIDER_SMOKE: "1",
  APP_ORIGIN: "http://127.0.0.1:3410",
  DYNAMODB_ENDPOINT: "http://127.0.0.1:8410",
  CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmoke20261022Config",
  CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmoke20261022Visits",
  CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmoke20261022Runtime",
  CAPTIONDOOR_ROOT_SMOKE: "1",
  CAPTIONDOOR_ROOT_SMOKE_APPROVAL: "captiondoor-root-verification-20261022",
  CAPTIONDOOR_SMOKE_APPROVAL: "captions",
  TRANSCRIBE_MODE: "aws",
  TRANSCRIBE_AWS_ACCOUNT_ID: "256604024085",
  TRANSCRIBE_AWS_REGION: "us-east-1",
};
function reservation(): RootSmokeReservation {
  return {
    attemptId: "12345678-1234-4234-8234-123456789012",
    scope: env.CAPTIONDOOR_ROOT_SMOKE_APPROVAL,
    accountId: env.TRANSCRIBE_AWS_ACCOUNT_ID,
    region: env.TRANSCRIBE_AWS_REGION,
    householdId: "fictional-household",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    maxSeconds: 30,
    reservedSeconds: 30,
    cumulativeReservedSeconds: 30,
    cumulativeEstimatedMicrousd: 12_000,
    tablePrefix: "CaptionDoorProviderSmoke20261022",
  };
}
afterEach(() => vi.useRealTimers());
describe("explicit in-process root smoke permits", () => {
  it("rejects a structural forgery and cannot issue provider proof before verified identity", () => {
    const row = reservation();
    expect(() =>
      assertRootSmokePermit(row as RootSmokePermit, row, env),
    ).toThrow(/permit/);
    const permit = issueRootSmokePermit(row, env);
    expect(() => rootSmokeReceipt(permit)).toThrow(/permit/);
    expect(Object.isFrozen(permit)).toBe(true);
  });
  it.each([
    { cumulativeReservedSeconds: 120, cumulativeEstimatedMicrousd: 48_000 },
    { cumulativeEstimatedMicrousd: 0 },
    { maxSeconds: 90 },
    { accountId: "999999999999" },
    { tablePrefix: "CaptionDoorProviderSmokeOther" },
  ])("rejects invalid limits or scope %j", (bad) => {
    expect(() =>
      issueRootSmokePermit({ ...reservation(), ...bad }, env),
    ).toThrow();
  });
  it("rechecks current account, Region and explicit local policy", () => {
    const row = reservation(),
      permit = issueRootSmokePermit(row, env);
    expect(() =>
      assertRootSmokePermit(permit, { ...row, region: "us-west-2" }, env),
    ).toThrow();
    expect(() =>
      assertRootSmokePermit(permit, row, { ...env, NODE_ENV: "production" }),
    ).toThrow();
    expect(() =>
      assertRootSmokePermit(permit, row, {
        ...env,
        CAPTIONDOOR_ROOT_SMOKE: "0",
      }),
    ).toThrow();
  });
  it("arms once, respects an earlier lease deadline and expires without any browser action", async () => {
    vi.useFakeTimers();
    const row = { ...reservation(), expiresAt: Date.now() + 1000 },
      permit = issueRootSmokePermit(row, env),
      stopped = vi.fn();
    armRootSmokeDeadline(permit, stopped, env);
    expect(() => armRootSmokeDeadline(permit, stopped, env)).toThrow(/permit/);
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(() => assertRootSmokePermit(permit, row, env)).toThrow(/permit/);
  });
});
