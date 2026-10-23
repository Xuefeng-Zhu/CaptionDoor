import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  CaptionDoorDatabaseStack,
  validateDatabaseDeploymentTarget,
} from "../../infra/cdk/database-stack";

// Synthetic deployment metadata used only to inspect an offline template.
const target = { account: "000000000000", region: "us-east-1" };
function synth(tablePrefix?: string) {
  const app = new App({ analyticsReporting: false });
  return Template.fromStack(
    new CaptionDoorDatabaseStack(app, "DatabaseContract", {
      env: target,
      tablePrefix,
    }),
  );
}

describe("database-only remote demo infrastructure", () => {
  it("contains exactly three retained and protected on-demand Standard tables", () => {
    const template = synth();
    const resources = template.toJSON().Resources;
    expect(Object.values(resources).map((value: any) => value.Type)).toEqual([
      "AWS::DynamoDB::Table",
      "AWS::DynamoDB::Table",
      "AWS::DynamoDB::Table",
    ]);
    for (const table of Object.values(resources) as any[]) {
      expect(table.DeletionPolicy).toBe("Retain");
      expect(table.UpdateReplacePolicy).toBe("Retain");
      expect(table.Properties).toMatchObject({
        BillingMode: "PAY_PER_REQUEST",
        TableClass: "STANDARD",
        DeletionProtectionEnabled: true,
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
        OnDemandThroughput: {
          MaxReadRequestUnits: 50,
          MaxWriteRequestUnits: 50,
        },
      });
      // AWS-owned encryption is DynamoDB's default, not an AWS-managed/custom KMS key.
      expect(table.Properties.SSESpecification).toEqual({ SSEEnabled: false });
      expect(table.Properties.Tags).toEqual(
        expect.arrayContaining([
          { Key: "Application", Value: "CaptionDoor" },
          { Key: "Environment", Value: "remote-demo" },
        ]),
      );
    }
  });
  it("has only the required key-only indexes and runtime stream", () => {
    const template = synth();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "CaptionDoorDevConfig",
      GlobalSecondaryIndexes: Match.absent(),
      StreamSpecification: Match.absent(),
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "CaptionDoorDevVisits",
      GlobalSecondaryIndexes: [
        {
          IndexName: "household-time",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
          OnDemandThroughput: {
            MaxReadRequestUnits: 50,
            MaxWriteRequestUnits: 50,
          },
        },
      ],
      StreamSpecification: Match.absent(),
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "CaptionDoorDevRuntime",
      GlobalSecondaryIndexes: [
        {
          IndexName: "due-work",
          KeySchema: [
            { AttributeName: "duePk", KeyType: "HASH" },
            { AttributeName: "dueSk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
          OnDemandThroughput: {
            MaxReadRequestUnits: 50,
            MaxWriteRequestUnits: 50,
          },
        },
      ],
      StreamSpecification: { StreamViewType: "KEYS_ONLY" },
    });
  });
  it("outputs target metadata and supports only isolated development prefixes", () => {
    const template = synth("CaptionDoorDev-review1");
    for (const logical of ["Config", "Visits", "Runtime"]) {
      const name = `CaptionDoorDev-review1${logical}`;
      const tableIds = Object.keys(
        template.findResources("AWS::DynamoDB::Table", {
          Properties: { TableName: name },
        }),
      );
      expect(tableIds).toHaveLength(1);
      template.hasOutput(`${logical}TableName`, {
        Value: { Ref: tableIds[0] },
      });
    }
    template.hasOutput("DatabaseAccount", { Value: target.account });
    template.hasOutput("DatabaseRegion", { Value: target.region });
    template.hasOutput("DatabaseMode", { Value: "aws" });
    template.hasOutput("ApplicationEnvironment", { Value: "remote-demo" });
  });
  it("outputs a scoped runtime policy without creating IAM or table-admin access", () => {
    const template = synth();
    template.hasOutput("RuntimePolicyJson", { Value: Match.anyValue() });
    const output = JSON.stringify(template.toJSON().Outputs.RuntimePolicyJson);
    for (const action of [
      "DescribeTable",
      "DescribeTimeToLive",
      "GetItem",
      "PutItem",
      "UpdateItem",
      "DeleteItem",
      "ConditionCheckItem",
      "Query",
    ])
      expect(output).toContain(`dynamodb:${action}`);
    for (const action of [
      "Scan",
      "CreateTable",
      "DeleteTable",
      "UpdateTable",
      "UpdateTimeToLive",
    ])
      expect(output).not.toContain(`dynamodb:${action}`);
    expect(output).toContain("/index/household-time");
    expect(output).toContain("/index/due-work");
    expect(output).not.toContain("/index/*");
    expect(
      Object.values(template.toJSON().Resources).every(
        (resource: any) => resource.Type === "AWS::DynamoDB::Table",
      ),
    ).toBe(true);
  });
  it.each([undefined, "", "123", "not-an-account"])(
    "rejects missing/invalid account %s",
    (account) => {
      expect(() =>
        validateDatabaseDeploymentTarget(account, target.region),
      ).toThrow("account");
    },
  );
  it.each([undefined, "", "localhost", "us-east-1/extra"])(
    "rejects missing/invalid Region %s",
    (region) => {
      expect(() =>
        validateDatabaseDeploymentTarget(target.account, region),
      ).toThrow("Region");
    },
  );
  it.each([
    "CaptionDoor",
    "CaptionDoorProd",
    "SayGo",
    "Tally",
    "captiondoordev",
    "CaptionDoorDev/other",
  ])("rejects unsafe namespace %s", (prefix) => {
    expect(() =>
      validateDatabaseDeploymentTarget(target.account, target.region, prefix),
    ).toThrow("prefix");
  });
});
