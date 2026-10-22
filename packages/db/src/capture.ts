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
  auditWrites,
  timelineRef,
  ensureTimeline,
  stateRow,
} from "./common";
export async function authorizeCapture(
  actor: Actor,
  visitId: string,
  fence: { leaseId: string; mediaSessionId: string },
): Promise<Visit> {
  actor = await resident(actor, "captions");
  if (!actor.grants.camera)
    throw new AppError(
      "FORBIDDEN",
      403,
      "Incoming-media permission is unavailable.",
    );
  const p = await profile(actor.householdId);
  if (!p.settings.consent.ring || !p.settings.consent.transcription)
    throw new AppError(
      "CONSENT_REVOKED",
      403,
      "Media or transcription consent is unavailable.",
    );
  const row = await rawVisit(actor.householdId, visitId);
  const visit = clean<Visit>(row);
  assertHandler(actor, visit);
  const lease = await getItem(tables.runtime, row.PK, "CAPTURE");
  if (
    !lease ||
    lease.id !== fence.leaseId ||
    lease.holderId !== actor.userId ||
    lease.mediaSessionId !== fence.mediaSessionId ||
    lease.expiresAt <= seconds() ||
    visit.audioLease?.id !== lease.id ||
    visit.mediaSessionId !== fence.mediaSessionId ||
    visit.mediaStatus !== "LIVE" ||
    !visit.mediaExpiresAt ||
    visit.mediaExpiresAt <= now()
  )
    throw new AppError(
      "LEASE_LOST",
      409,
      "Capture authorization ended. Text remains available.",
    );
  return visit;
}

export async function releaseCapture(
  actor: Actor,
  visitId: string,
  leaseId: string,
  reason = "Capture disconnected",
) {
  const pk = visitPK(actor.householdId, visitId);
  const row = await getItem(tables.visits, pk, "STATE");
  const lease = await getItem(tables.runtime, pk, "CAPTURE");
  if (!row || !lease || lease.id !== leaseId || lease.holderId !== actor.userId)
    return;
  const visit = clean<Visit>(row);
  delete visit.audioLease;
  visit.version++;
  visit.updatedAt = now();
  if (visit.mediaStatus === "LIVE") visit.mediaStatus = "INTERRUPTED";
  const item = put(tables.visits, stateRow(visit), "#version = :version", {
    ":version": row.version,
  });
  (item as any).Put.ExpressionAttributeNames = { "#version": "version" };
  try {
    await transact([
      item,
      {
        Delete: {
          TableName: tables.runtime,
          Key: { PK: pk, SK: "CAPTURE" },
          ConditionExpression: "id = :id",
          ExpressionAttributeValues: { ":id": leaseId },
        },
      },
      ...auditWrites(
        visit,
        reason === "Capture disconnected"
          ? "Capture interrupted by connection loss. Handler responsibility is unchanged."
          : "Capture ended. Handler responsibility is unchanged.",
      ),
      jobPut("NOTIFY", actor.householdId, { visitId, version: visit.version }),
    ] as any);
  } catch (error) {
    if (!conditionConflict(error)) throw error;
  }
}

export type CaptionInput = {
  mediaSessionId: string;
  resultId: string;
  text: string;
  startTime: number;
  endTime: number;
  source: "FIXTURE" | "AWS";
  isPartial: boolean;
};

