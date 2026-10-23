import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRootSmokeEnvironment } from "@captiondoor/domain";

export class ProviderSessionLocalError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}
export type ProviderSessionCleanupScope = {
  householdId: "h1";
  visitId?: string;
  mediaSessionId?: string;
  mediaAttempted: boolean;
};
type Key = { PK: string; SK: string };
type Page = { keys: Key[]; cursor?: Key };
export type ProviderSessionSetupDependencies = {
  ensureTables(): Promise<void>;
  seedLocal(): Promise<void>;
};
export type ProviderSessionCleanupDependencies = {
  queryKeys(
    table: "visits" | "runtime",
    PK: string,
    cursor?: Key,
  ): Promise<Page>;
  readMedia(PK: string): Promise<Record<string, unknown> | undefined>;
  readVisitState(PK: string): Promise<Record<string, unknown> | undefined>;
  closeMedia(
    householdId: string,
    mediaSessionId: string,
  ): Promise<{
    providerCloseConfirmed?: boolean;
    providerExpiryElapsed?: boolean;
  }>;
};
export type ProviderSessionCleanupResult = {
  result: "PASS" | "PENDING";
  category: string;
  visitRowsRemaining: number;
  runtimeVisitRowsRemaining: number;
  cleanupCredentialsAbsent: boolean;
  providerDeleteObserved: boolean;
  providerExpiryElapsed: boolean;
  cleanupActionUnconfirmed: boolean;
  resolvedMediaSessionId?: string;
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No SDK is loaded until this exact Local-only boundary has passed. */
export function assertSessionLocalScope(env: NodeJS.ProcessEnv): void {
  try {
    assertRootSmokeEnvironment(env);
  } catch {
    throw new ProviderSessionLocalError("FIXED_LOCAL_SESSION_SCOPE_REQUIRED");
  }
}
export async function setupProviderSessionLocal(
  env: NodeJS.ProcessEnv,
  deps: ProviderSessionSetupDependencies,
): Promise<{ result: "PASS"; category: "LOCAL_TABLES_READY" }> {
  assertSessionLocalScope(env);
  try {
    await deps.ensureTables();
    // Existing seedLocal conditionally fills missing fictional rows; it does not reset.
    await deps.seedLocal();
    return { result: "PASS", category: "LOCAL_TABLES_READY" };
  } catch {
    throw new ProviderSessionLocalError("LOCAL_TABLE_PREPARATION_FAILED");
  }
}
function assertCleanupScope(scope: ProviderSessionCleanupScope): void {
  if (
    scope.householdId !== "h1" ||
    typeof scope.mediaAttempted !== "boolean" ||
    (scope.visitId !== undefined && !uuid.test(scope.visitId)) ||
    (scope.mediaSessionId !== undefined && !uuid.test(scope.mediaSessionId)) ||
    (!scope.visitId && (scope.mediaAttempted || !!scope.mediaSessionId)) ||
    (!scope.mediaAttempted && !!scope.mediaSessionId)
  )
    throw new ProviderSessionLocalError("OWN_CLEANUP_SCOPE_UNVERIFIED");
}
async function countPartition(
  table: "visits" | "runtime",
  PK: string,
  deps: ProviderSessionCleanupDependencies,
): Promise<number> {
  let cursor: Key | undefined;
  let total = 0;
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = await deps.queryKeys(table, PK, cursor);
    if (
      result.keys.some((key) => key.PK !== PK || typeof key.SK !== "string") ||
      (result.cursor && result.cursor.PK !== PK)
    )
      throw new ProviderSessionLocalError("CLEANUP_QUERY_SCOPE_MISMATCH");
    total += result.keys.length;
    if (!result.cursor) return total;
    const encoded = JSON.stringify(result.cursor);
    if (cursors.has(encoded))
      throw new ProviderSessionLocalError("CLEANUP_QUERY_BOUND_EXCEEDED");
    cursors.add(encoded);
    cursor = result.cursor;
  }
  throw new ProviderSessionLocalError("CLEANUP_QUERY_BOUND_EXCEEDED");
}
function assertMediaBinding(
  row: Record<string, unknown>,
  scope: ProviderSessionCleanupScope,
): void {
  if (
    row.PK !== `MEDIA#h1#${scope.mediaSessionId}` ||
    row.SK !== "SESSION" ||
    row.householdId !== "h1" ||
    row.mediaSessionId !== scope.mediaSessionId ||
    row.visitId !== scope.visitId ||
    row.cleanupSource !== "PLAYGROUND"
  )
    throw new ProviderSessionLocalError("CLEANUP_MEDIA_BINDING_MISMATCH");
}
/** Read only by default. A recovery uses only the existing scoped DELETE handler. */
export async function verifyProviderSessionCleanup(
  env: NodeJS.ProcessEnv,
  scope: ProviderSessionCleanupScope,
  deps: ProviderSessionCleanupDependencies,
  options: { recoverMedia?: boolean } = {},
): Promise<ProviderSessionCleanupResult> {
  assertSessionLocalScope(env);
  return verifyScopedProviderSessionCleanup(scope, deps, options);
}

