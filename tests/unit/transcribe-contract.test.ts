import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StartStreamTranscriptionCommandInput,
  TranscriptEvent,
} from "@aws-sdk/client-transcribe-streaming";
import {
  createTranscribeIdentityGuard,
  resolveTranscribeAwsConfig,
} from "../../packages/integrations/src/audio/aws-identity";
import {
  issueRootSmokePermit,
  rootSmokeReceipt,
} from "../../packages/integrations/src/audio/root-smoke-permit";
import { AwsPcmStream } from "../../packages/integrations/src/audio/transcribe";

const transport = vi.hoisted(() => ({
  credentials: vi.fn(),
  streamSend: vi.fn(),
  identitySend: vi.fn(),
  streamDestroy: vi.fn(),
  identityDestroy: vi.fn(),
  streamConfigs: [] as Array<Record<string, unknown>>,
  identityConfigs: [] as Array<Record<string, unknown>>,
}));
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  TranscribeStreamingClient: class {
    config = { credentials: transport.credentials };
    send = transport.streamSend;
    destroy = transport.streamDestroy;
    constructor(config: Record<string, unknown>) {
      transport.streamConfigs.push(config);
    }
  },
  StartStreamTranscriptionCommand: class {
    constructor(readonly input: StartStreamTranscriptionCommandInput) {}
  },
}));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = transport.identitySend;
    destroy = transport.identityDestroy;
    constructor(config: Record<string, unknown>) {
      transport.identityConfigs.push(config);
    }
  },
  GetCallerIdentityCommand: class {},
}));

const account = "123456789012";
const config = { accountId: account, region: "us-east-1" };
const identity = {
  Account: account,
  Arn: `arn:aws:sts::${account}:assumed-role/CaptionDoorTranscribeSmoke/unit`,
};
const env = {
  TRANSCRIBE_AWS_ACCOUNT_ID: account,
  TRANSCRIBE_AWS_REGION: config.region,
};

