import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRemoteProviderSmokeEnvironment,
  remoteProviderSmokeConfig,
  presets,
} from "@captiondoor/domain";
import {
  resolveDatabaseConfig,
  type DatabaseConfig,
} from "../packages/db/src/config";
import {
  parseProviderSessionLocalArgs,
  verifyScopedProviderSessionCleanup,
} from "./provider-session-local";

type FailureCategory =
  | "REMOTE_PROVIDER_STORAGE_SCOPE_REQUIRED"
  | "REMOTE_PROVIDER_INVALID_ARGUMENTS"
  | "REMOTE_PROVIDER_SEED_TIME_INVALID"
  | "REMOTE_PROVIDER_SEED_COLLISION"
  | "REMOTE_PROVIDER_SEED_EXPIRED"
  | "REMOTE_PROVIDER_TABLE_READINESS_FAILED"
  | "REMOTE_PROVIDER_SEED_PREPARATION_FAILED"
  | "REMOTE_PROVIDER_CLEANUP_FAILED"
  | "REMOTE_PROVIDER_STORAGE_OPERATION_FAILED";
export class ProviderSessionRemoteStorageError extends Error {
  constructor(readonly category: FailureCategory) {
    super(category);
  }
}
export type RemoteProviderSeedRow = Record<string, unknown> & {
  PK: string;
  SK: string;
  providerSeedNamespace: typeof remoteProviderSmokeConfig.tablePrefix;
  providerSeedScope: typeof remoteProviderSmokeConfig.scope;
  providerSeedVersion: 1;
  providerSeedCreatedAt: number;
  expiresAt: number;
};
const seedLifetimeSeconds = 3600;

/** Pure bounded fictional metadata. No sessions, credentials, visits or budget rows. */
export function buildRemoteProviderSeedRows(
  nowSeconds: number,
): RemoteProviderSeedRow[] {
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds <= 0 ||
    !Number.isSafeInteger(nowSeconds + seedLifetimeSeconds)
  )
    throw new ProviderSessionRemoteStorageError(
      "REMOTE_PROVIDER_SEED_TIME_INVALID",
    );
  const rows: RemoteProviderSeedRow[] = [];
  const add = (value: Record<string, unknown> & { PK: string; SK: string }) => {
    rows.push({
      ...value,
      providerSeedNamespace: remoteProviderSmokeConfig.tablePrefix,
      providerSeedScope: remoteProviderSmokeConfig.scope,
      providerSeedVersion: 1,
      providerSeedCreatedAt: nowSeconds,
      expiresAt: nowSeconds + seedLifetimeSeconds,
    });
  };
  for (const household of [
    {
      id: "h1",
      name: "Cedar house (fictional test)",
      doorId: "front-door",
      publicDoorId: "front-demo",
      accountId: "demo-account",
      users: [
        { id: "alex", name: "Alex", role: "owner" },
        { id: "sam", name: "Sam", role: "member" },
      ],
    },
    {
      id: "h2",
      name: "Maple house (fictional test)",
      doorId: "other-door",
      publicDoorId: "other-demo",
      accountId: "demo-account-h2",
      users: [{ id: "jordan", name: "Jordan", role: "owner" }],
    },
  ]) {
    const PK = `HOUSEHOLD#${household.id}`;
    add({
      PK,
      SK: "PROFILE",
      id: household.id,
      name: household.name,
      settings: {
        retentionHours: 1,
        captionSize: 32,
        consent: { ring: false, transcription: false, sharing: false },
        presets: [...presets],
      },
    });
    add({
      PK,
      SK: `DOOR#${household.doorId}`,
      id: household.doorId,
      householdId: household.id,
      name: "Fictional test entrance",
      publicDoorId: household.publicDoorId,
      ringAccountId: household.accountId,
    });
    add({
      PK,
      SK: "INTEGRATION#ring",
      status: "NOT_CONNECTED",
      mode: "playground",
      connected: false,
    });
    add({
      PK: `PUBLICDOOR#${household.publicDoorId}`,
      SK: "LOOKUP",
      householdId: household.id,
      doorId: household.doorId,
    });
    add({
      PK: `RINGACCOUNT#${household.accountId}`,
      SK: "LOOKUP",
      householdId: household.id,
      deviceId: household.doorId,
      doorId: household.doorId,
    });
    for (const user of household.users) {
      add({
        PK,
        SK: `MEMBER#${user.id}`,
        userId: user.id,
        name: user.name,
        role: user.role,
        grants: {
          camera: true,
          captions: true,
          visitorText: true,
          membership: user.role === "owner",
        },
      });
      add({
        PK: `USER#${user.id}`,
        SK: "LOOKUP",
        userId: user.id,
        householdId: household.id,
      });
    }
  }
  add({ PK: "HEALTH", SK: "HEALTH", schemaVersion: 1 });
  return rows;
}