/** Shared exact-key verifier. Callers must validate their captured storage scope first. */
export async function verifyScopedProviderSessionCleanup(
  scope: ProviderSessionCleanupScope,
  deps: ProviderSessionCleanupDependencies,
  options: { recoverMedia?: boolean } = {},
): Promise<ProviderSessionCleanupResult> {
  assertCleanupScope(scope);
  const summary: ProviderSessionCleanupResult = {
    result: "PASS",
    category: "CLEANUP_CONFIRMED",
    visitRowsRemaining: 0,
    runtimeVisitRowsRemaining: 0,
    cleanupCredentialsAbsent: true,
    providerDeleteObserved: false,
    providerExpiryElapsed: false,
    cleanupActionUnconfirmed: false,
  };
  if (!scope.visitId) return summary; // Trusted harness reports no visit/media was created.
  try {
    const PK = `HOUSEHOLD#h1#VISIT#${scope.visitId}`;
    summary.visitRowsRemaining = await countPartition("visits", PK, deps);
    summary.runtimeVisitRowsRemaining = await countPartition(
      "runtime",
      PK,
      deps,
    );
    let resolvedScope = scope;
    if (scope.mediaAttempted && !scope.mediaSessionId) {
      const ownState = await deps.readVisitState(PK);
      if (ownState) {
        if (
          ownState.PK !== PK ||
          ownState.SK !== "STATE" ||
          ownState.id !== scope.visitId ||
          ownState.householdId !== "h1"
        )
          throw new ProviderSessionLocalError("CLEANUP_VISIT_BINDING_MISMATCH");
        if (
          typeof ownState.mediaSessionId === "string" &&
          uuid.test(ownState.mediaSessionId)
        )
          resolvedScope = { ...scope, mediaSessionId: ownState.mediaSessionId };
      }
      if (!resolvedScope.mediaSessionId) {
        return {
          ...summary,
          result: "PENDING",
          category: "MEDIA_SCOPE_UNVERIFIED",
          cleanupCredentialsAbsent: false,
        };
      }
    }
    if (resolvedScope.mediaSessionId) {
      summary.resolvedMediaSessionId = resolvedScope.mediaSessionId;
      const mediaPK = `MEDIA#h1#${resolvedScope.mediaSessionId}`;
      let row = await deps.readMedia(mediaPK);
      if (row) {
        assertMediaBinding(row, resolvedScope);
        if (options.recoverMedia) {
          try {
            const closed = await deps.closeMedia(
              "h1",
              resolvedScope.mediaSessionId,
            );
            summary.providerDeleteObserved =
              closed.providerCloseConfirmed === true;
            summary.providerExpiryElapsed =
              closed.providerExpiryElapsed === true;
          } catch {
            // A transport/write error may have an uncertain outcome. Strongly re-read
            // before any later attempt; never print provider errors or supplied input.
            summary.cleanupActionUnconfirmed = true;
          }
          row = await deps.readMedia(mediaPK);
          if (row) assertMediaBinding(row, resolvedScope);
        }
      }
      summary.cleanupCredentialsAbsent = !row;
    }
    if (!summary.cleanupCredentialsAbsent) {
      summary.result = "PENDING";
      summary.category = "MEDIA_CLEANUP_COPY_REMAINS";
    } else if (
      summary.visitRowsRemaining ||
      summary.runtimeVisitRowsRemaining
    ) {
      summary.result = "PENDING";
      summary.category = "OWN_CONTENT_DELETION_PENDING";
    }
    return summary;
  } catch (error) {
    if (error instanceof ProviderSessionLocalError) throw error;
    throw new ProviderSessionLocalError("LOCAL_CLEANUP_READ_FAILED");
  }
}

