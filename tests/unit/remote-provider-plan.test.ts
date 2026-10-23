import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteProviderDatabaseStack } from "../../infra/cdk/provider-database-app";
import {
  buildRemoteProviderPlan,
  runRemoteProviderPlan,
} from "../../scripts/prepare-remote-provider";

afterEach(() => vi.unstubAllGlobals());

describe("offline remote provider review plan", () => {
  it("does not extend the approved fixed-scope root choice to resources, consent, costs or prior usage", () => {
    const plan = buildRemoteProviderPlan();
    expect(plan.result).toBe("BLOCKED");
    expect(plan.executionAllowed).toBe(false);
    expect(plan.iam.trustPolicy).toBeNull();
    expect(plan.iam.trustedNonRootPrincipalArn).toBeNull();
    expect(plan.iam.runtimeRoleArn).toBeNull();
    expect(plan.iam.selectedAccess).toMatchObject({
      mode: "EXISTING_ROOT_FIXED_REMOTE_SCOPE_EXCEPTION",
      approval: "APPROVED_BY_USER_FOR_FIXED_REMOTE_SCOPE",
      profile: "tally",
      principalArn: "arn:aws:iam::256604024085:root",
      accountId: "256604024085",
      region: "us-east-1",
      scope: "captiondoor-remote-provider-verification-20261023",
      tablePrefix: "CaptionDoorDevProviderSmoke20261023",
      runtimeFlag: "--approved-root",
      newRoleRequired: false,
      newTrustRequired: false,
      newIamGrantRequired: false,
      ordinaryDatabaseAndProductionRejectRoot: true,
    });
    expect(plan.approvals.selectedRootIdentity).toBe(
      "APPROVED_BY_USER_FOR_FIXED_REMOTE_SCOPE",
    );
    expect(plan.approvals.resourceCreation).toBe("UNRESOLVED");
    expect(plan.approvals.fictionalSeedAndBoundedProviderWrites).toBe(
      "UNRESOLVED",
    );
    expect(plan.blockers).not.toContain(
      "EXACT_NON_ROOT_RUNTIME_IDENTITY_UNRESOLVED",
    );
    expect(plan.approvals.databaseOperatingAllowanceUsd).toBeNull();
    expect(plan.approvals.encryptedAccessTokenStorageInAws).toBe("UNRESOLVED");
    expect(plan.budget.previousReservedSeconds).toBeNull();
    expect(plan.budget.previousEstimatedMicrousd).toBeNull();
    expect(plan.budget.verifiedBaselineSha256).toBeNull();
    expect(plan.budget.remainingSeconds).toBeNull();
    expect(plan.budget.remainingMicrousd).toBeNull();
    expect(plan.budget.baselineApproved).toBe(false);
    expect(plan.budget.resetsExistingLocalRootScope).toBe(false);
    expect(plan.budget.maxAttemptSeconds).toBe(30);
    expect(plan.budget.maxCumulativeSeconds).toBe(90);
    expect(plan.budget.maxCumulativeMicrousd).toBe(10_000_000);
    expect(plan.blockers).toContain(
      "PRIOR_CUMULATIVE_LEDGER_BASELINE_UNVERIFIED",
    );
  });

  it("lists exactly three dedicated unknown-state tables and only their item/index access", () => {
    const plan = buildRemoteProviderPlan();
    expect(plan.target.accountId).toBe("256604024085");
    expect(plan.target.region).toBe("us-east-1");
    expect(plan.readiness.status).toBe("UNVERIFIED");
    expect(plan.readiness.identity.selectedRootException).toBe(
      "APPROVED_BY_USER_FOR_FIXED_REMOTE_SCOPE",
    );
    expect(plan.readiness.identity.latestSessionObservedPrincipalArn).toBe(
      "arn:aws:iam::256604024085:root",
    );
    expect(
      plan.readiness.identity.ordinaryDatabaseAndProductionRejectRoot,
    ).toBe(true);
    expect(plan.readiness.identity.actualPrincipalArn).toBeNull();
    expect(plan.readiness.readOnlyOperations).toEqual([
      "sts:GetCallerIdentity",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
    ]);
    expect(plan.resources.map((table) => table.tableName)).toEqual([
      "CaptionDoorDevProviderSmoke20261023Config",
      "CaptionDoorDevProviderSmoke20261023Visits",
      "CaptionDoorDevProviderSmoke20261023Runtime",
    ]);
    expect(
      plan.resources.every((table) => table.existence === "NOT_QUERIED"),
    ).toBe(true);
    const policy = plan.iam.databaseRuntimePolicy;
    expect(plan.readiness.exactTableArns).toEqual(
      plan.resources.map((table) => table.arn),
    );
    expect(policy.Statement[0].Resource).toEqual(
      plan.resources.map((table) => table.arn),
    );
    expect(policy.Statement[1].Resource).toEqual([
      `${plan.resources[1].arn}/index/household-time`,
      `${plan.resources[2].arn}/index/due-work`,
    ]);
    const serialized = JSON.stringify(policy);
    expect(serialized).not.toContain("*");
    for (const action of [
      "Scan",
      "CreateTable",
      "DeleteTable",
      "UpdateTable",
      "UpdateTimeToLive",
    ])
      expect(serialized).not.toContain(`dynamodb:${action}`);
    expect(plan.iam.transcribePermissionTemplate.Statement[0]).toEqual({
      Sid: "CaptionDoorApprovedRegionStreamingOnly",
      Effect: "Allow",
      Action: ["transcribe:StartStreamTranscription"],
      Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } },
    });
  });

  it("retains the approved short-lived access-only cleanup requirements without extending Local approval", () => {
    const plan = buildRemoteProviderPlan();
    expect(plan.tokenStorage.maxApplicationValiditySeconds).toBe(60);
    expect(plan.tokenStorage.refreshTokenPermitted).toBe(false);
    expect(plan.tokenStorage.plaintextSecretFilePermitted).toBe(false);
    expect(plan.tokenStorage.localApprovalCoversAwsStorage).toBe(false);
    expect(plan.approvals.newTokenGenerationAuthorizedByThisPlan).toBe(false);
    expect(plan.approvals.databaseAllowanceIsSeparateFromTranscription).toBe(
      true,
    );
    expect(plan.approvals.throughputTargetsAreHardCostCap).toBe(false);
  });

  it("emits a blocked zero-network plan, and refuses approval switches without echoing arguments", () => {
    const fetch = vi.fn(() => {
      throw new Error("Network is forbidden in offline preparation.");
    });
    vi.stubGlobal("fetch", fetch);
    const output: string[] = [];
    expect(runRemoteProviderPlan([], (value) => output.push(value))).toBe(2);
    expect(JSON.parse(output[0])).toMatchObject({
      result: "BLOCKED",
      executionAllowed: false,
      networkCalls: 0,
      awsWrites: 0,
      credentialResolution: false,
    });
    output.length = 0;
    expect(
      runRemoteProviderPlan(
        ["--approve", "fictional-secret-never-echo"],
        (value) => output.push(value),
      ),
    ).toBe(2);
    expect(output.join("")).not.toContain("fictional-secret-never-echo");
    expect(output.join("")).toContain("INVALID_REMOTE_PROVIDER_PLAN_ARGUMENTS");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prints help without producing or authorizing a runtime plan", () => {
    const output: string[] = [];
    expect(
      runRemoteProviderPlan(["--help"], (value) => output.push(value)),
    ).toBe(0);
    expect(output.join("")).toContain("Zero-network review plan only");
    expect(output.join("")).not.toContain('"executionAllowed": true');
  });

  it("synthesizes only the three planned tables, with provider provenance and no IAM resource", () => {
    const app = new App({ analyticsReporting: false, autoSynth: false });
    const stack = createRemoteProviderDatabaseStack(app);
    const template = Template.fromStack(stack);
    const plan = buildRemoteProviderPlan();
    const resources = Object.values(template.toJSON().Resources) as any[];
    expect(resources).toHaveLength(3);
    expect(
      resources.every((resource) => resource.Type === "AWS::DynamoDB::Table"),
    ).toBe(true);
    for (const table of plan.resources) {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: table.tableName,
        BillingMode: table.billingMode,
        TableClass: table.tableClass,
        DeletionProtectionEnabled: table.deletionProtection,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
        TimeToLiveSpecification: {
          AttributeName: table.ttlAttribute,
          Enabled: true,
        },
        OnDemandThroughput: {
          MaxReadRequestUnits: table.maxReadRequestUnits,
          MaxWriteRequestUnits: table.maxWriteRequestUnits,
        },
      });
      const resource = resources.find(
        (resource) => resource.Properties.TableName === table.tableName,
      );
      expect(resource.DeletionPolicy).toBe("Retain");
      expect(resource.UpdateReplacePolicy).toBe("Retain");
      expect(resource.Properties.Tags).toContainEqual({
        Key: "Environment",
        Value: "remote-provider",
      });
      expect(resource.Properties.Tags).toContainEqual({
        Key: "DataPurpose",
        Value: "ProviderSmokeShortLived",
      });
      expect(
        (resource.Properties.GlobalSecondaryIndexes || []).map(
          (index: any) => index.IndexName,
        ),
      ).toEqual(table.indexes.map((index) => index.name));
    }
    template.hasOutput("DatabaseAccount", { Value: plan.target.accountId });
    template.hasOutput("DatabaseRegion", { Value: plan.target.region });
    template.hasOutput("ApplicationEnvironment", { Value: "remote-provider" });
  });
});