export async function persistCaption(
  actor: Actor,
  visitId: string,
  caption: CaptionInput,
  leaseId: string,
): Promise<ConversationItem | null> {
  const visit = await authorizeCapture(actor, visitId, {
    leaseId,
    mediaSessionId: caption.mediaSessionId,
  });
  if (caption.isPartial) return null;
  if (
    !caption.resultId ||
    caption.resultId.length > 200 ||
    !caption.text ||
    caption.text.length > 10000 ||
    !Number.isFinite(caption.startTime) ||
    !Number.isFinite(caption.endTime) ||
    caption.startTime < 0 ||
    caption.endTime < caption.startTime
  )
    throw new AppError("VALIDATION", 400, "Invalid caption result.");
  if (
    caption.source === "FIXTURE" &&
    (process.env.TRANSCRIBE_MODE || "fixture") !== "fixture"
  )
    throw new AppError(
      "DEMO_DISABLED",
      403,
      "Fixture transcripts are disabled.",
    );
  const pk = visitPK(actor.householdId, visitId),
    key = {
      PK: pk,
      SK: `CAPTION#${caption.mediaSessionId}#${caption.resultId}`,
    };
  const existing = await getItem(tables.visits, key.PK, key.SK);
  if (existing) return clean<ConversationItem>(existing);
  const item: ConversationItem = {
    id: `${caption.mediaSessionId}:${caption.resultId}`,
    kind: "caption",
    text: caption.text,
    createdAt: now(),
    expiresAt: visit.expiresAt,
    mediaSessionId: caption.mediaSessionId,
    resultId: caption.resultId,
    isPartial: false,
    startTime: caption.startTime,
    endTime: caption.endTime,
    source: caption.source,
  };
  try {
    await transact([
      put(tables.visits, { ...key, ...item }, "attribute_not_exists(PK)"),
      put(tables.visits, timelineRef({ ...key, ...item })),
      {
        ConditionCheck: {
          TableName: tables.runtime,
          Key: { PK: pk, SK: "CAPTURE" },
          ConditionExpression: "id = :id AND expiresAt > :now",
          ExpressionAttributeValues: { ":id": leaseId, ":now": seconds() },
        },
      },
      {
        ConditionCheck: {
          TableName: tables.visits,
          Key: { PK: pk, SK: "STATE" },
          ConditionExpression:
            "handlerId = :handler AND mediaSessionId = :media AND #version = :version AND expiresAt > :now",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: {
            ":handler": actor.userId,
            ":media": caption.mediaSessionId,
            ":version": visit.version,
            ":now": seconds(),
          },
        },
      },
      jobPut("NOTIFY", actor.householdId, { visitId, version: visit.version }),
      ...authConditions(actor, "captions"),
    ] as any);
  } catch (error) {
    if (conditionConflict(error)) {
      const replay = await getItem(tables.visits, key.PK, key.SK);
      if (replay) return clean<ConversationItem>(replay);
      throw new AppError(
        "LEASE_LOST",
        409,
        "Caption stream authorization ended.",
      );
    }
    throw error;
  }
  return item;
}

export async function enqueueDemoCaptions(actor: Actor, visitId: string) {
  if (
    (process.env.TRANSCRIBE_MODE || "fixture") !== "fixture" ||
    (process.env.RING_MODE || "demo") !== "demo" ||
    process.env.NODE_ENV === "production"
  )
    throw new AppError("DEMO_DISABLED", 403, "Demo transcripts are disabled.");
  actor = await resident(actor, "captions");
  const row = await rawVisit(actor.householdId, visitId);
  const v = clean<Visit>(row);
  if (!v.audioLease || !v.mediaSessionId)
    throw new AppError("LEASE_LOST", 409, "Authorize incoming audio first.");
  await authorizeCapture(actor, visitId, {
    leaseId: v.audioLease.id,
    mediaSessionId: v.mediaSessionId,
  });
  const job = makeJob("DEMO_CAPTIONS", actor.householdId, {
    visitId,
    sessionId: actor.sessionId,
    leaseId: v.audioLease.id,
    mediaSessionId: v.mediaSessionId,
  });
  await transact([
    put(tables.runtime, job),
    {
      ConditionCheck: {
        TableName: tables.runtime,
        Key: { PK: row.PK, SK: "CAPTURE" },
        ConditionExpression: "id = :id AND expiresAt > :now",
        ExpressionAttributeValues: {
          ":id": v.audioLease.id,
          ":now": seconds(),
        },
      },
    },
    ...authConditions(actor, "captions"),
  ] as any);
  return { jobId: job.id };
}

