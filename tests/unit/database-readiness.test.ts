import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TableDescription,
  TimeToLiveDescription,
} from "@aws-sdk/client-dynamodb";
import {
  isReadinessEntrypoint,
  readinessFailureMessage,
  runReadinessCommand,
  verifyTableMetadata,
  verifyTableTtl,
} from "../../scripts/verify-aws-database";

// These are metadata contract fixtures, never an AWS/DynamoDB persistence substitute.
const repository = vi.hoisted(() => ({ imports: 0 }));
vi.mock("../../packages/db/src/repository", () => {
  repository.imports++;
  throw new Error(
    "The readiness fixture tests must never initialize a database client.",
  );
});
const account = "123456789012";
const region = "us-east-1";
type Kind = "config" | "visits" | "runtime";
const names = {
  config: "CaptionDoorDevConfig",
  visits: "CaptionDoorDevVisits",
  runtime: "CaptionDoorDevRuntime",
};
function metadata(kind: Kind): TableDescription {
  const name = names[kind];
  const index =
    kind === "visits"
      ? { name: "household-time", pk: "gsi1pk", sk: "gsi1sk" }
      : kind === "runtime"
        ? { name: "due-work", pk: "duePk", sk: "dueSk" }
        : undefined;
  const arn = `arn:aws:dynamodb:${region}:${account}:table/${name}`;
  return {
    TableName: name,
    TableArn: arn,
    TableStatus: "ACTIVE",
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      "PK",
      "SK",
      ...(index ? [index.pk, index.sk] : []),
    ].map((name) => ({ AttributeName: name, AttributeType: "S" })),
    BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
    TableClassSummary: { TableClass: "STANDARD" },
    DeletionProtectionEnabled: true,
    OnDemandThroughput: { MaxReadRequestUnits: 50, MaxWriteRequestUnits: 50 },
    GlobalSecondaryIndexes: index
      ? [
          {
            IndexName: index.name,
            IndexArn: `${arn}/index/${index.name}`,
            IndexStatus: "ACTIVE",
            KeySchema: [
              { AttributeName: index.pk, KeyType: "HASH" },
              { AttributeName: index.sk, KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "KEYS_ONLY" },
            OnDemandThroughput: {
              MaxReadRequestUnits: 50,
              MaxWriteRequestUnits: 50,
            },
          },
        ]
      : [],
    StreamSpecification:
      kind === "runtime"
        ? { StreamEnabled: true, StreamViewType: "KEYS_ONLY" }
        : { StreamEnabled: false },
  };
}
const verify = (table: TableDescription | undefined, kind: Kind = "visits") =>
  verifyTableMetadata(table, names[kind], kind, account, region);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("read-only AWS three-table metadata contract fixtures", () => {
  it.each<Kind>(["config", "visits", "runtime"])(
    "accepts the reviewed %s table metadata",
    (kind) => {
      expect(() => verify(metadata(kind), kind)).not.toThrow();
    },
  );
  it("accepts unordered attribute/key metadata and the omitted default STANDARD class", () => {
    const table = metadata("visits");
    table.AttributeDefinitions!.reverse();
    table.KeySchema!.reverse();
    table.GlobalSecondaryIndexes![0].KeySchema!.reverse();
    delete table.TableClassSummary;
    expect(() => verify(table)).not.toThrow();
  });
  it("accepts an explicit ready AES256 description without a KMS key", () => {
    const table = metadata("visits");
    table.SSEDescription = { SSEType: "AES256", Status: "ENABLED" };
    expect(() => verify(table)).not.toThrow();
  });
  it.each(["unknown", "constructor", "__proto__"])(
    "rejects unknown kind %s instead of treating it as config",
    (kind) => {
      expect(() =>
        verifyTableMetadata(
          metadata("config"),
          names.config,
          kind,
          account,
          region,
        ),
      ).toThrow("kind");
    },
  );
  it("rejects missing table metadata", () => {
    expect(() => verify(undefined)).toThrow("missing");
  });
  it.each([
    ["wrong account", "999999999999", region, names.visits],
    ["invalid account", "123", region, names.visits],
    ["wrong Region", account, "us-west-2", names.visits],
    ["invalid Region", account, "not-a-region", names.visits],
    ["wrong table name", account, region, "CaptionDoorDevOther"],
    ["invalid table name", account, region, "x/y"],
  ])(
    "rejects an unapproved target: %s",
    (_label, expectedAccount, expectedRegion, expectedName) => {
      expect(() =>
        verifyTableMetadata(
          metadata("visits"),
          expectedName,
          "visits",
          expectedAccount,
          expectedRegion,
        ),
      ).toThrow("approved target");
    },
  );

  const cases: {
    label: string;
    kind?: Kind;
    change: (table: TableDescription) => void;
    error: string;
  }[] = [
    {
      label: "wrong table name in response",
      change: (t) => {
        t.TableName = "Other";
      },
      error: "approved target",
    },
    {
      label: "creating table",
      change: (t) => {
        t.TableStatus = "CREATING";
      },
      error: "inactive",
    },
    {
      label: "missing table ARN",
      change: (t) => {
        delete t.TableArn;
      },
      error: "approved target",
    },
    {
      label: "wrong ARN partition",
      change: (t) => {
        t.TableArn = t.TableArn!.replace("arn:aws:", "arn:aws-cn:");
      },
      error: "approved target",
    },
    {
      label: "wrong ARN service",
      change: (t) => {
        t.TableArn = t.TableArn!.replace(":dynamodb:", ":other:");
      },
      error: "approved target",
    },
    {
      label: "wrong ARN account",
      change: (t) => {
        t.TableArn = t.TableArn!.replace(account, "999999999999");
      },
      error: "approved target",
    },
    {
      label: "wrong ARN Region",
      change: (t) => {
        t.TableArn = t.TableArn!.replace(region, "us-west-2");
      },
      error: "approved target",
    },
    {
      label: "an index ARN in place of table ARN",
      change: (t) => {
        t.TableArn += "/index/household-time";
      },
      error: "approved target",
    },
    {
      label: "reversed table key roles",
      change: (t) => {
        t.KeySchema![0].KeyType = "RANGE";
        t.KeySchema![1].KeyType = "HASH";
      },
      error: "key attributes",
    },
    {
      label: "missing table sort key",
      change: (t) => {
        t.KeySchema!.pop();
      },
      error: "key attributes",
    },
    {
      label: "numeric table key",
      change: (t) => {
        t.AttributeDefinitions![0].AttributeType = "N";
      },
      error: "key attributes",
    },
    {
      label: "binary index key",
      change: (t) => {
        t.AttributeDefinitions![2].AttributeType = "B";
      },
      error: "key attributes",
    },
    {
      label: "missing index key attribute",
      change: (t) => {
        t.AttributeDefinitions!.pop();
      },
      error: "key attributes",
    },
    {
      label: "duplicate key attribute",
      change: (t) => {
        t.AttributeDefinitions![3] = { ...t.AttributeDefinitions![2] };
      },
      error: "key attributes",
    },
    {
      label: "extra key attribute",
      change: (t) => {
        t.AttributeDefinitions!.push({
          AttributeName: "extra",
          AttributeType: "S",
        });
      },
      error: "key attributes",
    },
    {
      label: "provisioned billing",
      change: (t) => {
        t.BillingModeSummary!.BillingMode = "PROVISIONED";
      },
      error: "billing",
    },
    {
      label: "unknown billing mode",
      change: (t) => {
        delete t.BillingModeSummary;
      },
      error: "billing",
    },
    {
      label: "infrequent-access table class",
      change: (t) => {
        t.TableClassSummary!.TableClass = "STANDARD_INFREQUENT_ACCESS";
      },
      error: "billing",
    },
    {
      label: "disabled deletion protection",
      change: (t) => {
        t.DeletionProtectionEnabled = false;
      },
      error: "deletion protection",
    },
    {
      label: "unverified deletion protection",
      change: (t) => {
        delete t.DeletionProtectionEnabled;
      },
      error: "deletion protection",
    },
    {
      label: "global replica",
      change: (t) => {
        t.Replicas = [{ RegionName: "us-west-2" }];
      },
      error: "single-Region",
    },
    {
      label: "global table version",
      change: (t) => {
        t.GlobalTableVersion = "2019.11.21";
      },
      error: "single-Region",
    },
    {
      label: "global table witness",
      change: (t) => {
        t.GlobalTableWitnesses = [{ RegionName: "us-west-2" }];
      },
      error: "single-Region",
    },
    {
      label: "missing required index",
      change: (t) => {
        delete t.GlobalSecondaryIndexes;
      },
      error: "indexes",
    },
    {
      label: "extra global index",
      change: (t) => {
        t.GlobalSecondaryIndexes!.push({ ...t.GlobalSecondaryIndexes![0] });
      },
      error: "indexes",
    },
    {
      label: "local index",
      change: (t) => {
        t.LocalSecondaryIndexes = [{ IndexName: "extra" }];
      },
      error: "indexes",
    },
    {
      label: "unexpected config index",
      kind: "config",
      change: (t) => {
        t.GlobalSecondaryIndexes = [{ IndexName: "extra" }];
      },
      error: "indexes",
    },
    {
      label: "wrong index name",
      change: (t) => {
        t.GlobalSecondaryIndexes![0].IndexName = "due-work";
      },
      error: "indexes",
    },
    {
      label: "wrong index ARN target",
      change: (t) => {
        t.GlobalSecondaryIndexes![0].IndexArn =
          t.GlobalSecondaryIndexes![0].IndexArn!.replace(
            account,
            "999999999999",
          );
      },
      error: "indexes",
    },
    {
      label: "missing index ARN",
      change: (t) => {
        delete t.GlobalSecondaryIndexes![0].IndexArn;
      },
      error: "indexes",
    },
    {
      label: "creating index",
      change: (t) => {
        t.GlobalSecondaryIndexes![0].IndexStatus = "CREATING";
      },
      error: "indexes",
    },
    {
      label: "backfilling index",
      change: (t) => {
        t.GlobalSecondaryIndexes![0].Backfilling = true;
      },
      error: "indexes",
    },
    {
      label: "wrong index key schema",
      change: (t) => {
        t.GlobalSecondaryIndexes![0].KeySchema![1].AttributeName = "wrong";
      },
      error: "indexes",
    },
    {
      label: "ALL index projection",
      change: (t) => {
        t.GlobalSecondaryIndexes![0].Projection!.ProjectionType = "ALL";
      },
      error: "indexes",
    },
    {
      label: "missing index projection",
      change: (t) => {
        delete t.GlobalSecondaryIndexes![0].Projection;
      },
      error: "indexes",
    },
    {
      label: "extra index projected content",
      change: (t) => {
        t.GlobalSecondaryIndexes![0].Projection!.NonKeyAttributes = ["message"];
      },
      error: "indexes",
    },
    {
      label: "unexpected config stream",
      kind: "config",
      change: (t) => {
        t.StreamSpecification = {
          StreamEnabled: true,
          StreamViewType: "KEYS_ONLY",
        };
      },
      error: "stream",
    },
    {
      label: "unexpected visits stream",
      change: (t) => {
        t.StreamSpecification = {
          StreamEnabled: true,
          StreamViewType: "KEYS_ONLY",
        };
      },
      error: "stream",
    },
    {
      label: "missing runtime stream",
      kind: "runtime",
      change: (t) => {
        delete t.StreamSpecification;
      },
      error: "stream",
    },
    {
      label: "disabled runtime stream",
      kind: "runtime",
      change: (t) => {
        t.StreamSpecification!.StreamEnabled = false;
      },
      error: "stream",
    },
    {
      label: "runtime stream includes content",
      kind: "runtime",
      change: (t) => {
        t.StreamSpecification!.StreamViewType = "NEW_IMAGE";
      },
      error: "stream",
    },
    {
      label: "unreviewed KMS encryption",
      change: (t) => {
        t.SSEDescription = {
          Status: "ENABLED",
          SSEType: "KMS",
          KMSMasterKeyArn: "fixture-key",
        };
      },
      error: "encryption",
    },
    {
      label: "inaccessible encryption",
      change: (t) => {
        t.SSEDescription = {
          Status: "ENABLED",
          SSEType: "AES256",
          InaccessibleEncryptionDateTime: new Date(),
        };
      },
      error: "encryption",
    },
    {
      label: "changing encryption",
      change: (t) => {
        t.SSEDescription = { Status: "UPDATING", SSEType: "AES256" };
      },
      error: "encryption",
    },
    {
      label: "unknown encryption description",
      change: (t) => {
        t.SSEDescription = {};
      },
      error: "encryption",
    },
  ];
  it.each(cases)("rejects $label", ({ kind = "visits", change, error }) => {
    const table = metadata(kind);
    change(table);
    expect(() => verify(table, kind)).toThrow(error);
  });
  it.each<Kind>(["config", "visits", "runtime"])(
    "requires both reviewed table capacity ceilings on %s",
    (kind) => {
      for (const cap of [undefined, -1, 0, 49, 51])
        for (const key of [
          "MaxReadRequestUnits",
          "MaxWriteRequestUnits",
        ] as const) {
          const table = metadata(kind);
          table.OnDemandThroughput![key] = cap;
          expect(() => verify(table, kind)).toThrow("throughput");
        }
    },
  );
  it.each<Kind>(["visits", "runtime"])(
    "requires both reviewed index capacity ceilings on %s",
    (kind) => {
      for (const cap of [undefined, -1, 0, 49, 51])
        for (const key of [
          "MaxReadRequestUnits",
          "MaxWriteRequestUnits",
        ] as const) {
          const table = metadata(kind);
          table.GlobalSecondaryIndexes![0].OnDemandThroughput![key] = cap;
          expect(() => verify(table, kind)).toThrow("throughput");
        }
    },
  );
});

