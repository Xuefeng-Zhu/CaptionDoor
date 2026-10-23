import { describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  createAwsIdentityGuard,
  installAwsIdentityGuard,
  type AwsIdentity,
} from "../../packages/db/src/aws-identity";
const account = "123456789012";
const role = {
  Account: account,
  Arn: `arn:aws:sts::${account}:assumed-role/CaptionDoorDevRuntimeRole/unit-session`,
};

describe("AWS database identity fence with mocked identity/transport, no AWS calls", () => {
  it.each([
    {},
    { Account: account },
    { Account: account, Arn: `arn:aws:iam::${account}:root` },
    { Account: "999999999999", Arn: role.Arn },
    {
      Account: account,
      Arn: "arn:aws:sts::999999999999:assumed-role/Other/unit",
    },
    { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/` },
    { Account: account, Arn: "not-an-arn" },
  ])("refuses an unverified or root identity %j", async (identity) => {
    const verify = createAwsIdentityGuard(account, async () => identity);
    await expect(verify()).rejects.toMatchObject({
      code: "AWS_DATABASE_IDENTITY_UNVERIFIED",
      status: 503,
    });
  });
  it("shares one successful check across concurrent operations", async () => {
    let finish!: (value: AwsIdentity) => void;
    const load = vi.fn(
      () =>
        new Promise<AwsIdentity>((resolve) => {
          finish = resolve;
        }),
    );
    const verify = createAwsIdentityGuard(account, load);
    const first = verify(),
      second = verify();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    finish(role);
    await Promise.all([first, second, verify()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it.each(["sync", "async"])(
    "sanitizes %s credential errors and permits a later verified retry",
    async (failure) => {
      const load = vi
        .fn<() => Promise<AwsIdentity>>()
        .mockImplementationOnce(() => {
          if (failure === "sync")
            throw new Error("PRIVATE_CREDENTIAL_DIAGNOSTIC");
          return Promise.reject(new Error("PRIVATE_CREDENTIAL_DIAGNOSTIC"));
        })
        .mockResolvedValueOnce(role);
      const verify = createAwsIdentityGuard(account, load);
      await expect(verify()).rejects.toMatchObject({
        message:
          "AWS database access requires the approved account and a verified non-root application identity.",
      });
      await expect(verify()).resolves.toBeUndefined();
      expect(load).toHaveBeenCalledTimes(2);
    },
  );
  it("applies the fence to inherited DocumentClient reads and transactions", async () => {
    const handle = vi.fn(async () => ({
      response: { statusCode: 200, headers: {}, body: Buffer.from("{}") },
    }));
    const client = new DynamoDBClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: "fixture-only",
        secretAccessKey: "fixture-only",
      },
      requestHandler: { handle },
    });
    const load = vi
      .fn<() => Promise<AwsIdentity>>()
      .mockResolvedValueOnce({
        Account: account,
        Arn: `arn:aws:iam::${account}:root`,
      })
      .mockResolvedValueOnce(role);
    installAwsIdentityGuard(client, account, load);
    const doc = DynamoDBDocumentClient.from(client);
    try {
      await expect(
        doc.send(
          new GetCommand({
            TableName: "CaptionDoorDevConfig",
            Key: { PK: "fixture", SK: "fixture" },
          }),
        ),
      ).rejects.toMatchObject({ code: "AWS_DATABASE_IDENTITY_UNVERIFIED" });
      expect(handle).not.toHaveBeenCalled();
      await doc.send(
        new GetCommand({
          TableName: "CaptionDoorDevConfig",
          Key: { PK: "fixture", SK: "fixture" },
        }),
      );
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: "CaptionDoorDevConfig",
                Item: { PK: "fixture", SK: "fixture" },
              },
            },
          ],
        }),
      );
      expect(load).toHaveBeenCalledTimes(2);
      expect(handle).toHaveBeenCalledTimes(2);
    } finally {
      client.destroy();
    }
  });
});
