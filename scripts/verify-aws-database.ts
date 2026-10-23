import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  type KeySchemaElement,
  type TableDescription,
  type TimeToLiveDescription,
} from "@aws-sdk/client-dynamodb";

const failures = {
  mode: "db:verify requires explicit approved AWS process configuration; local .env is not loaded.",
  environment:
    "This readiness command is restricted to the reviewed remote-demo database.",
  arguments: "db:verify accepts no arguments other than --help.",
  kind: "AWS table kind is outside the reviewed three-table plan.",
  target: "AWS table is missing, inactive or outside the approved target.",
  keys: "AWS table key attributes or schema are incompatible.",
  settings:
    "AWS table billing, class or deletion protection differs from the approved plan.",
  indexes: "AWS indexes are missing, inactive or incompatible.",
  region: "AWS table replication differs from the reviewed single-Region plan.",
  encryption:
    "AWS table encryption metadata differs from the reviewed AWS-owned-key plan.",
  stream: "AWS stream configuration differs from the approved plan.",
  capacity: "AWS table/index throughput targets differ from the reviewed plan.",
  ttl: "AWS application expiry TTL is not yet enabled on expiresAt.",
} as const;
type Failure = keyof typeof failures;
class ReadinessError extends Error {
  constructor(failure: Failure) {
    super(failures[failure]);
  }
}
function fail(failure: Failure): never {
  throw new ReadinessError(failure);
}

const plans = {
  config: { attributes: ["PK", "SK"] },
  visits: {
    attributes: ["PK", "SK", "gsi1pk", "gsi1sk"],
    index: { name: "household-time", keys: "gsi1pk:HASH,gsi1sk:RANGE" },
  },
  runtime: {
    attributes: ["PK", "SK", "duePk", "dueSk"],
    index: { name: "due-work", keys: "duePk:HASH,dueSk:RANGE" },
  },
} as const;
const keys = (value: KeySchemaElement[] | undefined) =>
  value
    ?.map((key) => `${key.AttributeName}:${key.KeyType}`)
    .sort()
    .join(",");

/** Validate DescribeTable metadata only; this does not inspect content, PITR or CloudFormation retention. */
export function verifyTableMetadata(
  table: TableDescription | undefined,
  name: string,
  kind: string,
  account: string,
  region: string,
): void {
  if (!Object.hasOwn(plans, kind)) fail("kind");
  const plan = plans[kind as keyof typeof plans];
  const tableArn = `arn:aws:dynamodb:${region}:${account}:table/${name}`;
  if (
    !/^\d{12}$/.test(account) ||
    !/^[a-z]{2}-[a-z]+-\d$/.test(region) ||
    !/^[A-Za-z0-9_.-]{3,255}$/.test(name) ||
    !table ||
    table.TableName !== name ||
    table.TableStatus !== "ACTIVE" ||
    table.TableArn !== tableArn
  )
    fail("target");
  const definitions = table.AttributeDefinitions || [];
  if (
    keys(table.KeySchema) !== "PK:HASH,SK:RANGE" ||
    definitions.length !== plan.attributes.length ||
    new Set(definitions.map((attribute) => attribute.AttributeName)).size !==
      definitions.length ||
    !plan.attributes.every((name) =>
      definitions.some(
        (attribute) =>
          attribute.AttributeName === name && attribute.AttributeType === "S",
      ),
    )
  )
    fail("keys");
  if (
    table.BillingModeSummary?.BillingMode !== "PAY_PER_REQUEST" ||
    (table.TableClassSummary?.TableClass || "STANDARD") !== "STANDARD" ||
    table.DeletionProtectionEnabled !== true
  )
    fail("settings");
  if (
    table.Replicas?.length ||
    table.GlobalTableVersion ||
    table.GlobalTableWitnesses?.length
  )
    fail("region");
  const indexes = table.GlobalSecondaryIndexes || [];
  const expected = "index" in plan ? plan.index : undefined;
  const index = indexes[0];
  if (
    table.LocalSecondaryIndexes?.length ||
    (expected
      ? indexes.length !== 1 ||
        index.IndexName !== expected.name ||
        index.IndexArn !== `${tableArn}/index/${expected.name}` ||
        index.IndexStatus !== "ACTIVE" ||
        index.Backfilling === true ||
        keys(index.KeySchema) !== expected.keys ||
        index.Projection?.ProjectionType !== "KEYS_ONLY" ||
        Boolean(index.Projection.NonKeyAttributes?.length)
      : indexes.length !== 0)
  )
    fail("indexes");
  // AWS-owned encryption is the default and may have no SSEDescription. If metadata is present,
  // reject KMS keys and transitions; absence is not an independent cryptographic verification.
  const encryption = table.SSEDescription;
  if (
    encryption &&
    (encryption.SSEType !== "AES256" ||
      encryption.Status !== "ENABLED" ||
      encryption.KMSMasterKeyArn ||
      encryption.InaccessibleEncryptionDateTime)
  )
    fail("encryption");
  if (
    kind === "runtime"
      ? table.StreamSpecification?.StreamEnabled !== true ||
        table.StreamSpecification.StreamViewType !== "KEYS_ONLY"
      : table.StreamSpecification?.StreamEnabled === true
  )
    fail("stream");
  for (const target of [table, ...indexes]) {
    if (
      target.OnDemandThroughput?.MaxReadRequestUnits !== 50 ||
      target.OnDemandThroughput.MaxWriteRequestUnits !== 50
    )
      fail("capacity");
  }
}