describe("TTL and safe command entry", () => {
  it("accepts ENABLED expiresAt TTL", () => {
    expect(() =>
      verifyTableTtl({
        AttributeName: "expiresAt",
        TimeToLiveStatus: "ENABLED",
      }),
    ).not.toThrow();
  });
  it.each<TimeToLiveDescription | undefined>([
    undefined,
    {},
    { AttributeName: "other", TimeToLiveStatus: "ENABLED" },
    { TimeToLiveStatus: "ENABLED" },
    ...(["ENABLING", "DISABLING", "DISABLED"] as const).map(
      (TimeToLiveStatus) => ({ AttributeName: "expiresAt", TimeToLiveStatus }),
    ),
  ])("rejects missing, wrong or transitional TTL %#", (ttl) => {
    expect(() => verifyTableTtl(ttl)).toThrow("expiresAt");
  });
  it("does not initialize a client on import, help, invalid arguments or local mode", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("CAPTIONDOOR_DB_MODE", "local");
    await runReadinessCommand(["--help"]);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("no table creation"),
    );
    await expect(runReadinessCommand(["--unknown"])).rejects.toThrow(
      "arguments",
    );
    await expect(runReadinessCommand([])).rejects.toThrow(
      "explicit approved AWS",
    );
    expect(repository.imports).toBe(0);
  });
  it("only runs directly from this exact entry file, avoiding same-basename import side effects", () => {
    const url = "file:///project/scripts/verify-aws-database.ts";
    expect(
      isReadinessEntrypoint("/project/scripts/verify-aws-database.ts", url),
    ).toBe(true);
    expect(
      isReadinessEntrypoint("/unrelated/scripts/verify-aws-database.ts", url),
    ).toBe(false);
    expect(isReadinessEntrypoint(undefined, url)).toBe(false);
  });
  it.each([
    new Error("AWS table fixture-secret-never-print"),
    new Error("db:verify fixture-secret-never-print"),
    "fixture-secret-never-print",
    { message: "AWS indexes fixture-secret-never-print" },
  ])("redacts arbitrary external errors %#", (error) => {
    expect(readinessFailureMessage(error)).toBe(
      "AWS database readiness was not verified. Check the approved target, non-root session and scoped metadata permissions. No writes were made.",
    );
  });
  it("retains only internally constructed validation messages", () => {
    let error: unknown;
    try {
      verify(undefined);
    } catch (failure) {
      error = failure;
    }
    expect(readinessFailureMessage(error)).toBe(
      "AWS table is missing, inactive or outside the approved target.",
    );
  });
});
