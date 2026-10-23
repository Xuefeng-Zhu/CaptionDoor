import { describe, expect, it, vi } from "vitest";
import {
  buildProviderSessionBaseEnvironment,
  buildProviderSessionEnvironment,
  providerSessionMetadata,
  ProviderSessionConfigError,
  type ProviderSessionOptions,
} from "../../scripts/provider-session-config";
import {
  providerSmokeChildEnvironment,
  providerSmokePreflight,
} from "../../scripts/provider-smoke-config";
import {
  assertRootSmokeEnvironment,
  rootSmokeConfig,
} from "@captiondoor/domain";

const secrets = {
  token: "fictional-playground-token-never-authorized",
  keyBase64: Buffer.alloc(32, 17).toString("base64"),
};
function options(
  overrides: Partial<ProviderSessionOptions> = {},
): ProviderSessionOptions {
  return {
    inheritedEnv: { PATH: "/fictional/bin", HOME: "/fictional/home" },
    secrets: { ...secrets },
    cleanupApproved: true,
    ...overrides,
  };
}
function category(run: () => unknown): string {
  try {
    run();
    throw new Error("Expected a configuration refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderSessionConfigError);
    expect(String(error)).not.toContain(secrets.token);
    expect(String(error)).not.toContain(secrets.keyBase64);
    return (error as ProviderSessionConfigError).category;
  }
}

describe("pure fixed-scope local provider session configuration", () => {
  it("prepares Local setup without fake secrets, keys or device selection", () => {
    const env = buildProviderSessionBaseEnvironment({
      inheritedEnv: { PATH: "/fictional/bin", HOME: "/fictional/home" },
      cleanupApproved: true,
    });
    expect(assertRootSmokeEnvironment(env)).toEqual(rootSmokeConfig);
    expect(env.RING_PLAYGROUND_TOKEN).toBeUndefined();
    expect(env.DEV_CREDENTIAL_KEY).toBeUndefined();
    expect(env.CAPTIONDOOR_SMOKE_DEVICE_ID).toBeUndefined();
    expect(providerSmokePreflight(env, "captions")).toMatchObject({
      result: "BLOCKED",
      blockers: [
        "SELECTED_PLAYGROUND_DEVICE_REQUIRED",
        "APPROVED_PLAYGROUND_TOKEN_REQUIRED",
        "APPROVED_LOCAL_CREDENTIAL_ENCRYPTION_REQUIRED",
      ],
      providerRequestsMade: false,
      identityVerified: false,
    });
    expect(
      category(() =>
        buildProviderSessionBaseEnvironment({
          inheritedEnv: {},
          cleanupApproved: false,
        }),
      ),
    ).toBe("CLEANUP_APPROVAL_REQUIRED");
  });

  it.each(["RING_PLAYGROUND_TOKEN", "DEV_CREDENTIAL_KEY"])(
    "refuses stale %s in pre-token Local setup",
    (name) => {
      expect(
        category(() =>
          buildProviderSessionBaseEnvironment({
            inheritedEnv: { [name]: "stale-fictional-secret" },
            cleanupApproved: true,
          }),
        ),
      ).toBe("INHERITED_SECRET_CONFLICT");
    },
  );

  it("keeps the approved October 22 scope, profile, account and Local namespace without resetting them", () => {
    const env = buildProviderSessionEnvironment(options());
    expect(assertRootSmokeEnvironment(env)).toEqual(rootSmokeConfig);
    expect(env).toMatchObject({
      AWS_PROFILE: "tally",
      AWS_DEFAULT_PROFILE: "tally",
      AWS_REGION: "us-east-1",
      AWS_ACCOUNT_ID: "256604024085",
      CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmoke20261022Config",
      CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmoke20261022Visits",
      CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmoke20261022Runtime",
      APP_ORIGIN: "http://127.0.0.1:3410",
      WORKER_HOST: "127.0.0.1",
      WORKER_PORT: "3411",
      DYNAMODB_ENDPOINT: "http://127.0.0.1:8410",
      TRANSCRIBE_MODE: "aws",
      RING_MODE: "playground",
      CREDENTIAL_ENCRYPTION_MODE: "development",
      RING_PLAYGROUND_TOKEN: secrets.token,
      DEV_CREDENTIAL_KEY: secrets.keyBase64,
    });
    expect(providerSessionMetadata).toMatchObject({
      scope: "captiondoor-root-verification-20261022",
      tablePrefix: "CaptionDoorProviderSmoke20261022",
      maxAttemptSeconds: 30,
      maxSeconds: 90,
      maxMicrousd: 10_000_000,
    });
    expect(Object.isFrozen(providerSessionMetadata)).toBe(true);
    expect(JSON.stringify(providerSessionMetadata)).not.toMatch(
      new RegExp(`${secrets.token}|${secrets.keyBase64}`),
    );
  });

  it("requires the separate cleanup approval before accepting even fictional prompt values", () => {
    expect(
      category(() =>
        buildProviderSessionEnvironment(options({ cleanupApproved: false })),
      ),
    ).toBe("CLEANUP_APPROVAL_REQUIRED");
  });

  it("allows setup before device selection but makes the ordinary preflight block execution", () => {
    const env = buildProviderSessionEnvironment(options());
    expect(providerSmokePreflight(env, "captions")).toMatchObject({
      result: "BLOCKED",
      blockers: ["SELECTED_PLAYGROUND_DEVICE_REQUIRED"],
      providerRequestsMade: false,
      identityVerified: false,
    });
    const selected = buildProviderSessionEnvironment(
      options({ deviceId: "fictional-selected-device" }),
    );
    expect(providerSmokePreflight(selected, "captions")).toMatchObject({
      result: "READY",
      blockers: [],
      providerRequestsMade: false,
      identityVerified: false,
    });
  });

  it.each(["", " ", "token\nvalue", "token value", "token\u0000value"])(
    "rejects invalid prompt tokens without displaying the input (%#)",
    (token) => {
      expect(
        category(() =>
          buildProviderSessionEnvironment(
            options({ secrets: { ...secrets, token } }),
          ),
        ),
      ).toBe("PROMPT_TOKEN_REQUIRED");
    },
  );

  it.each([
    "",
    Buffer.alloc(31, 17).toString("base64"),
    Buffer.alloc(33, 17).toString("base64"),
    `${secrets.keyBase64}\n`,
    `${secrets.keyBase64.slice(0, -2)}R=`,
  ])("rejects invalid or noncanonical 32-byte keys (%#)", (keyBase64) => {
    expect(
      category(() =>
        buildProviderSessionEnvironment(
          options({ secrets: { ...secrets, keyBase64 } }),
        ),
      ),
    ).toBe("PROMPT_ENCRYPTION_KEY_REQUIRED");
  });

  it.each(["", " ", " device", "device\n", "a".repeat(257)])(
    "rejects an invalid explicit device (%#)",
    (deviceId) => {
      expect(
        category(() => buildProviderSessionEnvironment(options({ deviceId }))),
      ).toBe("SELECTED_DEVICE_INVALID");
    },
  );

  it.each([
    ["NODE_ENV", "production"],
    ["CAPTIONDOOR_DB_MODE", "aws"],
    ["CAPTIONDOOR_ENV", "remote-demo"],
    ["AUTH_MODE", "oidc"],
    ["RING_MODE", "live"],
    ["TRANSCRIBE_MODE", "fixture"],
    ["CAPTIONDOOR_CONFIG_TABLE", "CaptionDoorConfig"],
    ["CAPTIONDOOR_VISITS_TABLE", "CaptionDoorOtherVisits"],
    ["CAPTIONDOOR_RUNTIME_TABLE", "CaptionDoorProviderSmoke20261023Runtime"],
    ["APP_ORIGIN", "https://example.invalid"],
    ["WS_PUBLIC_URL", "ws://localhost:3411/ws"],
    ["WORKER_HOST", "0.0.0.0"],
    ["WORKER_PORT", "3412"],
    ["DYNAMODB_ENDPOINT", "http://127.0.0.1:8000"],
    ["AWS_ACCOUNT_ID", "123456789012"],
    ["AWS_REGION", "eu-west-1"],
    ["AWS_DEFAULT_REGION", "eu-west-1"],
    ["AWS_PROFILE", "unapproved-profile"],
    ["AWS_DEFAULT_PROFILE", "unapproved-profile"],
    ["TRANSCRIBE_AWS_ACCOUNT_ID", "123456789012"],
    ["TRANSCRIBE_AWS_REGION", "eu-west-1"],
    ["CAPTIONDOOR_ROOT_SMOKE", "0"],
    [
      "CAPTIONDOOR_ROOT_SMOKE_APPROVAL",
      "captiondoor-root-verification-20261023",
    ],
    ["CAPTIONDOOR_SMOKE_APPROVAL", "ring-audio"],
    ["CREDENTIAL_ENCRYPTION_MODE", "kms"],
    ["CAPTIONDOOR_SMOKE_DEVICE_ID", "silently-inherited-device"],
  ])("refuses a conflicting inherited scope %s", (name, value) => {
    expect(
      category(() =>
        buildProviderSessionEnvironment(
          options({ inheritedEnv: { [name]: value } }),
        ),
      ),
    ).toBe("INHERITED_SCOPE_CONFLICT");
  });

  it.each([
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_ENDPOINT_URL_STS",
    "AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_LOGIN_CACHE_DIRECTORY",
    "CAPTIONDOOR_AWS_TABLE_PREFIX",
    "SQS_QUEUE_URL",
  ])(
    "refuses inherited endpoints or replacement credential files: %s",
    (name) => {
      expect(
        category(() =>
          buildProviderSessionEnvironment(
            options({ inheritedEnv: { [name]: "fictional-conflict" } }),
          ),
        ),
      ).toBe("INHERITED_ENDPOINT_OR_CREDENTIAL_SOURCE");
    },
  );

  it.each(["RING_PLAYGROUND_TOKEN", "DEV_CREDENTIAL_KEY"])(
    "refuses conflicting stale secret %s",
    (name) => {
      expect(
        category(() =>
          buildProviderSessionEnvironment(
            options({ inheritedEnv: { [name]: "stale-fictional-secret" } }),
          ),
        ),
      ).toBe("INHERITED_SECRET_CONFLICT");
    },
  );

  it("accepts exact inherited scope/secret matches, without mutating caller input", () => {
    const original = buildProviderSessionEnvironment(
      options({ deviceId: "fictional-device" }),
    );
    const before = { ...original };
    const env = buildProviderSessionEnvironment(
      options({ inheritedEnv: original, deviceId: "fictional-device" }),
    );
    expect(env).toEqual(before);
    expect(env).not.toBe(original);
    expect(original).toEqual(before);
  });

  it("drops arbitrary inherited secrets, debug, browser and provider launch settings", () => {
    const privateEnv = {
      ...options().inheritedEnv,
      AWS_ACCESS_KEY_ID: "fictional-static-id",
      AWS_SECRET_ACCESS_KEY: "fictional-static-secret",
      AWS_SESSION_TOKEN: "fictional-session",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/fictional/token",
      AWS_ROLE_ARN: "fictional-role",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://example.invalid",
      RING_CLIENT_SECRET: "fictional-oauth-secret",
      VAPID_PRIVATE_KEY: "fictional-push-secret",
      LOCAL_SIGNING_SECRET: "fictional-local-secret",
      COGNITO_CLIENT_SECRET: "fictional-oidc-secret",
      NEXT_PUBLIC_SECRET: "fictional-public-secret",
      HTTP_PROXY: "http://example.invalid",
      HTTPS_PROXY: "http://example.invalid",
      NODE_OPTIONS: "--require /fictional/script",
      NODE_EXTRA_CA_CERTS: "/fictional/ca",
      DEBUG: "pw:api",
      PWDEBUG: "1",
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/fictional/browser",
      CAPTIONDOOR_PROVIDER_SMOKE_RUN: "1",
    };
    const env = buildProviderSessionEnvironment(
      options({ inheritedEnv: privateEnv }),
    );
    for (const name of Object.keys(privateEnv))
      if (!["PATH", "HOME"].includes(name)) expect(env[name]).toBeUndefined();
    expect(env.AWS_PROFILE).toBe("tally");
    expect(env.RING_PLAYGROUND_TOKEN).toBe(secrets.token);
  });

  it("leaves only sanctioned nonsecret configuration in the existing browser child", () => {
    const env = buildProviderSessionEnvironment(
      options({ deviceId: "fictional-device" }),
    );
    const child = providerSmokeChildEnvironment(
      env,
      "captions",
      "00000000-0000-4000-8000-000000000001",
    );
    for (const name of [
      "RING_PLAYGROUND_TOKEN",
      "DEV_CREDENTIAL_KEY",
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_CONFIG_FILE",
      "DEBUG",
      "NODE_OPTIONS",
    ])
      expect(child[name]).toBeUndefined();
    expect(JSON.stringify(child)).not.toContain(secrets.token);
    expect(JSON.stringify(child)).not.toContain(secrets.keyBase64);
    expect(child.CAPTIONDOOR_SMOKE_DEVICE_ID).toBe("fictional-device");
    expect(child.CAPTIONDOOR_ROOT_SMOKE_APPROVAL).toBe(rootSmokeConfig.scope);
  });

  it("does not use randomness or network while constructing configuration", () => {
    const fetch = vi.fn(() => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      buildProviderSessionEnvironment(options());
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
