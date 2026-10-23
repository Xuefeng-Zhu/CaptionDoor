import { randomBytes } from "node:crypto";
import {
  AppError,
  type Actor,
  type Member,
  type Thread,
  type GuestView,
} from "@captiondoor/domain";
import {
  type Row,
  tables,
  getItem,
  putItem,
  hashToken,
  seconds,
  now,
  id,
  householdPK,
  threadPK,
  visitPK,
  put,
  transact,
  jobPut,
  UpdateCommand,
  db,
} from "./repository";
export const allGrants = {
  camera: true,
  captions: true,
  visitorText: true,
  membership: true,
};
export const secret = () => randomBytes(32).toString("base64url");
export async function member(
  householdId: string,
  userId: string,
): Promise<Row & Member> {
  const row = await getItem(
    tables.config,
    householdPK(householdId),
    `MEMBER#${userId}`,
  );
  if (!row || row.revoked || row.expiresAt <= seconds())
    throw new AppError("FORBIDDEN", 403, "Household access is unavailable.");
  return row as Row & Member;
}
/** A thread cannot outlive its associated visit's access policy, even while physical deletion is pending. */
export async function threadVisitAccessible(
  householdId: string,
  thread: Row,
): Promise<boolean> {
  if (!thread.visitId) return true;
  if (typeof thread.visitId !== "string") return false;
  const visit = await getItem(
    tables.visits,
    visitPK(householdId, thread.visitId),
    "STATE",
  );
  return Boolean(
    visit &&
    visit.householdId === householdId &&
    visit.id === thread.visitId &&
    !visit.deleted &&
    visit.expiresAt > seconds(),
  );
}
/** The thread update carries its own association fence; this separate item protects the parent visit atomically. */
export function guestVisitFence(actor: Actor, thread: Row) {
  return thread.visitId
    ? [
        {
          ConditionCheck: {
            TableName: tables.visits,
            Key: {
              PK: visitPK(actor.householdId, thread.visitId),
              SK: "STATE",
            },
            ConditionExpression:
              "attribute_exists(PK) AND householdId = :household AND expiresAt > :now AND (attribute_not_exists(deleted) OR deleted = :no)",
            ExpressionAttributeValues: {
              ":household": actor.householdId,
              ":now": seconds(),
              ":no": false,
            },
          },
        },
      ]
    : [];
}
export async function sessionFromId(sessionId: string): Promise<Actor> {
  const row = await getItem(tables.runtime, `SESSION#${sessionId}`, "SESSION");
  if (!row || row.revoked || row.expiresAt <= seconds())
    throw new AppError("UNAUTHENTICATED", 401, "Sign in again to continue.");
  let grants = allGrants;
  if (row.kind === "resident") {
    grants = (await member(row.householdId, row.userId)).grants;
  } else {
    const thread = await getItem(
      tables.visits,
      threadPK(row.householdId, row.threadId),
      "STATE",
    );
    if (
      !thread ||
      thread.expiresAt <= seconds() ||
      thread.deleted ||
      !(await threadVisitAccessible(row.householdId, thread))
    )
      throw new AppError(
        "EXPIRED",
        403,
        "This visitor conversation has expired.",
      );
    grants = {
      camera: false,
      captions: false,
      visitorText: true,
      membership: false,
    };
  }
  return {
    kind: row.kind,
    userId: row.userId,
    householdId: row.householdId,
    sessionId,
    expiresAt: row.expiresAt,
    csrf: row.csrf,
    grants,
    threadId: row.threadId,
  };
}
export async function authenticate(token: string): Promise<Actor> {
  if (!token || token.length > 256)
    throw new AppError("UNAUTHENTICATED", 401, "Sign in to continue.");
  return sessionFromId(hashToken(token));
}
export async function refresh(
  actor: Actor,
  grant?: keyof Actor["grants"],
): Promise<Actor> {
  const current = await sessionFromId(actor.sessionId);
  if (
    current.kind !== actor.kind ||
    current.userId !== actor.userId ||
    current.householdId !== actor.householdId
  )
    throw new AppError("FORBIDDEN", 403, "Access denied.");
  if (grant && !current.grants[grant])
    throw new AppError("FORBIDDEN", 403, "This permission is not available.");
  return current;
}
export async function resident(actor: Actor, grant?: keyof Actor["grants"]) {
  const current = await refresh(actor, grant);
  if (current.kind !== "resident")
    throw new AppError("FORBIDDEN", 403, "Resident access is required.");
  return current;
}
export function authConditions(actor: Actor, grant?: keyof Actor["grants"]) {
  const result: any[] = [
    {
      ConditionCheck: {
        TableName: tables.runtime,
        Key: { PK: `SESSION#${actor.sessionId}`, SK: "SESSION" },
        ConditionExpression:
          "expiresAt > :now AND attribute_not_exists(revoked)",
        ExpressionAttributeValues: { ":now": seconds() },
      },
    },
  ];
  if (actor.kind === "resident")
    result.push({
      ConditionCheck: {
        TableName: tables.config,
        Key: {
          PK: householdPK(actor.householdId),
          SK: `MEMBER#${actor.userId}`,
        },
        ConditionExpression: `expiresAt > :now AND attribute_not_exists(revoked)${grant ? " AND grants.#grant = :yes" : ""}`,
        ExpressionAttributeValues: {
          ":now": seconds(),
          ...(grant ? { ":yes": true } : {}),
        },
        ...(grant ? { ExpressionAttributeNames: { "#grant": grant } } : {}),
      },
    });
  return result;
}
export async function createResidentSession(
  userId: string,
  householdId: string,
) {
  const m = await member(householdId, userId);
  const token = secret(),
    csrf = secret(),
    sessionId = hashToken(token);
  const actor: Actor = {
    kind: "resident",
    userId,
    householdId,
    sessionId,
    expiresAt: seconds() + 8 * 3600,
    csrf,
    grants: m.grants,
  };
  await putItem(tables.runtime, {
    PK: `SESSION#${sessionId}`,
    SK: "SESSION",
    ...actor,
    createdAt: now(),
  });
  return { token, csrf, user: { id: userId, name: m.name }, actor };
}
export async function demoLogin(identity: "alex" | "sam" | "jordan") {
  if (
    (process.env.AUTH_MODE || "demo") !== "demo" ||
    process.env.NODE_ENV === "production"
  )
    throw new AppError("DEMO_DISABLED", 403, "Demo sign-in is disabled.");
  const lookup = await getItem(tables.config, `USER#${identity}`, "LOOKUP");
  if (!lookup)
    throw new AppError(
      "NOT_FOUND",
      404,
      "Local seed is missing. Run setup:local.",
    );
  return createResidentSession(lookup.userId, lookup.householdId);
}
export async function createGuest(publicDoorId: string) {
  const lookup = await getItem(
    tables.config,
    `PUBLICDOOR#${publicDoorId}`,
    "LOOKUP",
  );
  if (!lookup || lookup.revoked)
    throw new AppError("NOT_FOUND", 404, "This entrance is unavailable.");
  const profile = await getItem(
    tables.config,
    householdPK(lookup.householdId),
    "PROFILE",
  );
  if (!profile)
    throw new AppError("NOT_FOUND", 404, "This entrance is unavailable.");
  const threadId = id(),
    token = secret(),
    csrf = secret(),
    sessionId = hashToken(token);
  const expiry = seconds() + profile.settings.retentionHours * 3600;
  const thread: Thread = {
    id: threadId,
    householdId: lookup.householdId,
    doorId: lookup.doorId,
    createdAt: now(),
    expiresAt: expiry,
  };
  const actor: Actor = {
    kind: "guest",
    userId: `guest-${threadId}`,
    householdId: lookup.householdId,
    threadId,
    sessionId,
    expiresAt: seconds() + 1800,
    csrf,
    grants: {
      camera: false,
      captions: false,
      visitorText: true,
      membership: false,
    },
  };
  await transact([
    put(tables.visits, {
      PK: threadPK(actor.householdId, threadId),
      SK: "STATE",
      ...thread,
      sessionId,
      gsi1pk: `HOUSEHOLD#${actor.householdId}#THREADS`,
      gsi1sk: `${now()}#${threadId}`,
    }),
    put(tables.runtime, {
      PK: `SESSION#${sessionId}`,
      SK: "SESSION",
      ...actor,
      createdAt: now(),
    }),
    jobPut(
      "DELETE_THREAD",
      actor.householdId,
      { threadId, sessionId },
      expiry * 1000,
    ),
  ]);
  return {
    token,
    csrf,
    actor,
    thread: { id: threadId, expiresAt: expiry, associated: false },
    messages: [],
    wsUrl: process.env.WS_PUBLIC_URL || "ws://127.0.0.1:3411/ws",
  };
}
export async function revokeSession(actor: Actor) {
  await db.send(
    new UpdateCommand({
      TableName: tables.runtime,
      Key: { PK: `SESSION#${actor.sessionId}`, SK: "SESSION" },
      UpdateExpression: "SET revoked = :yes",
      ExpressionAttributeValues: { ":yes": true },
    }),
  );
}
export async function rateLimit(key: string, max: number, windowSeconds = 60) {
  const bucket = Math.floor(seconds() / windowSeconds);
  const PK = `RATE#${hashToken(key)}#${bucket}`;
  try {
    await db.send(
      new UpdateCommand({
        TableName: tables.runtime,
        Key: { PK, SK: "RATE" },
        UpdateExpression: "SET expiresAt = :expiry ADD hits :one",
        ConditionExpression: "attribute_not_exists(hits) OR hits < :max",
        ExpressionAttributeValues: {
          ":expiry": seconds() + windowSeconds * 2,
          ":one": 1,
          ":max": max,
        },
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      throw new AppError(
        "RATE_LIMITED",
        429,
        "Please wait before trying again.",
      );
    throw error;
  }
}
