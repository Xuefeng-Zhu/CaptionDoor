import {
  CfnOutput,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
} from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export const databaseRequestLimits = {
  maxReadRequestUnits: 50,
  maxWriteRequestUnits: 50,
} as const;

export type CaptionDoorDatabaseStackProps = StackProps & {
  env: { account: string; region: string };
  tablePrefix?: string;
};

/** Separate remote-demo namespace; never silently target local or production tables. */
export function validateDatabaseDeploymentTarget(
  account: unknown,
  region: unknown,
  prefix: unknown = "CaptionDoorDev",
): { account: string; region: string; tablePrefix: string } {
  if (typeof account !== "string" || !/^\d{12}$/.test(account))
    throw new Error("An explicit 12-digit database AWS account is required.");
  if (typeof region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))
    throw new Error("An explicit database AWS Region is required.");
  if (
    typeof prefix !== "string" ||
    !/^CaptionDoorDev(?:-[a-z0-9][a-z0-9-]{0,39})?$/.test(prefix)
  )
    throw new Error(
      "Database table prefix must be CaptionDoorDev or CaptionDoorDev-<lowercase suffix>.",
    );
  return { account, region, tablePrefix: prefix };
}

/** Three retained dev/demo databases only. No auth, compute, IAM or queue resources. */
export class CaptionDoorDatabaseStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: CaptionDoorDatabaseStackProps,
  ) {
    const target = validateDatabaseDeploymentTarget(
      props.env?.account,
      props.env?.region,
      props.tablePrefix,
    );
    super(scope, id, {
      ...props,
      env: { account: target.account, region: target.region },
      analyticsReporting: false,
    });
    Tags.of(this).add("Application", "CaptionDoor");
    Tags.of(this).add("Environment", "remote-demo");
    Tags.of(this).add("DataPurpose", "FictionalDemo");

    const table = (logical: string, stream?: dynamodb.StreamViewType) =>
      new dynamodb.Table(this, logical, {
        tableName: `${target.tablePrefix}${logical}`,
        partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        tableClass: dynamodb.TableClass.STANDARD,
        // DynamoDB's AWS-owned key encrypts at rest without a separate KMS key.
        encryption: dynamodb.TableEncryption.DEFAULT,
        timeToLiveAttribute: "expiresAt",
        stream,
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
        ...databaseRequestLimits,
      });
    const config = table("Config");
    const visits = table("Visits");
    visits.addGlobalSecondaryIndex({
      indexName: "household-time",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
      ...databaseRequestLimits,
    });
    const runtime = table("Runtime", dynamodb.StreamViewType.KEYS_ONLY);
    runtime.addGlobalSecondaryIndex({
      indexName: "due-work",
      partitionKey: { name: "duePk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "dueSk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
      ...databaseRequestLimits,
    });

    // Review artifact only: no identity, managed policy or access grant is created.
    const runtimePolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "CaptionDoorTableData",
          Effect: "Allow",
          Action: [
            "dynamodb:DescribeTable",
            "dynamodb:DescribeTimeToLive",
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:Query",
            "dynamodb:ConditionCheckItem",
          ],
          Resource: [config.tableArn, visits.tableArn, runtime.tableArn],
        },
        {
          Sid: "CaptionDoorIndexQueries",
          Effect: "Allow",
          Action: ["dynamodb:Query"],
          Resource: [
            `${visits.tableArn}/index/household-time`,
            `${runtime.tableArn}/index/due-work`,
          ],
        },
      ],
    };
    new CfnOutput(this, "RuntimePolicyJson", {
      description:
        "Proposed least-privilege policy; attaching it needs separate approval",
      value: this.toJsonString(runtimePolicy),
    });

    new CfnOutput(this, "ConfigTableName", { value: config.tableName });
    new CfnOutput(this, "VisitsTableName", { value: visits.tableName });
    new CfnOutput(this, "RuntimeTableName", { value: runtime.tableName });
    new CfnOutput(this, "ConfigTableArn", { value: config.tableArn });
    new CfnOutput(this, "VisitsTableArn", { value: visits.tableArn });
    new CfnOutput(this, "RuntimeTableArn", { value: runtime.tableArn });
    new CfnOutput(this, "RuntimeStreamArn", { value: runtime.tableStreamArn! });
    new CfnOutput(this, "DatabaseAccount", { value: target.account });
    new CfnOutput(this, "DatabaseRegion", { value: target.region });
    new CfnOutput(this, "DatabaseMode", { value: "aws" });
    new CfnOutput(this, "ApplicationEnvironment", { value: "remote-demo" });
  }
}
