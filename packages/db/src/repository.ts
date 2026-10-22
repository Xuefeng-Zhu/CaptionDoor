import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AppError, validateModes } from "@captiondoor/domain";
// Private local files are development-only; production receives process environment.
// Do not let the production file tracer copy a private .env into standalone output.
if (process.env.NODE_ENV !== "production") {
  for (const file of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
  ]) {
    if (existsSync(/* turbopackIgnore: true */ file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        /* Optional local environment file. */
      }
      break;
    }
  }
}
validateModes(process.env);
const endpoint =
  process.env.DYNAMODB_ENDPOINT ||
  (process.env.NODE_ENV === "production" ? undefined : "http://127.0.0.1:8410");
if (
  endpoint &&
  !["127.0.0.1", "localhost", "dynamodb"].includes(new URL(endpoint).hostname)
)
  throw new Error(
    "DYNAMODB_ENDPOINT must be an explicitly isolated local endpoint.",
  );
export const tables = {
  config: process.env.CAPTIONDOOR_CONFIG_TABLE || "CaptionDoorConfig",
  visits: process.env.CAPTIONDOOR_VISITS_TABLE || "CaptionDoorVisits",
  runtime: process.env.CAPTIONDOOR_RUNTIME_TABLE || "CaptionDoorRuntime",
};
export const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(endpoint
    ? {
        endpoint,
        credentials: {
          accessKeyId: "captiondoorlocal",
          secretAccessKey: "captiondoor-local",
        },
      }
    : {}),
});
export const db = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
export type Row = Record<string, any> & { PK: string; SK: string };
export type Key = { PK: string; SK: string };
export const now = () => Date.now();
export const seconds = () => Math.floor(now() / 1000);
export const id = () => randomUUID();
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const visitPK = (householdId: string, visitId: string) =>
  `HOUSEHOLD#${householdId}#VISIT#${visitId}`;
export const threadPK = (householdId: string, threadId: string) =>
  `HOUSEHOLD#${householdId}#THREAD#${threadId}`;
export const householdPK = (householdId: string) => `HOUSEHOLD#${householdId}`;
export const pad = (value: number) => String(value).padStart(16, "0");
export async function getItem(
  table: string,
  PK: string,
  SK: string,
): Promise<Row | undefined> {
  return (
    await db.send(
      new GetCommand({
        TableName: table,
        Key: { PK, SK },
        ConsistentRead: true,
      }),
    )
  ).Item as Row | undefined;
}
export async function queryPK(
  table: string,
  PK: string,
  options: {
    prefix?: string;
    limit?: number;
    cursor?: Key;
    forward?: boolean;
  } = {},
): Promise<{ items: Row[]; cursor?: Key }> {
  const result = await db.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: options.prefix
        ? "PK = :pk AND begins_with(SK, :prefix)"
        : "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": PK,
        ...(options.prefix ? { ":prefix": options.prefix } : {}),
      },
      ConsistentRead: true,
      Limit: options.limit || 50,
      ExclusiveStartKey: options.cursor,
      ScanIndexForward: options.forward ?? true,
    }),
  );
  return {
    items: (result.Items || []) as Row[],
    cursor: result.LastEvaluatedKey as Key | undefined,
  };
}
export async function queryIndex(
  table: string,
  index: string,
  pkName: string,
  pk: string,
  options: { limit?: number; forward?: boolean; upper?: string } = {},
): Promise<Row[]> {
  return (
    ((
      await db.send(
        new QueryCommand({
          TableName: table,
          IndexName: index,
          KeyConditionExpression: `${pkName} = :pk${options.upper ? " AND dueSk <= :upper" : ""}`,
          ExpressionAttributeValues: {
            ":pk": pk,
            ...(options.upper ? { ":upper": options.upper } : {}),
          },
          Limit: options.limit || 30,
          ScanIndexForward: options.forward ?? false,
        }),
      )
    ).Items as Row[]) || []
  );
}
export async function putItem(table: string, item: Row) {
  await db.send(new PutCommand({ TableName: table, Item: item }));
}
export async function deleteItem(table: string, key: Key) {
  await db.send(new DeleteCommand({ TableName: table, Key: key }));
}
export function put(
  table: string,
  item: Row,
  condition?: string,
  values?: Record<string, unknown>,
) {
  return {
    Put: {
      TableName: table,
      Item: item,
      ...(condition
        ? { ConditionExpression: condition, ExpressionAttributeValues: values }
        : {}),
    },
  };
}
export function del(table: string, key: Key) {
  return { Delete: { TableName: table, Key: key } };
}
export function conditionConflict(error: unknown) {
  return (
    error instanceof Error &&
    [
      "TransactionCanceledException",
      "ConditionalCheckFailedException",
      "TransactionConflictException",
    ].includes(error.name)
  );
}
export async function transact(
  items: NonNullable<TransactWriteCommandInput["TransactItems"]>,
) {
  await db.send(new TransactWriteCommand({ TransactItems: items }));
}
export { QueryCommand, UpdateCommand, PutCommand, DeleteCommand };
export type JobType =
  | "NOTIFY"
  | "DELETE_VISIT"
  | "DELETE_THREAD"
  | "PUSH_TEST"
  | "DEMO_CAPTIONS"
  | "RING_MEDIA_CLOSE";
export type Job = Row & {
  id: string;
  type: JobType;
  householdId: string;
  visitId?: string;
  threadId?: string;
  status: "READY" | "LEASED" | "DONE" | "DEAD";
  attempts: number;
  nextAttemptAt: number;
  leaseOwner?: string;
  leaseUntil?: number;
  expiresAt: number;
  category?: string;
  userId?: string;
  sessionId?: string;
  leaseId?: string;
  mediaSessionId?: string;
};
export function makeJob(
  type: JobType,
  householdId: string,
  fields: Record<string, unknown> = {},
  at = now(),
): Job {
  const jobId = id();
  return {
    PK: `JOB#${jobId}`,
    SK: "JOB",
    id: jobId,
    type,
    householdId,
    ...fields,
    status: "READY",
    attempts: 0,
    nextAttemptAt: at,
    duePk: "WORK#0",
    dueSk: `${pad(at)}#${jobId}`,
    createdAt: now(),
    expiresAt: seconds() + 60 * 60 * 24 * 8,
  };
}
export const jobPut = (
  type: JobType,
  householdId: string,
  fields: Record<string, unknown> = {},
  at = now(),
) => put(tables.runtime, makeJob(type, householdId, fields, at));
export function safeError(error: unknown) {
  return error instanceof AppError
    ? error.code
    : error instanceof Error
      ? error.name
      : "UnknownError";
}
