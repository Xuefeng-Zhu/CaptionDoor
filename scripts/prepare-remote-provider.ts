import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteProviderSmokeConfig } from "@captiondoor/domain";

/** Pure review artifact. No SDK, environment, file, credential or network access. */
export function buildRemoteProviderPlan() {
  const config = remoteProviderSmokeConfig;
  const selectedPrincipalArn = `arn:aws:iam::${config.accountId}:root`;
  const arn = (suffix: string) =>
    `arn:aws:dynamodb:${config.region}:${config.accountId}:table/${config.tablePrefix}${suffix}`;
  const resources = (["Config", "Visits", "Runtime"] as const).map(
    (suffix) => ({
      type: "AWS::DynamoDB::Table" as const,
      tableName: `${config.tablePrefix}${suffix}`,
      arn: arn(suffix),
      partitionKey: { name: "PK", type: "S" },
      sortKey: { name: "SK", type: "S" },
      billingMode: "PAY_PER_REQUEST",
      tableClass: "STANDARD",
      encryption: "AWS_OWNED_KEY",
      ttlAttribute: "expiresAt",
      deletionProtection: true,
      removalPolicy: "RETAIN",
      updateReplacePolicy: "RETAIN",
      pointInTimeRecovery: false,
      maxReadRequestUnits: 50,
      maxWriteRequestUnits: 50,
      indexes:
        suffix === "Config"
          ? []
          : [
              {
                name: suffix === "Visits" ? "household-time" : "due-work",
                partitionKey: suffix === "Visits" ? "gsi1pk" : "duePk",
                sortKey: suffix === "Visits" ? "gsi1sk" : "dueSk",
                keyType: "S",
                projection: "KEYS_ONLY",
                maxReadRequestUnits: 50,
                maxWriteRequestUnits: 50,
              },
            ],
      stream: suffix === "Runtime" ? "KEYS_ONLY" : null,
      existence: "NOT_QUERIED",
    }),
  );
  return {
    result: "BLOCKED" as const,
    artifact: "OFFLINE_REMOTE_PROVIDER_REVIEW_PLAN" as const,
    executionAllowed: false,
    networkCalls: 0,
    awsWrites: 0,
    credentialResolution: false,
    target: {
      accountId: config.accountId,
      region: config.region,
      environment: "remote-provider",
      tablePrefix: config.tablePrefix,
      scope: config.scope,
      appOrigin: "http://127.0.0.1:3410",
      workerOrigin: "http://127.0.0.1:3411",
      pollIntervalMs: 5000,
    },
    resources,
    readiness: {
      status: "UNVERIFIED",
      readOnlyOperations: [
        "sts:GetCallerIdentity",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeTimeToLive",
      ],
      identity: {
        expectedAccountId: config.accountId,
        expectedRegion: config.region,
        selectedRootException: "APPROVED_BY_USER_FOR_FIXED_REMOTE_SCOPE",
        expectedPrincipalArn: selectedPrincipalArn,
        latestSessionObservedPrincipalArn: selectedPrincipalArn,
        observationSource: "LATEST_INTERACTIVE_SESSION_READ_NOT_THIS_COMMAND",
        ordinaryDatabaseAndProductionRejectRoot: true,
        actualPrincipalArn: null,
      },
      exactTableArns: resources.map((resource) => resource.arn),
      requiredTableChecks: [
        "EXACT_NAME_ACCOUNT_REGION_AND_ACTIVE_STATUS",
        "STRING_KEYS_AND_EXACT_KEYS_ONLY_INDEXES_ACTIVE",
        "STANDARD_ON_DEMAND_WITH_50_READ_WRITE_TARGETS",
        "TTL_ENABLED_ON_EXPIRES_AT",
        "RUNTIME_KEYS_ONLY_STREAM_AND_NO_OTHER_STREAMS",
        "AWS_OWNED_ENCRYPTION_AND_DELETION_PROTECTION",
        "NO_REPLICAS_OR_UNEXPECTED_INDEXES",
      ],
      separateTemplateChecks: [
        "CLOUDFORMATION_RETAIN_AND_UPDATE_REPLACE_RETAIN",
        "PITR_DISABLED_FOR_APPROVED_SHORT_LIVED_TEST_DATA",
      ],
      providerPermissionOrExecutionVerified: false,
      initialRecordsOrContentRead: false,
    },
    iam: {
      status: "EXISTING_ACCESS_SELECTED_NO_NEW_GRANT",
      selectedAccess: {
        mode: "EXISTING_ROOT_FIXED_REMOTE_SCOPE_EXCEPTION",
        approval: "APPROVED_BY_USER_FOR_FIXED_REMOTE_SCOPE",
        profile: "tally",
        principalArn: selectedPrincipalArn,
        accountId: config.accountId,
        region: config.region,
        scope: config.scope,
        tablePrefix: config.tablePrefix,
        runtimeFlag: "--approved-root",
        newRoleRequired: false,
        newTrustRequired: false,
        newIamGrantRequired: false,
        ordinaryDatabaseAndProductionRejectRoot: true,
      },
      policyTemplatesPurpose:
        "OPTIONAL_NON_ROOT_ALTERNATIVE_NOT_SELECTED_OR_GRANTED",
      trustedNonRootPrincipalArn: null,
      runtimeRoleArn: null,
      trustPolicy: null,
      trustRequirement:
        "Selected existing tally root access requires no new role, trust or IAM grant. Resolve a precise non-root principal only if the optional alternative is selected; this plan creates no access keys or trust policy.",
      databaseRuntimePolicy: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "CaptionDoorProviderTablesOnly",
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
            Resource: resources.map((resource) => resource.arn),
          },
          {
            Sid: "CaptionDoorProviderIndexesOnly",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: [
              `${arn("Visits")}/index/household-time`,
              `${arn("Runtime")}/index/due-work`,
            ],
          },
        ],
      },
      transcribePermissionTemplate: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "CaptionDoorApprovedRegionStreamingOnly",
            Effect: "Allow",
            Action: ["transcribe:StartStreamTranscription"],
            // This operation has no resource-level ARN. Region and runtime identity
            // are checked separately; this is not an attached permission.
            Resource: "*",
            Condition: {
              StringEquals: { "aws:RequestedRegion": config.region },
            },
          },
        ],
      },
      provisioningPermissionSet: null,
    },
    approvals: {
      resourceCreation: "UNRESOLVED",
      selectedRootIdentity: "APPROVED_BY_USER_FOR_FIXED_REMOTE_SCOPE",
      databaseOperatingAllowanceUsd: null,
      databaseAllowanceIsSeparateFromTranscription: true,
      throughputTargetsAreHardCostCap: false,
      retainedStorageMayChargeAfterServicesStop: true,
      encryptedAccessTokenStorageInAws: "UNRESOLVED",
      fictionalSeedAndBoundedProviderWrites: "UNRESOLVED",
      existingPlaygroundTokenAvailable: "UNRESOLVED",
      newTokenGenerationAuthorizedByThisPlan: false,
    },
    tokenStorage: {
      destinationTable: `${config.tablePrefix}Runtime`,
      material: "AES_ENCRYPTED_ACCESS_TOKEN_ONLY_WHEP_DELETE_COPY",
      maxApplicationValiditySeconds: 60,
      refreshTokenPermitted: false,
      plaintextSecretFilePermitted: false,
      cleanup:
        "Explicitly delete this run's bound cleanup copy, strongly verify absence, then discard the temporary key; retain the key-owning process while cleanup is pending.",
      localApprovalCoversAwsStorage: false,
    },
    budget: {
      maxAttemptSeconds: config.maxAttemptSeconds,
      maxCumulativeSeconds: config.maxSeconds,
      maxCumulativeMicrousd: config.maxMicrousd,
      estimatedMicrousdPerSecond: config.microusdPerSecond,
      previousReservedSeconds: null,
      previousEstimatedMicrousd: null,
      verifiedBaselineSha256: null,
      baselineApproved: false,
      remainingSeconds: null,
      remainingMicrousd: null,
      baselineRequirement:
        "Verify the existing fixed Local ledger and all prior attempts, approve its SHA-256 baseline, and carry its cumulative counters forward. Missing evidence is unresolved, never zero.",
      requiredProcessFields: [
        "CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_SECONDS",
        "CAPTIONDOOR_REMOTE_PROVIDER_PREVIOUS_MICROUSD",
        "CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_SHA256",
        "CAPTIONDOOR_REMOTE_PROVIDER_BASELINE_APPROVAL",
      ],
      resetsExistingLocalRootScope: false,
      actualAwsBillingVerified: false,
    },
    blockers: [
      "DEDICATED_REMOTE_TABLES_NOT_QUERIED_OR_APPROVED",
      "DATABASE_OPERATING_COST_APPROVAL_UNRESOLVED",
      "ENCRYPTED_ACCESS_TOKEN_AWS_STORAGE_APPROVAL_UNRESOLVED",
      "PRIOR_CUMULATIVE_LEDGER_BASELINE_UNVERIFIED",
      "FICTIONAL_SEED_AND_BOUNDED_REMOTE_WRITES_NOT_APPROVED",
      "EXISTING_PLAYGROUND_TOKEN_AND_SELECTED_DEVICE_UNRESOLVED",
      "REMOTE_PROVIDER_IDENTITY_READINESS_AND_RUNTIME_UNVERIFIED",
    ],
  };
}

export function runRemoteProviderPlan(
  args: readonly string[],
  write: (value: string) => void = console.log,
): number {
  if (args.length === 1 && args[0] === "--help") {
    write(
      "Usage: corepack pnpm exec tsx scripts/prepare-remote-provider.ts\nZero-network review plan only; no credentials, AWS calls, IAM changes, resources, services or secrets. Default emits BLOCKED JSON and exits 2 until separately reviewed prerequisites are resolved; it cannot authorize or run a provider test. --help exits 0.",
    );
    return 0;
  }
  if (args.length) {
    write(
      JSON.stringify({
        result: "BLOCKED",
        executionAllowed: false,
        blockers: ["INVALID_REMOTE_PROVIDER_PLAN_ARGUMENTS"],
      }),
    );
    return 2;
  }
  write(JSON.stringify(buildRemoteProviderPlan(), null, 2));
  return 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = runRemoteProviderPlan(process.argv.slice(2));