/** Preserve live marked seed rows; never turn an expired seed or foreign row into a fresh one. */
export function assertRemoteProviderSeedCollision(
  expected: RemoteProviderSeedRow,
  existing: Record<string, unknown>,
  nowSeconds: number,
): void {
  if (
    existing.PK !== expected.PK ||
    existing.SK !== expected.SK ||
    existing.providerSeedNamespace !== remoteProviderSmokeConfig.tablePrefix ||
    existing.providerSeedScope !== remoteProviderSmokeConfig.scope ||
    existing.providerSeedVersion !== 1 ||
    !Number.isSafeInteger(existing.providerSeedCreatedAt) ||
    (existing.providerSeedCreatedAt as number) > nowSeconds ||
    !Number.isSafeInteger(existing.expiresAt) ||
    (existing.expiresAt as number) >
      (existing.providerSeedCreatedAt as number) + seedLifetimeSeconds
  )
    throw new ProviderSessionRemoteStorageError(
      "REMOTE_PROVIDER_SEED_COLLISION",
    );
  if ((existing.expiresAt as number) <= nowSeconds)
    throw new ProviderSessionRemoteStorageError("REMOTE_PROVIDER_SEED_EXPIRED");
}

/** Validate the repository's captured target before its first SDK send. */
export function assertRemoteProviderStorageScope(
  env: NodeJS.ProcessEnv,
  captured: DatabaseConfig,
): void {
  try {
    assertRemoteProviderSmokeEnvironment(env);
    const expected = resolveDatabaseConfig(env);
    if (
      captured.mode !== "aws" ||
      captured.environment !== "remote-provider" ||
      captured.mode !== expected.mode ||
      captured.environment !== expected.environment ||
      captured.accountId !== expected.accountId ||
      captured.region !== expected.region ||
      captured.pollIntervalMs !== expected.pollIntervalMs ||
      captured.endpoint !== undefined ||
      Object.entries(expected.tables).some(
        ([kind, name]) =>
          captured.tables[kind as keyof typeof captured.tables] !== name,
      )
    )
      throw new Error();
  } catch {
    throw new ProviderSessionRemoteStorageError(
      "REMOTE_PROVIDER_STORAGE_SCOPE_REQUIRED",
    );
  }
}

