import { describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { installAwsIdentityGuard } from "../../packages/db/src/aws-identity";
import {
  validateTemporaryRemoteCredentials,
  temporaryRemoteCredentialsProvider,
  installTemporaryRemoteDatabaseCredentialsGuard,
} from "../../packages/db/src/temporary-remote-credentials";

describe("pure temporary AWS credential metadata policy", () => {
  const now = 1_700_000_000_000;
  it.each([
    undefined,
    null,
    {},
    { sessionToken: "" },
    { sessionToken: "fixture token" },
    { sessionToken: "fixture\n" },
    { sessionToken: "fixture", expiration: new Date(now) },
    { sessionToken: "fixture", expiration: new Date(now - 1) },
    { sessionToken: "fixture", expiration: new Date(NaN) },
    { sessionToken: "fixture", expiration: "2099-01-01" },
  ])("rejects static, malformed or expired metadata %j", (credentials) => {
    expect(() =>
      validateTemporaryRemoteCredentials(credentials, now),
    ).toThrowError(
      expect.objectContaining({
        code: "REMOTE_PROVIDER_TEMPORARY_CREDENTIALS_REQUIRED",
      }),
    );
  });
  it("accepts a session token with optional valid future SDK expiration", () => {
    expect(() =>
      validateTemporaryRemoteCredentials({ sessionToken: "fixture" }, now),
    ).not.toThrow();
    expect(() =>
      validateTemporaryRemoteCredentials(
        { sessionToken: "fixture", expiration: new Date(now + 1) },
        now,
      ),
    ).not.toThrow();
  });
  it("preserves provider arguments and rechecks every credential resolution", async () => {
    const temporary = { sessionToken: "fixture" };
    const load = vi
      .fn()
      .mockResolvedValueOnce(temporary)
      .mockResolvedValueOnce({});
    const provider = temporaryRemoteCredentialsProvider(load);
    await expect(provider({ forceRefresh: true })).resolves.toBe(temporary);
    expect(load).toHaveBeenNthCalledWith(1, { forceRefresh: true });
    await expect(provider()).rejects.toMatchObject({
      code: "REMOTE_PROVIDER_TEMPORARY_CREDENTIALS_REQUIRED",
    });
  });
  it("sanitizes credential provider errors", async () => {
    const provider = temporaryRemoteCredentialsProvider(async () => {
      throw new Error("PRIVATE_CREDENTIAL_DIAGNOSTIC");
    });
    await expect(provider()).rejects.toMatchObject({
      message:
        "The remote provider test requires valid temporary AWS session credentials.",
    });
  });
});

describe("remote temporary credential gate with fake SDK transport only", () => {
  it("blocks static resolved credentials before identity and DocumentClient transport", async () => {
    const handle = vi.fn(),
      loadIdentity = vi.fn();
    const client = new DynamoDBClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: "fixture-only",
        secretAccessKey: "fixture-only",
      },
      requestHandler: { handle },
    });
    installTemporaryRemoteDatabaseCredentialsGuard(client);
    installAwsIdentityGuard(client, "256604024085", loadIdentity);
    const doc = DynamoDBDocumentClient.from(client);
    try {
      await expect(
        doc.send(
          new GetCommand({
            TableName: "CaptionDoorFixture",
            Key: { PK: "fixture", SK: "fixture" },
          }),
        ),
      ).rejects.toMatchObject({
        code: "REMOTE_PROVIDER_TEMPORARY_CREDENTIALS_REQUIRED",
      });
      expect(loadIdentity).not.toHaveBeenCalled();
      expect(handle).not.toHaveBeenCalled();
    } finally {
      client.destroy();
    }
  });
});