beforeEach(() => {
  vi.clearAllMocks();
  transport.streamConfigs.length = 0;
  transport.identityConfigs.length = 0;
  transport.identitySend.mockReset().mockResolvedValue(identity);
  transport.streamSend.mockReset().mockResolvedValue({
    TranscriptResultStream: (async function* () {})(),
  });
  for (const key of Object.keys(process.env))
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_"))
      vi.stubEnv(key, undefined);
  vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
  vi.stubEnv("TRANSCRIBE_AWS_ACCOUNT_ID", account);
  vi.stubEnv("TRANSCRIBE_AWS_REGION", config.region);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("explicit independent Transcribe identity, no AWS requests", () => {
  it.each([
    {},
    { AWS_REGION: "us-east-1", AWS_ACCOUNT_ID: account },
    { ...env, TRANSCRIBE_AWS_ACCOUNT_ID: "" },
    { ...env, TRANSCRIBE_AWS_ACCOUNT_ID: "000000000000" },
    { ...env, TRANSCRIBE_AWS_REGION: "" },
    { ...env, TRANSCRIBE_AWS_REGION: "https://not-a-region.invalid" },
  ])(
    "does not infer provider approval from Local database defaults %j",
    (input) => {
      expect(() => resolveTranscribeAwsConfig(input)).toThrowError(
        /explicitly approved account and Region/,
      );
    },
  );
  it.each([
    { AWS_ENDPOINT_URL: "https://not-aws.invalid" },
    { AWS_ENDPOINT_URL_STS: "https://not-aws.invalid" },
    { AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING: "https://not-aws.invalid" },
    { AWS_ACCESS_KEY_ID: "captiondoorlocal" },
    { AWS_SECRET_ACCESS_KEY: "captiondoor-local" },
  ])(
    "rejects endpoint overrides and local dummy credentials %j",
    (override) => {
      expect(() =>
        resolveTranscribeAwsConfig({ ...env, ...override }),
      ).toThrowError(/endpoint overrides and local dummy credentials/);
    },
  );
  it("uses the separately approved Region rather than AWS database Region", () => {
    expect(
      resolveTranscribeAwsConfig({ ...env, AWS_REGION: "eu-west-1" }),
    ).toEqual(config);
  });
  it.each([
    {},
    { Account: account },
    { Account: account, Arn: `arn:aws:iam::${account}:root` },
    { ...identity, Account: "999999999999" },
    {
      Account: account,
      Arn: "arn:aws:sts::999999999999:assumed-role/Other/session",
    },
    { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/` },
  ])("refuses root, unknown or mismatched identity %j", async (value) => {
    const verify = createTranscribeIdentityGuard(config, async () => value);
    await expect(verify()).rejects.toMatchObject({
      code: "TRANSCRIBE_AWS_IDENTITY_UNVERIFIED",
      status: 503,
    });
  });
  it("shares an in-flight identity check and sanitizes credential diagnostic errors", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("PRIVATE_CREDENTIAL_DIAGNOSTIC"))
      .mockResolvedValueOnce(identity);
    const verify = createTranscribeIdentityGuard(config, load);
    await expect(verify()).rejects.toMatchObject({
      message:
        "AWS transcription requires the approved account and a verified non-root identity.",
    });
    await Promise.all([verify(), verify(), verify()]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("mono StartStreamTranscription contract with mocked SDK transports", () => {
  it("verifies the same credential provider before paid transport, omits multi-channel fields, and keeps provider final metadata", async () => {
    const caption = vi.fn(async () => {});
    const failure = vi.fn();
    const bytes = new Uint8Array(3200);
    bytes[0] = 123;
    transport.streamSend
      .mockReset()
      .mockImplementation(
        async (command: { input: StartStreamTranscriptionCommandInput }) => {
          expect(command.input).toMatchObject({
            LanguageCode: "en-US",
            MediaEncoding: "pcm",
            MediaSampleRateHertz: 16000,
          });
          expect(command.input).not.toHaveProperty("NumberOfChannels");
          expect(command.input).not.toHaveProperty(
            "EnableChannelIdentification",
          );
          const frame = await command.input
            .AudioStream![Symbol.asyncIterator]()
            .next();
          expect(frame.value).toEqual({ AudioEvent: { AudioChunk: bytes } });
          return {
            TranscriptResultStream: (async function* () {
              const event: TranscriptEvent = {
                Transcript: {
                  Results: [
                    {
                      ResultId: "provider-segment",
                      IsPartial: false,
                      StartTime: 0,
                      EndTime: 0.1,
                      Alternatives: [
                        { Transcript: "Synthetic provider response." },
                      ],
                    },
                  ],
                },
              };
              yield { TranscriptEvent: event };
            })(),
          };
        },
      );
    const stream = new AwsPcmStream("media-1", caption, failure);
    expect(transport.identitySend).not.toHaveBeenCalled();
    expect(transport.streamSend).not.toHaveBeenCalled();
    await Promise.all([stream.prepare(), stream.prepare()]);
    expect(transport.identitySend).toHaveBeenCalledTimes(1);
    expect(transport.streamSend).not.toHaveBeenCalled();
    expect(stream.push(bytes)).toBe(true);
    await Promise.all([stream.run(), stream.run()]);
    expect(transport.streamSend).toHaveBeenCalledTimes(1);
    expect(transport.identitySend.mock.invocationCallOrder[0]).toBeLessThan(
      transport.streamSend.mock.invocationCallOrder[0],
    );
    expect(transport.streamConfigs).toEqual([
      {
        region: config.region,
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
      },
    ]);
    expect(transport.identityConfigs).toEqual([
      {
        region: config.region,
        credentials: transport.credentials,
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
      },
    ]);
    expect(failure.mock.calls).toEqual([]);
    expect(caption).toHaveBeenCalledExactlyOnceWith({
      mediaSessionId: "media-1",
      resultId: "provider-segment",
      text: "Synthetic provider response.",
      isPartial: false,
      startTime: 0,
      endTime: 0.1,
      source: "AWS",
    });
    expect(failure).not.toHaveBeenCalled();
    expect(transport.streamDestroy).toHaveBeenCalledTimes(1);
    expect(transport.identityDestroy).toHaveBeenCalledTimes(1);
  });
  it("never sends audio or opens a paid stream for root and reports only a sanitized category", async () => {
    transport.identitySend.mockResolvedValue({
      Account: account,
      Arn: `arn:aws:iam::${account}:root`,
    });
    const failure = vi.fn();
    const stream = new AwsPcmStream("media-1", vi.fn(), failure);
    stream.push(new Uint8Array(3200));
    await stream.run();
    expect(transport.streamSend).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledExactlyOnceWith(
      "TRANSCRIBE_AWS_IDENTITY_UNVERIFIED",
    );
    expect(stream.push(new Uint8Array(3200))).toBe(false);
  });
  it("fails missing explicit config before any STS or paid request and invokes normal failure cleanup", async () => {
    vi.stubEnv("TRANSCRIBE_AWS_ACCOUNT_ID", undefined);
    const failure = vi.fn();
    const stream = new AwsPcmStream("media-1", vi.fn(), failure);
    await stream.run();
    expect(failure).toHaveBeenCalledExactlyOnceWith(
      "TRANSCRIBE_CONFIGURATION_REQUIRED",
    );
    expect(transport.identitySend).not.toHaveBeenCalled();
    expect(transport.streamSend).not.toHaveBeenCalled();
    expect(stream.push(new Uint8Array(3200))).toBe(false);
  });
  it("stopping while identity verification is pending cannot start a paid stream afterward", async () => {
    let finish!: (value: typeof identity) => void;
    transport.identitySend.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const failure = vi.fn();
    const stream = new AwsPcmStream("media-1", vi.fn(), failure);
    const run = stream.run();
    await vi.waitFor(() =>
      expect(transport.identitySend).toHaveBeenCalledTimes(1),
    );
    stream.stop();
    finish(identity);
    await run;
    expect(transport.streamSend).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(transport.streamDestroy).toHaveBeenCalledTimes(1);
    expect(transport.identityDestroy).toHaveBeenCalledTimes(1);
  });
});

const rootTestEnv = {
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
function rootPermit() {
  for (const [key, value] of Object.entries(rootTestEnv))
    vi.stubEnv(key, value);
  return issueRootSmokePermit({
    attemptId: "12345678-1234-4234-8234-123456789012",
    scope: rootTestEnv.CAPTIONDOOR_ROOT_SMOKE_APPROVAL,
    accountId: rootTestEnv.TRANSCRIBE_AWS_ACCOUNT_ID,
    region: rootTestEnv.TRANSCRIBE_AWS_REGION,
    householdId: "fictional-household",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    maxSeconds: 30,
    reservedSeconds: 30,
    cumulativeReservedSeconds: 30,
    cumulativeEstimatedMicrousd: 12_000,
    tablePrefix: "CaptionDoorProviderSmoke20261022",
  });
}
const approvedRootIdentity = {
  Account: rootTestEnv.TRANSCRIBE_AWS_ACCOUNT_ID,
  Arn: `arn:aws:iam::${rootTestEnv.TRANSCRIBE_AWS_ACCOUNT_ID}:root`,
};
describe("one-off root stream with mocked transports only", () => {
  it("root opt-in environment alone never bypasses the normal identity guard", async () => {
    for (const [key, value] of Object.entries(rootTestEnv))
      vi.stubEnv(key, value);
    const verify = createTranscribeIdentityGuard(
      { accountId: approvedRootIdentity.Account, region: "us-east-1" },
      async () => approvedRootIdentity,
    );
    await expect(verify()).rejects.toMatchObject({
      code: "TRANSCRIBE_AWS_IDENTITY_UNVERIFIED",
    });
  });
  it("permits only an issued attempt with the exact verified root account", async () => {
    const permit = rootPermit(),
      failure = vi.fn();
    transport.identitySend.mockResolvedValue(approvedRootIdentity);
    const stream = new AwsPcmStream("root-media", vi.fn(), failure, permit);
    await stream.prepare();
    expect(rootSmokeReceipt(permit)).toMatchObject({
      identity: "ROOT",
      cumulativeReservedSeconds: 30,
    });
    await stream.run();
    expect(transport.streamSend).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
  });
  it("does not send paid audio for a different root account or withdrawn opt-in", async () => {
    const permit = rootPermit(),
      failure = vi.fn();
    transport.identitySend.mockResolvedValue({
      Account: "999999999999",
      Arn: "arn:aws:iam::999999999999:root",
    });
    const stream = new AwsPcmStream("root-media", vi.fn(), failure, permit);
    await stream.run();
    expect(transport.streamSend).not.toHaveBeenCalled();
    const other = rootPermit(),
      otherStream = new AwsPcmStream("root-media", vi.fn(), failure, other);
    vi.stubEnv("CAPTIONDOOR_ROOT_SMOKE", "0");
    await otherStream.run();
    expect(transport.streamSend).not.toHaveBeenCalled();
  });
  it("server deadline aborts SDK transport and discards PCM without browser cleanup", async () => {
    vi.useFakeTimers();
    const permit = rootPermit(),
      failure = vi.fn();
    transport.identitySend.mockResolvedValue(approvedRootIdentity);
    transport.streamSend.mockImplementation(
      (_cmd: unknown, opts: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal.addEventListener(
            "abort",
            () => reject(new Error("AbortError")),
            { once: true },
          );
        }),
    );
    const stream = new AwsPcmStream("root-media", vi.fn(), failure, permit);
    await stream.prepare();
    const running = stream.run();
    await vi.waitFor(() =>
      expect(transport.streamSend).toHaveBeenCalledTimes(1),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await running;
    expect(failure).toHaveBeenCalledExactlyOnceWith(
      "ROOT_SMOKE_DURATION_LIMIT",
    );
    expect(stream.push(new Uint8Array(3200))).toBe(false);
    expect(transport.streamDestroy).toHaveBeenCalledTimes(1);
  });
  it("deadline during identity preparation cannot open a later paid stream", async () => {
    vi.useFakeTimers();
    const permit = rootPermit(),
      failure = vi.fn();
    let finish!: (value: typeof approvedRootIdentity) => void;
    transport.identitySend.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stream = new AwsPcmStream("root-media", vi.fn(), failure, permit);
    const running = stream.run();
    await vi.waitFor(() =>
      expect(transport.identitySend).toHaveBeenCalledTimes(1),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    finish(approvedRootIdentity);
    await running;
    expect(transport.streamSend).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledExactlyOnceWith(
      "ROOT_SMOKE_DURATION_LIMIT",
    );
  });
});