export function parseProviderSessionLocalArgs(args: string[]):
  | { mode: "setup" }
  | {
      mode: "verify-cleanup";
      scope: ProviderSessionCleanupScope;
      recoverMedia: boolean;
    } {
  if (args.length === 1 && args[0] === "setup") return { mode: "setup" };
  if (args[0] !== "verify-cleanup")
    throw new ProviderSessionLocalError("INVALID_LOCAL_SESSION_ARGUMENTS");
  const scope: ProviderSessionCleanupScope = {
    householdId: "h1",
    mediaAttempted: false,
  };
  let recoverMedia = false;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg))
      throw new ProviderSessionLocalError("INVALID_LOCAL_SESSION_ARGUMENTS");
    seen.add(arg);
    if (arg === "--media-attempted") scope.mediaAttempted = true;
    else if (arg === "--recover-media") recoverMedia = true;
    else if (arg === "--visit-id" || arg === "--media-session-id") {
      const value = args[++i];
      if (!value || !uuid.test(value))
        throw new ProviderSessionLocalError("INVALID_LOCAL_SESSION_ARGUMENTS");
      if (arg === "--visit-id") scope.visitId = value;
      else scope.mediaSessionId = value;
    } else
      throw new ProviderSessionLocalError("INVALID_LOCAL_SESSION_ARGUMENTS");
  }
  assertCleanupScope(scope);
  return { mode: "verify-cleanup", scope, recoverMedia };
}
async function main(): Promise<number> {
  try {
    const options = parseProviderSessionLocalArgs(process.argv.slice(2));
    assertSessionLocalScope(process.env);
    if (options.mode === "setup") {
      const { ensureTables, seedLocal } = await import("./setup-local");
      const result = await setupProviderSessionLocal(process.env, {
        async ensureTables() {
          const previous = console.info;
          console.info = () => {};
          try {
            await ensureTables();
          } finally {
            console.info = previous;
          }
        },
        seedLocal,
      });
      console.log(JSON.stringify(result));
      return 0;
    }
    const { db, tables } = await import("../packages/db/src/repository");
    const { QueryCommand, GetCommand } = await import("@aws-sdk/lib-dynamodb");
    const { closePersistedMedia } =
      await import("../packages/integrations/src/media-cleanup");
    const result = await verifyProviderSessionCleanup(
      process.env,
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
          );
          return {
            keys: (response.Items || []) as Key[],
            cursor: response.LastEvaluatedKey as Key | undefined,
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
            )
          ).Item;
        },
        async readVisitState(PK) {
          return (
            await db.send(
              new GetCommand({
                TableName: tables.visits,
                Key: { PK, SK: "STATE" },
                ProjectionExpression: "PK, SK, id, householdId, mediaSessionId",
                ConsistentRead: true,
              }),
            )
          ).Item;
        },
        closeMedia: closePersistedMedia,
      },
      { recoverMedia: options.recoverMedia },
    );
    console.log(JSON.stringify(result));
    return result.result === "PASS" ? 0 : 3;
  } catch (error) {
    console.log(
      JSON.stringify({
        result: "BLOCKED",
        category:
          error instanceof ProviderSessionLocalError
            ? error.category
            : "LOCAL_SESSION_OPERATION_FAILED",
      }),
    );
    return 2;
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
          category: "LOCAL_SESSION_OPERATION_FAILED",
        }),
      );
      process.exitCode = 2;
    });
