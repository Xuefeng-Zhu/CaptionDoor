import { describe, expect, it } from "vitest";
import {
  assertRootSmokeEnvironment,
  rootSmokeConfig,
} from "@captiondoor/domain";
const allowed = {
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
describe("explicit one-off local root smoke policy", () => {
  it("returns only fixed limits and never treats configuration as an AWS identity or paid reservation", () => {
    expect(assertRootSmokeEnvironment(allowed)).toEqual({
      scope: "captiondoor-root-verification-20261022",
      tablePrefix: "CaptionDoorProviderSmoke20261022",
      accountId: "256604024085",
      region: "us-east-1",
      maxAttemptSeconds: 30,
      maxSeconds: 90,
      maxMicrousd: 10000000,
      microusdPerSecond: 400,
    });
    expect(
      assertRootSmokeEnvironment({
        ...allowed,
        DYNAMODB_ENDPOINT: "http://localhost:8410/",
      }),
    ).toEqual(rootSmokeConfig);
  });
  it.each([
    ["NODE_ENV", "production"],
    ["CAPTIONDOOR_ENV", "remote-demo"],
    ["CAPTIONDOOR_DB_MODE", "aws"],
    ["AUTH_MODE", "oidc"],
    ["RING_MODE", "live"],
    ["CAPTIONDOOR_PROVIDER_SMOKE", "0"],
    ["CAPTIONDOOR_ROOT_SMOKE", "0"],
    ["CAPTIONDOOR_ROOT_SMOKE", ""],
    ["CAPTIONDOOR_ROOT_SMOKE_APPROVAL", "another-scope"],
    ["CAPTIONDOOR_SMOKE_APPROVAL", "ring-audio"],
    ["TRANSCRIBE_MODE", "fixture"],
    ["TRANSCRIBE_AWS_ACCOUNT_ID", "123456789012"],
    ["TRANSCRIBE_AWS_REGION", "eu-west-1"],
    ["APP_ORIGIN", "http://localhost:3410"],
    ["DYNAMODB_ENDPOINT", "https://dynamodb.us-east-1.amazonaws.com"],
    ["DYNAMODB_ENDPOINT", "http://127.0.0.1:8411"],
    ["DYNAMODB_ENDPOINT", "http://127.0.0.1:8410/?x=1"],
    ["DYNAMODB_ENDPOINT", "http://user:secret@127.0.0.1:8410"],
    ["DYNAMODB_ENDPOINT", ""],
    ["CAPTIONDOOR_RUNTIME_TABLE", "CaptionDoorRuntime"],
  ])("refuses unapproved %s without exposing values", (name, value) => {
    expect(() =>
      assertRootSmokeEnvironment({ ...allowed, [name]: value }),
    ).toThrow();
  });
  it("refuses another otherwise valid dedicated namespace so restart cannot reset this budget", () => {
    expect(() =>
      assertRootSmokeEnvironment({
        ...allowed,
        CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmokeAnotherConfig",
        CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmokeAnotherVisits",
        CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmokeAnotherRuntime",
      }),
    ).toThrowError(/exact approved local scope/);
  });
  it("does not allow environment values to raise fixed time or cost limits", () => {
    expect(
      assertRootSmokeEnvironment({
        ...allowed,
        CAPTIONDOOR_SMOKE_MAX_SECONDS: "99999",
        CAPTIONDOOR_SMOKE_BUDGET_USD: "99999",
      }),
    ).toEqual(rootSmokeConfig);
  });
});
