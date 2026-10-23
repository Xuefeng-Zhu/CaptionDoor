import { describe, expect, it } from "vitest";
import { assertProviderSmokeEnvironment } from "@captiondoor/domain";
const valid = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "development",
  CAPTIONDOOR_ENV: "local",
  CAPTIONDOOR_DB_MODE: "local",
  AUTH_MODE: "demo",
  RING_MODE: "playground",
  CAPTIONDOOR_PROVIDER_SMOKE: "1",
  APP_ORIGIN: "http://127.0.0.1:3410",
  CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmokeConfig",
  CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmokeVisits",
  CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmokeRuntime",
  ...overrides,
});
describe("explicit isolated local Playground bridge guard", () => {
  it("accepts only explicit dedicated local configuration and exposes no credential requirement", () => {
    expect(assertProviderSmokeEnvironment(valid())).toEqual({
      tablePrefix: "CaptionDoorProviderSmoke",
    });
    expect(
      assertProviderSmokeEnvironment(
        valid({
          NODE_ENV: "test",
          CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmokeTestConfig",
          CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmokeTestVisits",
          CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmokeTestRuntime",
        }),
      ),
    ).toEqual({ tablePrefix: "CaptionDoorProviderSmokeTest" });
  });
  it.each([
    { NODE_ENV: "production" },
    { CAPTIONDOOR_ENV: "remote-demo" },
    { CAPTIONDOOR_ENV: undefined },
    { CAPTIONDOOR_DB_MODE: "aws" },
    { CAPTIONDOOR_DB_MODE: undefined },
    { AUTH_MODE: "oidc" },
    { AUTH_MODE: undefined },
    { RING_MODE: "live" },
    { RING_MODE: "demo" },
    { CAPTIONDOOR_PROVIDER_SMOKE: undefined },
    { CAPTIONDOOR_PROVIDER_SMOKE: "true" },
    { APP_ORIGIN: "http://localhost:3410" },
    { APP_ORIGIN: "http://127.0.0.1:3410/" },
    { APP_ORIGIN: "https://127.0.0.1:3410" },
    { APP_ORIGIN: "http://127.0.0.1:3410/?token=fixture" },
    {
      CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorConfig",
      CAPTIONDOOR_VISITS_TABLE: "CaptionDoorVisits",
      CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorRuntime",
    },
    { CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmokeOtherRuntime" },
    { CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmokeConfig" },
    { CAPTIONDOOR_CONFIG_TABLE: undefined },
    { CAPTIONDOOR_CONFIG_TABLE: "OtherProviderSmokeConfig" },
  ])("fails closed for %j", (overrides) => {
    expect(() => assertProviderSmokeEnvironment(valid(overrides))).toThrowError(
      expect.objectContaining({ code: "PROVIDER_SMOKE_DISABLED", status: 403 }),
    );
  });
});
