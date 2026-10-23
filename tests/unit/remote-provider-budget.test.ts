import { describe, expect, it } from "vitest";
import {
  remoteProviderSmokeConfig,
  type RemoteProviderSmokeConfig,
} from "@captiondoor/domain";
import { validateRemoteProviderSmokeLedger } from "../../packages/db/src/remote-provider-budget-policy";

const config: RemoteProviderSmokeConfig = {
  ...remoteProviderSmokeConfig,
  allowRoot: false,
  previousSeconds: 30,
  previousMicrousd: 12_000,
  baselineSha256: "a".repeat(64),
};
function ledger(attempts = 1) {
  const reservedSeconds = config.previousSeconds + attempts * 30;
  return {
    PK: `PROVIDER_SMOKE#${config.scope}`,
    SK: "BUDGET",
    kind: "REMOTE_PROVIDER_SMOKE_BUDGET",
    ...config,
    householdId: "fictional-household",
    attempts,
    version: attempts,
    reservedSeconds,
    reservedMicrousd: reservedSeconds * 400,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
  };
}
describe("pure remote budget ledger validation, no database transport", () => {
  it("carries forward the explicit prior receipt before any new reservation", () => {
    expect(
      validateRemoteProviderSmokeLedger(
        undefined,
        "fictional-household",
        config,
      ),
    ).toEqual({
      attempts: 0,
      version: 0,
      reservedSeconds: 30,
      reservedMicrousd: 12_000,
    });
  });
  it("counts remote attempts on top of the prior scope budget", () => {
    expect(
      validateRemoteProviderSmokeLedger(
        ledger(2),
        "fictional-household",
        config,
      ),
    ).toEqual({
      attempts: 2,
      version: 2,
      reservedSeconds: 90,
      reservedMicrousd: 36_000,
    });
  });
  it.each([
    { attempts: 0, version: 0, reservedSeconds: 30, reservedMicrousd: 12_000 },
    { attempts: 3, version: 3, reservedSeconds: 120, reservedMicrousd: 48_000 },
    { attempts: 0.5 },
    { version: 2 },
    { reservedSeconds: 30 },
    { reservedMicrousd: 0 },
    { baselineSha256: "b".repeat(64) },
    { previousSeconds: 0, previousMicrousd: 0 },
    { PK: "PROVIDER_SMOKE#different-session" },
    { tablePrefix: "CaptionDoorOther" },
    { expiresAt: 1_800_000_000 },
    { updatedAt: 0 },
  ])("refuses resets, invalid counters and mutable baseline %j", (changed) => {
    expect(() =>
      validateRemoteProviderSmokeLedger(
        { ...ledger(), ...changed },
        "fictional-household",
        config,
      ),
    ).toThrow();
  });
  it("refuses a baseline replacement or different household", () => {
    expect(() =>
      validateRemoteProviderSmokeLedger(ledger(), "another-household", config),
    ).toThrow();
    expect(() =>
      validateRemoteProviderSmokeLedger(ledger(), "fictional-household", {
        ...config,
        previousSeconds: 0,
        previousMicrousd: 0,
        baselineSha256: "b".repeat(64),
      }),
    ).toThrow();
  });
});