export async function completeMedia(
  actor: Actor,
  visitId: string,
  input: { mediaSessionId: string; expiresAt: number },
) {
  actor = await resident(actor, "camera");
  const row = await rawVisit(actor.householdId, visitId);
  const before = clean<Visit>(row);
  assertHandler(actor, before);
  if (
    before.mediaStatus !== "CONNECTING" ||
    before.mediaSessionId !== input.mediaSessionId ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= now() ||
    input.expiresAt > now() + 61000
  )
    throw new AppError(
      "MEDIA_STALE",
      409,
      "Media negotiation no longer applies to this visit.",
    );
  const p = await profile(actor.householdId);
  if (!p.settings.consent.ring)
    throw new AppError(
      "CONSENT_REVOKED",
      403,
      "Incoming media consent was revoked.",
    );
  const visit = {
    ...before,
    mediaStatus: "LIVE" as const,
    mediaExpiresAt: input.expiresAt,
    version: before.version + 1,
    updatedAt: now(),
  };
  const state = put(tables.visits, stateRow(visit), "#version = :version", {
    ":version": before.version,
  });
  (state as any).Put.ExpressionAttributeNames = { "#version": "version" };
  try {
    await transact([
      state,
      ...auditWrites(visit, "Receive-only Ring media connection established."),
      jobPut(
        "RING_MEDIA_CLOSE",
        actor.householdId,
        { visitId, mediaSessionId: input.mediaSessionId },
        input.expiresAt,
      ),
      jobPut("NOTIFY", actor.householdId, { visitId, version: visit.version }),
      ...authConditions(actor, "camera"),
    ] as any);
  } catch (error) {
    if (conditionConflict(error))
      throw new AppError(
        "MEDIA_STALE",
        409,
        "Media negotiation was superseded.",
      );
    throw error;
  }
  return { visit };
}

export async function expireMedia(
  householdId: string,
  visitId: string,
  mediaSessionId: string,
) {
  const row = await getItem(
    tables.visits,
    visitPK(householdId, visitId),
    "STATE",
  );
  if (!row || row.mediaSessionId !== mediaSessionId) return;
  const v = clean<Visit>(row);
  v.version++;
  v.mediaStatus = "ENDED";
  delete v.mediaSessionId;
  delete v.audioLease;
  const state = put(tables.visits, stateRow(v), "#version = :version", {
    ":version": row.version,
  });
  (state as any).Put.ExpressionAttributeNames = { "#version": "version" };
  try {
    await transact([
      state,
      del(tables.runtime, { PK: row.PK, SK: "CAPTURE" }),
      ...auditWrites(v, "Media session ended. Text remains available."),
      jobPut("NOTIFY", householdId, { visitId, version: v.version }),
    ] as any);
  } catch (error) {
    if (!conditionConflict(error)) throw error;
  }
}

export async function simulateMediaUnavailable(actor: Actor, visitId: string) {
  if (
    (process.env.RING_MODE || "demo") !== "demo" ||
    process.env.NODE_ENV === "production"
  )
    throw new AppError(
      "DEMO_DISABLED",
      403,
      "Local media scenarios are disabled.",
    );
  actor = await resident(actor);
  const row = await rawVisit(actor.householdId, visitId);
  if (row.eventSource !== "LOCAL")
    throw new AppError("DEMO_DISABLED", 403, "This is not a LOCAL visit.");
  const v = clean<Visit>(row);
  v.version++;
  v.mediaStatus = "UNAVAILABLE";
  v.mediaSource = "NONE";
  delete v.mediaSessionId;
  delete v.audioLease;
  const state = put(tables.visits, stateRow(v), "#version = :version", {
    ":version": row.version,
  });
  (state as any).Put.ExpressionAttributeNames = { "#version": "version" };
  try {
    await transact([
      state,
      del(tables.runtime, { PK: row.PK, SK: "CAPTURE" }),
      ...auditWrites(
        v,
        "LOCAL scenario: incoming audio is unavailable. Visitor text remains available.",
      ),
      jobPut("NOTIFY", actor.householdId, { visitId, version: v.version }),
      ...authConditions(actor),
    ] as any);
  } catch (error) {
    if (conditionConflict(error))
      throw new AppError(
        "CONFLICT",
        409,
        "Visit changed while applying local scenario.",
      );
    throw error;
  }
  return { visit: v };
}
