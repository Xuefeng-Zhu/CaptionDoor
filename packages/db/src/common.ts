import {
  AppError,
  presets,
  type Actor,
  type Visit,
  type Thread,
  type ConversationItem,
  type Bootstrap,
  type VisitView,
  type GuestView,
  type Settings,
} from "@captiondoor/domain";
import {
  commandSchema,
  guestMessageSchema,
  settingsSchema,
  type VisitCommand,
  type SettingsInput,
} from "@captiondoor/contracts";
import {
  type Row,
  type Key,
  type Job,
  tables,
  db,
  getItem,
  queryPK,
  queryIndex,
  putItem,
  deleteItem,
  put,
  del,
  transact,
  conditionConflict,
  seconds,
  now,
  id,
  pad,
  visitPK,
  threadPK,
  householdPK,
  hashToken,
  makeJob,
  jobPut,
  UpdateCommand,
  PutCommand,
} from "./repository";
import {
  authenticate,
  sessionFromId,
  createResidentSession,
  demoLogin,
  createGuest,
  refresh,
  resident,
  member,
  authConditions,
  revokeSession,
  rateLimit,
  secret,
} from "./auth";
export const ttl = (hours = 24) => seconds() + hours * 3600;

export const wsUrl = () =>
  process.env.WS_PUBLIC_URL || "ws://127.0.0.1:3411/ws";

export function clean<T>(row: Row): T {
  const { PK, SK, gsi1pk, gsi1sk, sessionId, ...value } = row;
  return value as T;
}

export async function rows(
  table: string,
  PK: string,
  prefix?: string,
): Promise<Row[]> {
  const all: Row[] = [];
  let cursor: Key | undefined;
  do {
    const page = await queryPK(table, PK, { prefix, limit: 100, cursor });
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor && all.length < 1000);
  return all;
}

export async function profile(householdId: string) {
  const row = await getItem(tables.config, householdPK(householdId), "PROFILE");
  if (!row) throw new AppError("NOT_FOUND", 404, "Household is unavailable.");
  return row;
}

export async function rawVisit(householdId: string, visitId: string) {
  const row = await getItem(
    tables.visits,
    visitPK(householdId, visitId),
    "STATE",
  );
  if (!row || row.deleted || row.expiresAt <= seconds())
    throw new AppError("NOT_FOUND", 404, "Visit is unavailable or expired.");
  if (row.historyVersion !== 2) {
    await ensureTimeline(row.PK);
    row.historyVersion = 2;
  }
  return row;
}

export function viewVisit(row: Row, actor: Actor, content = true): Visit {
  const value = clean<Visit & { historyVersion?: number }>(row);
  delete value.historyVersion;
  if (!actor.grants.camera || !content) {
    delete value.mediaSessionId;
    delete value.audioLease;
    value.mediaStatus = "UNAVAILABLE";
  }
  return value;
}

export function assertHandler(actor: Actor, visit: Visit) {
  if (visit.status !== "CLAIMED" || visit.handlerId !== actor.userId)
    throw new AppError(
      "NOT_HANDLER",
      403,
      "Only the current handler can do this.",
    );
}

export function audit(v: Visit, text: string): Row {
  return {
    PK: visitPK(v.householdId, v.id),
    SK: `EVENT#${pad(v.version)}#${id()}`,
    id: id(),
    kind: "event",
    text,
    version: v.version,
    createdAt: now(),
    expiresAt: v.expiresAt,
  };
}

export function stateRow(visit: Visit): Row {
  return {
    ...visit,
    PK: visitPK(visit.householdId, visit.id),
    SK: "STATE",
    gsi1pk: `HOUSEHOLD#${visit.householdId}#VISITS`,
    gsi1sk: `${visit.createdAt}#${visit.id}`,
  };
}

export function timelineRef(content: Row): Row {
  return {
    PK: content.PK,
    SK: `TIMELINE#${pad(content.createdAt)}#${content.id}`,
    contentSK: content.SK,
    createdAt: content.createdAt,
    expiresAt: content.expiresAt,
  };
}
export function auditWrites(visit: Visit, text: string) {
  const event = audit(visit, text);
  return [put(tables.visits, event), put(tables.visits, timelineRef(event))];
}
/** Upgrade local records created before timeline references without scanning or content copies. */
export async function ensureTimeline(PK: string) {
  for (const prefix of ["EVENT#", "CAPTION#"]) {
    let cursor: Key | undefined;
    do {
      const page = await queryPK(tables.visits, PK, {
        prefix,
        limit: 50,
        cursor,
      });
      for (const content of page.items) {
        try {
          await db.send(
            new PutCommand({
              TableName: tables.visits,
              Item: timelineRef(content),
              ConditionExpression: "attribute_not_exists(PK)",
            }),
          );
        } catch (error) {
          if (!conditionConflict(error)) throw error;
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }
  try {
    await db.send(
      new UpdateCommand({
        TableName: tables.visits,
        Key: { PK, SK: "STATE" },
        UpdateExpression: "SET historyVersion = :version",
        ConditionExpression:
          "attribute_exists(PK) AND expiresAt > :now AND attribute_not_exists(deleted)",
        ExpressionAttributeValues: { ":version": 2, ":now": seconds() },
      }),
    );
  } catch (error) {
    if (conditionConflict(error))
      throw new AppError("NOT_FOUND", 404, "Visit is unavailable or expired.");
    throw error;
  }
}