export function verifyTableTtl(ttl: TimeToLiveDescription | undefined): void {
  if (ttl?.AttributeName !== "expiresAt" || ttl.TimeToLiveStatus !== "ENABLED")
    fail("ttl");
}

/** Only errors created by this verifier may supply printable text; SDK errors can contain secrets. */
export function readinessFailureMessage(error: unknown): string {
  return error instanceof ReadinessError
    ? error.message
    : "AWS database readiness was not verified. Check the approved target, non-root session and scoped metadata permissions. No writes were made.";
}

export async function runReadinessCommand(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: corepack pnpm db:verify\nRead-only STS/account/non-root and three-table DescribeTable/TTL checks. Requires explicitly approved AWS configuration; no table creation, content read, seed or write. Does not verify PITR or CloudFormation retention.",
    );
    return;
  }
  if (args.length) fail("arguments");
  if (process.env.CAPTIONDOOR_DB_MODE !== "aws") fail("mode");
  const { client, databaseConfig: config } =
    await import("../packages/db/src/repository");
  try {
    if (config.environment !== "remote-demo") fail("environment");
    for (const [kind, name] of Object.entries(config.tables)) {
      const response = await client.send(
        new DescribeTableCommand({ TableName: name }),
        { abortSignal: AbortSignal.timeout(8000) },
      );
      verifyTableMetadata(
        response.Table,
        name,
        kind,
        config.accountId!,
        config.region,
      );
      const ttl = await client.send(
        new DescribeTimeToLiveCommand({ TableName: name }),
        { abortSignal: AbortSignal.timeout(8000) },
      );
      verifyTableTtl(ttl.TimeToLiveDescription);
    }
    console.log(
      JSON.stringify({
        result: "PASS",
        operation: "read-only-database-readiness",
        mode: config.mode,
        environment: config.environment,
        region: config.region,
        tablesChecked: 3,
        writes: 0,
        contentReads: 0,
      }),
    );
  } finally {
    client.destroy();
  }
}

export function isReadinessEntrypoint(
  entry: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  return Boolean(entry && resolve(entry) === fileURLToPath(moduleUrl));
}
if (isReadinessEntrypoint(process.argv[1]))
  void runReadinessCommand().catch((error: unknown) => {
    console.error(readinessFailureMessage(error));
    process.exitCode = 1;
  });
