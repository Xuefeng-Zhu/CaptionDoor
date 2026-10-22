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
import {
  ttl,
  wsUrl,
  clean,
  rows,
  profile,
  rawVisit,
  viewVisit,
  assertHandler,
  audit,
  stateRow,
} from "./common";
export async function guestMessage(
  actor: Actor,
  input: { text: string; category: "Delivery" | "Appointment" | "Other" },
  idempotencyKey: string,
) {
  actor = await refresh(actor, "visitorText");
  if (actor.kind !== "guest" || !actor.threadId)
    throw new AppError("FORBIDDEN", 403, "Visitor access is required.");
  const data = guestMessageSchema.parse(input);
  await rateLimit(`guest-message:${actor.sessionId}`, 30, 60);
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new AppError("VALIDATION", 400, "An idempotency key is required.");
  const pk = threadPK(actor.householdId, actor.threadId),
    ikey = { PK: pk, SK: `IDEMPOTENCY#${hashToken(idempotencyKey)}` };
  const fingerprint = hashToken(JSON.stringify(data));
  const previous = await getItem(tables.runtime, ikey.PK, ikey.SK);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "This key was already used.",
      );
    return previous.response;
  }
  const thread = await getItem(tables.visits, pk, "STATE");
  if (!thread || thread.deleted || thread.expiresAt <= seconds())
    throw new AppError("EXPIRED", 403, "This conversation has expired.");
  const message: ConversationItem = {
    id: id(),
    kind: "message",
    text: data.text,
    direction: "visitor",
    threadId: actor.threadId,
    deliveryStatus: "ACCEPTED",
    createdAt: now(),
    expiresAt: thread.expiresAt,
  };
  const response = { message };
  try {
    await transact([
      put(tables.visits, {
        PK: pk,
        SK: `MESSAGE#${pad(message.createdAt)}#${message.id}`,
        ...message,
      }),
      {
        Update: {
          TableName: tables.visits,
          Key: { PK: pk, SK: "STATE" },
          UpdateExpression: "SET lastMessage = :text, category = :category",
          ConditionExpression:
            "expiresAt > :now AND attribute_not_exists(deleted)",
          ExpressionAttributeValues: {
            ":text": data.text,
            ":category": data.category,
            ":now": seconds(),
          },
        },
      },
      put(
        tables.runtime,
        { ...ikey, fingerprint, response, expiresAt: thread.expiresAt },
        "attribute_not_exists(PK)",
      ),
      jobPut("NOTIFY", actor.householdId, {
        threadId: actor.threadId,
        visitId: thread.visitId,
      }),
      ...authConditions(actor, "visitorText"),
    ] as any);
  } catch (error) {
    if (conditionConflict(error)) {
      const replay = await getItem(tables.runtime, ikey.PK, ikey.SK);
      if (replay?.fingerprint === fingerprint) return replay.response;
      await refresh(actor);
      throw new AppError(
        "CONFLICT",
        409,
        "Conversation changed. Please try again.",
      );
    }
    throw error;
  }
  return response;
}

export async function delivery(
  actor: Actor,
  messageId: string,
  stage: "DISPLAYED" | "CONFIRMED",
) {
  actor = await refresh(actor, "visitorText");
  if (actor.kind !== "guest" || !actor.threadId)
    throw new AppError("FORBIDDEN", 403, "Visitor access is required.");
  const pk = threadPK(actor.householdId, actor.threadId);
  const lookup = await getItem(tables.runtime, pk, `MESSAGE#${messageId}`);
  const row = lookup
    ? await getItem(tables.visits, pk, lookup.messageSK)
    : undefined;
  if (!row || row.direction !== "resident" || row.expiresAt <= seconds())
    throw new AppError("NOT_FOUND", 404, "Reply is unavailable.");
  const rank = { ACCEPTED: 0, DISPLAYED: 1, CONFIRMED: 2 };
  if (rank[row.deliveryStatus as keyof typeof rank] >= rank[stage])
    return { message: clean<ConversationItem>(row) };
  if (stage === "CONFIRMED" && row.deliveryStatus !== "DISPLAYED")
    throw new AppError(
      "NOT_DISPLAYED",
      409,
      "Display this reply before confirming it.",
    );
  const updated = { ...row, deliveryStatus: stage, deliveryUpdatedAt: now() };
  const thread = await getItem(tables.visits, pk, "STATE");
  try {
    await transact([
      put(
        tables.visits,
        updated,
        "deliveryStatus = :before AND expiresAt > :now",
        { ":before": row.deliveryStatus, ":now": seconds() },
      ),
      jobPut("NOTIFY", actor.householdId, {
        threadId: actor.threadId,
        visitId: thread?.visitId,
      }),
      ...authConditions(actor, "visitorText"),
    ] as any);
  } catch (error) {
    if (conditionConflict(error)) {
      await refresh(actor);
      return delivery(actor, messageId, stage);
    }
    throw error;
  }
  return { message: clean<ConversationItem>(updated) };
}