async function main(): Promise<number> {
  let client: { destroy(): void } | undefined;
  try {
    let options: ReturnType<typeof parseProviderSessionLocalArgs>;
    try {
      options = parseProviderSessionLocalArgs(process.argv.slice(2));
    } catch {
      throw new ProviderSessionRemoteStorageError(
        "REMOTE_PROVIDER_INVALID_ARGUMENTS",
      );
    }
    // This gate runs before loading the repository or any integration client.
    try {
      assertRemoteProviderSmokeEnvironment(process.env);
    } catch {
      throw new ProviderSessionRemoteStorageError(
        "REMOTE_PROVIDER_STORAGE_SCOPE_REQUIRED",
      );
    }
    const repository = await import("../packages/db/src/repository");
    client = repository.client;
    assertRemoteProviderStorageScope(process.env, repository.databaseConfig);
    const { db, tables } = repository;
    if (options.mode === "setup") {
      try {
        const { DescribeTableCommand, DescribeTimeToLiveCommand } =
          await import("@aws-sdk/client-dynamodb");
        const { verifyTableMetadata, verifyTableTtl } =
          await import("./verify-aws-database");
        for (const [kind, name] of Object.entries(tables)) {
          // The repository client verifies STS non-root identity before each first send.
          const response = await repository.client.send(
            new DescribeTableCommand({ TableName: name }),
            { abortSignal: AbortSignal.timeout(8000) },
          );
          verifyTableMetadata(
            response.Table,
            name,
            kind,
            repository.databaseConfig.accountId!,
            repository.databaseConfig.region,
          );
          const ttl = await repository.client.send(
            new DescribeTimeToLiveCommand({ TableName: name }),
            { abortSignal: AbortSignal.timeout(8000) },
          );
          verifyTableTtl(ttl.TimeToLiveDescription);
        }
      } catch {
        throw new ProviderSessionRemoteStorageError(
          "REMOTE_PROVIDER_TABLE_READINESS_FAILED",
        );
      }
      try {
        const { GetCommand, TransactWriteCommand } =
          await import("@aws-sdk/lib-dynamodb");
        const nowSeconds = Math.floor(Date.now() / 1000);
        const rows = buildRemoteProviderSeedRows(nowSeconds);
        const missing: RemoteProviderSeedRow[] = [];
        const retained: {
          expected: RemoteProviderSeedRow;
          existing: Record<string, unknown>;
        }[] = [];
        for (const row of rows) {
          const existing = (
            await db.send(
              new GetCommand({
                TableName: tables.config,
                Key: { PK: row.PK, SK: row.SK },
                ConsistentRead: true,
              }),
              { abortSignal: AbortSignal.timeout(8000) },
            )
          ).Item;
          if (existing) {
            assertRemoteProviderSeedCollision(row, existing, nowSeconds);
            retained.push({ expected: row, existing });
          } else missing.push(row);
        }
        // Metadata reads can take time. Never report an already expired retained seed as ready.
        const writeTime = Math.floor(Date.now() / 1000);
        for (const row of retained)
          assertRemoteProviderSeedCollision(
            row.expected,
            row.existing,
            writeTime,
          );
        if (missing.some((row) => row.expiresAt <= writeTime))
          throw new ProviderSessionRemoteStorageError(
            "REMOTE_PROVIDER_SEED_EXPIRED",
          );
        if (missing.length)
          await db.send(
            new TransactWriteCommand({
              TransactItems: missing.map((row) => ({
                Put: {
                  TableName: tables.config,
                  Item: row,
                  ConditionExpression:
                    "attribute_not_exists(PK) AND attribute_not_exists(SK)",
                },
              })),
            }),
            { abortSignal: AbortSignal.timeout(8000) },
          );
        console.log(
          JSON.stringify({
            result: "PASS",
            category: "REMOTE_PROVIDER_TABLES_READY",
            tablesChecked: 3,
            seedRowsCreated: missing.length,
            seedRowsRetained: rows.length - missing.length,
          }),
        );
        return 0;
      } catch (error) {
        if (error instanceof ProviderSessionRemoteStorageError) throw error;
        throw new ProviderSessionRemoteStorageError(
          "REMOTE_PROVIDER_SEED_PREPARATION_FAILED",
        );
      }
    }
    try {
      const { QueryCommand, GetCommand } =
        await import("@aws-sdk/lib-dynamodb");
      const { closePersistedMedia } =
        await import("../packages/integrations/src/media-cleanup");
      const result = await verifyScopedProviderSessionCleanup(
        options.scope,
        {
          async queryKeys(table, PK, cursor) {
            const response = await db.send(
              new QueryCommand({
                TableName: tables[table],
                KeyConditionExpression: "PK = :pk",
                ExpressionAttributeValues: { ":pk": PK },
                ProjectionExpression: "PK, SK",
                ConsistentRead: true,
                Limit: 50,
                ExclusiveStartKey: cursor,
              }),
              { abortSignal: AbortSignal.timeout(8000) },
            );
            return {
              keys: (response.Items || []) as { PK: string; SK: string }[],
              cursor: response.LastEvaluatedKey as
                { PK: string; SK: string } | undefined,
            };
          },
          async readMedia(PK) {
            return (
              await db.send(
                new GetCommand({
                  TableName: tables.runtime,
                  Key: { PK, SK: "SESSION" },
                  ConsistentRead: true,
                }),
                { abortSignal: AbortSignal.timeout(8000) },
              )
            ).Item;
          },
          async readVisitState(PK) {
            return (
              await db.send(
                new GetCommand({
                  TableName: tables.visits,
                  Key: { PK, SK: "STATE" },
                  ProjectionExpression:
                    "PK, SK, id, householdId, mediaSessionId",
                  ConsistentRead: true,
                }),
                { abortSignal: AbortSignal.timeout(8000) },
              )
            ).Item;
          },
          closeMedia: closePersistedMedia,
        },
        { recoverMedia: options.recoverMedia },
      );
      console.log(JSON.stringify(result));
      return result.result === "PASS" ? 0 : 3;
    } catch {
      throw new ProviderSessionRemoteStorageError(
        "REMOTE_PROVIDER_CLEANUP_FAILED",
      );
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        result: "BLOCKED",
        category:
          error instanceof ProviderSessionRemoteStorageError
            ? error.category
            : "REMOTE_PROVIDER_STORAGE_OPERATION_FAILED",
      }),
    );
    return 2;
  } finally {
    client?.destroy();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.log(
        JSON.stringify({
          result: "BLOCKED",
          category: "REMOTE_PROVIDER_STORAGE_OPERATION_FAILED",
        }),
      );
      process.exitCode = 2;
    });
