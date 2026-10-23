import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armRemoteProviderDeadline,
  assertRemoteProviderPermit,
  issueRemoteProviderPermit,
  recordRemoteProviderIdentity,
  remoteProviderSmokeReceipt,
  type RemoteProviderPermit,
  type RemoteProviderSmokeReservation,
} from "../../packages/integrations/src/audio/remote-provider-permit";

const env = {
  NODE_ENV: "development",
  CAPTIONDOOR_ENV: "remote-provider",
  CAPTIONDOOR_DB_MODE: "aws",
  AUTH_MODE: "demo",
  RING_MODE: "playground",
  TRANSCRIBE_MODE: "aws",
  APP_ORIGIN: "http://127.0.0.1:3410",
  CAPTIONDOOR_PROVIDER_SMOKE: "1",
  CAPTIONDOOR_REMOTE_PROVIDER_SMOKE: "1",
  CAPTIONDOOR_REMOTE_PROVIDER_WRITES_APPROVAL:
    "captiondoor-remote-provider-verification-20261023",
  CAPTIONDOOR_REMOTE_PROVIDER_CLOUD_COPY_APPROVAL:
    "captiondoor-remote-provider-verification-20261023",
  CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL:
    "captiondoor-remote-provider-verification-20261023",
  CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL:
    "captiondoor-remote-provider-verification-20261023",
  CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS: "30",
  CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD: "12000",
  CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: "a".repeat(64),
  CAPTIONDOOR_SMOKE_APPROVAL: "captions",
  AWS_ACCOUNT_ID: "256604024085",
  AWS_REGION: "us-east-1",
  TRANSCRIBE_AWS_ACCOUNT_ID: "256604024085",
  TRANSCRIBE_AWS_REGION: "us-east-1",
  CAPTIONDOOR_AWS_TABLE_PREFIX: "CaptionDoorDevProviderSmoke20261023",
  CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorDevProviderSmoke20261023Config",
  CAPTIONDOOR_VISITS_TABLE: "CaptionDoorDevProviderSmoke20261023Visits",
  CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorDevProviderSmoke20261023Runtime",
};
function reservation(): RemoteProviderSmokeReservation {
  return {
    attemptId: "12345678-1234-4234-8234-123456789012",
    scope: env.CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL,
    accountId: env.AWS_ACCOUNT_ID,
    region: env.AWS_REGION,
    tablePrefix: env.CAPTIONDOOR_AWS_TABLE_PREFIX,
    previousSeconds: 30,
    previousMicrousd: 12_000,
    baselineSha256: env.CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256,
    householdId: "fictional-household",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    maxSeconds: 30,
    reservedSeconds: 30,
    cumulativeReservedSeconds: 60,
    cumulativeEstimatedMicrousd: 24_000,
  };
}
afterEach(() => vi.useRealTimers());
describe("in-process remote provider permits", () => {
  it("refuses a structural forgery and receipt before an armed verified nonroot identity", () => {
    const row = reservation();
    expect(() =>
      assertRemoteProviderPermit(row as RemoteProviderPermit, row, env),
    ).toThrow();
    const permit = issueRemoteProviderPermit(row, env);
    expect(Object.isFrozen(permit)).toBe(true);
    expect(() =>
      recordRemoteProviderIdentity(permit, "NON_ROOT", env),
    ).toThrow();
    expect(() => remoteProviderSmokeReceipt(permit, env)).toThrow();
    const cancel = armRemoteProviderDeadline(permit, vi.fn(), env);
    expect(() => remoteProviderSmokeReceipt(permit, env)).toThrow();
    expect(() => recordRemoteProviderIdentity(permit, "ROOT", env)).toThrow();
    recordRemoteProviderIdentity(permit, "NON_ROOT", env);
    expect(remoteProviderSmokeReceipt(permit, env)).toMatchObject({
      identity: "NON_ROOT",
      previousSeconds: 30,
      cumulativeReservedSeconds: 60,
    });
    cancel();
  });
  it("permits a truthful ROOT receipt only in the captured explicit root-approved scope", () => {
    const approved = {
      ...env,
      CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL:
        env.CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL,
    };
    const permit = issueRemoteProviderPermit(reservation(), approved),
      cancel = armRemoteProviderDeadline(permit, vi.fn(), approved);
    recordRemoteProviderIdentity(permit, "ROOT", approved);
    expect(remoteProviderSmokeReceipt(permit, approved)).toMatchObject({
      identity: "ROOT",
    });
    expect(() => assertRemoteProviderPermit(permit, permit, env)).toThrow();
    expect(() => remoteProviderSmokeReceipt(permit, env)).toThrow();
    cancel();
  });
  it("cannot expand an already issued nonroot permit by adding a root approval later", () => {
    const permit = issueRemoteProviderPermit(reservation(), env),
      cancel = armRemoteProviderDeadline(permit, vi.fn(), env);
    expect(() =>
      recordRemoteProviderIdentity(permit, "ROOT", {
        ...env,
        CAPTIONDOOR_REMOTE_PROVIDER_ROOT_APPROVAL:
          env.CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL,
      }),
    ).toThrow();
    cancel();
  });
  it.each([
    { previousSeconds: 0, previousMicrousd: 0 },
    { baselineSha256: "b".repeat(64) },
    { cumulativeReservedSeconds: 30, cumulativeEstimatedMicrousd: 12_000 },
    { cumulativeReservedSeconds: 120, cumulativeEstimatedMicrousd: 48_000 },
    { cumulativeEstimatedMicrousd: 0 },
    { maxSeconds: 90 },
    { tablePrefix: "CaptionDoorOther" },
    { accountId: "999999999999" },
  ])("refuses invalid scope or carried budget %j", (changed) => {
    expect(() =>
      issueRemoteProviderPermit({ ...reservation(), ...changed }, env),
    ).toThrow();
  });
  it("fails closed when baseline evidence, remote approval or region changes", () => {
    const row = reservation(),
      permit = issueRemoteProviderPermit(row, env);
    expect(() =>
      assertRemoteProviderPermit(permit, { ...row, region: "us-west-2" }, env),
    ).toThrow();
    expect(() =>
      assertRemoteProviderPermit(permit, row, {
        ...env,
        CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256: undefined,
      }),
    ).toThrow();
    expect(() =>
      assertRemoteProviderPermit(permit, row, {
        ...env,
        CAPTIONDOOR_REMOTE_PROVIDER_SMOKE_APPROVAL: "",
      }),
    ).toThrow();
  });
  it("arms once and ends at the earlier authorization deadline without browser cleanup", async () => {
    vi.useFakeTimers();
    const row = { ...reservation(), expiresAt: Date.now() + 1_000 },
      permit = issueRemoteProviderPermit(row, env),
      stopped = vi.fn();
    armRemoteProviderDeadline(permit, stopped, env);
    expect(() => armRemoteProviderDeadline(permit, stopped, env)).toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(() => assertRemoteProviderPermit(permit, row, env)).toThrow();
  });
});
