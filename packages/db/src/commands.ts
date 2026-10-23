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
export async function command(
  actor: Actor,
  visitId: string,
  input: VisitCommand,
  idempotencyKey: string,
): Promise<{ visit: Visit }> {
  const cmd = commandSchema.parse(input);
  const grant =
    cmd.type === "reply" || cmd.type === "associate"
      ? "visitorText"
      : cmd.type === "capture"
        ? "captions"
        : cmd.type === "media"
          ? "camera"
          : cmd.type === "takeover"
            ? "membership"
            : undefined;
  actor = await resident(actor, grant);
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new AppError("VALIDATION", 400, "An idempotency key is required.");
  const pk = visitPK(actor.householdId, visitId),
    ikey = {
      PK: pk,
      SK: `IDEMPOTENCY#${hashToken(`${actor.userId}:${idempotencyKey}`)}`,
    };
  const fingerprint = hashToken(JSON.stringify(cmd));
  const previous = await getItem(tables.runtime, ikey.PK, ikey.SK);
  if (previous && previous.expiresAt > seconds()) {
    if (previous.fingerprint !== fingerprint)
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "This key was used for a different command.",
      );
    return previous.response;
  }
  const raw = await rawVisit(actor.householdId, visitId);
  const before = clean<Visit>(raw);
  if (before.version !== cmd.expectedVersion)
    throw new AppError(
      "CONFLICT",
      409,
      "The visit changed. Review the current state.",
      before,
    );
  if (before.status === "CLOSED" && cmd.type !== "delete")
    throw new AppError("CLOSED", 409, "This visit is closed.", before);
  const v: Visit = { ...before, version: before.version + 1, updatedAt: now() };
  let text = "Visit updated.";
  const extra: any[] = [];
  const mine = await member(actor.householdId, actor.userId);
  if (cmd.type === "claim") {
    if (before.status !== "UNCLAIMED")
      throw new AppError(
        "CONFLICT",
        409,
        "Another resident is handling this visit.",
        before,
      );
    v.status = "CLAIMED";
    v.handlerId = actor.userId;
    v.handlerName = mine.name;
    text = `${mine.name} is handling this visit.`;
  } else if (cmd.type === "accept") {
    if (
      !before.pendingHandoff ||
      before.pendingHandoff.targetUserId !== actor.userId
    )
      throw new AppError(
        "FORBIDDEN",
        403,
        "There is no handoff for you to accept.",
      );
    v.handlerId = actor.userId;
    v.handlerName = mine.name;
    delete v.pendingHandoff;
    delete v.audioLease;
    v.mediaStatus = "ENDED";
    delete v.mediaSessionId;
    extra.push(del(tables.runtime, { PK: pk, SK: "CAPTURE" }));
    text = `${mine.name} accepted responsibility.`;
  } else if (cmd.type === "takeover") {
    if (mine.role !== "owner")
      throw new AppError("FORBIDDEN", 403, "An owner must authorize takeover.");
    v.status = "CLAIMED";
    v.handlerId = actor.userId;
    v.handlerName = mine.name;
    delete v.pendingHandoff;
    delete v.audioLease;
    v.mediaStatus = "ENDED";
    delete v.mediaSessionId;
    extra.push(del(tables.runtime, { PK: pk, SK: "CAPTURE" }));
    text = `${mine.name} took over responsibility.`;
  } else {
    if (cmd.type !== "delete") assertHandler(actor, before);
    else if (before.handlerId !== actor.userId && mine.role !== "owner")
      throw new AppError(
        "FORBIDDEN",
        403,
        "Only the handler or owner can delete visit content.",
      );
    if (cmd.type === "delete" && before.status !== "CLOSED")
      throw new AppError(
        "CLOSE_REQUIRED",
        409,
        "Close the visit with a recorded outcome before deleting retained content.",
      );
    if (cmd.type === "handoff") {
      if (cmd.targetUserId === actor.userId)
        throw new AppError("VALIDATION", 400, "Choose another member.");
      const target = await member(actor.householdId, cmd.targetUserId);
      v.pendingHandoff = {
        targetUserId: target.userId,
        targetName: target.name,
        requestedBy: actor.userId,
      };
      text = `Handoff requested to ${target.name}. ${mine.name} remains responsible.`;
    } else if (cmd.type === "cancel") {
      if (!v.pendingHandoff)
        throw new AppError("CONFLICT", 409, "No handoff is pending.");
      delete v.pendingHandoff;
      text = "Pending handoff cancelled.";
    } else if (cmd.type === "close") {
      v.status = "CLOSED";
      v.outcome = cmd.outcome;
      v.mediaStatus = "ENDED";
      delete v.audioLease;
      delete v.mediaSessionId;
      delete v.pendingHandoff;
      extra.push(del(tables.runtime, { PK: pk, SK: "CAPTURE" }));
      extra.push({
        Update: {
          TableName: tables.config,
          Key: { PK: householdPK(actor.householdId), SK: `DOOR#${v.doorId}` },
          UpdateExpression: "REMOVE activeVisitId",
          ConditionExpression: "activeVisitId = :id",
          ExpressionAttributeValues: { ":id": visitId },
        },
      });
      text = `Visit closed: ${cmd.outcome.replaceAll("_", " ").toLowerCase()}. Closure does not establish a person’s departure.`;
    } else if (cmd.type === "reply") {
      const thread = await getItem(
        tables.visits,
        threadPK(actor.householdId, cmd.threadId),
        "STATE",
      );
      if (
        !thread ||
        thread.visitId !== visitId ||
        thread.expiresAt <= seconds() ||
        thread.deleted
      )
        throw new AppError(
          "NO_RECIPIENT",
          409,
          "Associate an active visitor page before sending. This cannot speak through Ring.",
        );
      const msg: ConversationItem = {
        id: id(),
        kind: "message",
        text: cmd.text,
        direction: "resident",
        threadId: cmd.threadId,
        deliveryStatus: "ACCEPTED",
        createdAt: now(),
        expiresAt: Math.min(v.expiresAt, thread.expiresAt),
      };
      extra.push(
        put(tables.visits, {
          PK: thread.PK,
          SK: `MESSAGE#${pad(msg.createdAt)}#${msg.id}`,
          ...msg,
        }),
        put(tables.runtime, {
          PK: thread.PK,
          SK: `MESSAGE#${msg.id}`,
          messageSK: `MESSAGE#${pad(msg.createdAt)}#${msg.id}`,
          expiresAt: msg.expiresAt,
        }),
      );
      text = "Reply accepted for the visitor page. It is not yet confirmed.";
    } else if (cmd.type === "associate") {
      const thread = await getItem(
        tables.visits,
        threadPK(actor.householdId, cmd.threadId),
        "STATE",
      );
      if (
        !thread ||
        thread.householdId !== actor.householdId ||
        thread.doorId !== v.doorId ||
        thread.expiresAt <= seconds() ||
        thread.deleted
      )
        throw new AppError(
          "NOT_FOUND",
          404,
          "Visitor conversation is unavailable.",
        );
      if (thread.visitId && thread.visitId !== visitId)
        throw new AppError(
          "CONFLICT",
          409,
          "This visitor conversation is already associated with another visit.",
        );
      extra.push(
        put(
          tables.visits,
          { ...thread, visitId },
          "attribute_not_exists(visitId) OR visitId = :id",
          { ":id": visitId },
        ),
      );
      extra.push(
        put(tables.visits, {
          PK: pk,
          SK: `THREAD#${thread.id}`,
          threadId: thread.id,
          expiresAt: v.expiresAt,
        }),
      );
      text =
        "Visitor page explicitly associated. A QR scan does not prove identity or presence.";
    } else if (cmd.type === "media") {
      if (cmd.action === "start") {
        if (!cmd.consent)
          throw new AppError(
            "CONSENT_REQUIRED",
            400,
            "Explicit incoming-media consent is required.",
          );
        const p = await profile(actor.householdId);
        if (!p.settings.consent.ring)
          throw new AppError(
            "CONSENT_REQUIRED",
            403,
            "Enable Ring/media consent in settings first.",
          );
        const demo = (process.env.RING_MODE || "demo") === "demo";
        v.mediaStatus = demo ? "LIVE" : "CONNECTING";
        v.mediaSource = demo ? "LOCAL_FIXTURE" : "RING";
        v.mediaSessionId = id();
        v.mediaExpiresAt = now() + 30000;
        if (demo)
          extra.push(
            jobPut(
              "RING_MEDIA_CLOSE",
              actor.householdId,
              { visitId, mediaSessionId: v.mediaSessionId },
              v.mediaExpiresAt,
            ),
          );
        text = demo
          ? "LOCAL fixture media session started. No Ring camera is connected."
          : "Receive-only Ring media negotiation started.";
      } else {
        v.mediaStatus =
          cmd.action === "stop"
            ? "ENDED"
            : cmd.action === "unavailable"
              ? "UNAVAILABLE"
              : "INTERRUPTED";
        delete v.audioLease;
        delete v.mediaSessionId;
        extra.push(del(tables.runtime, { PK: pk, SK: "CAPTURE" }));
        text = `Media ${v.mediaStatus.toLowerCase()}. Visitor text remains available.`;
      }
    } else if (cmd.type === "capture") {
      const p = await profile(actor.householdId);
      if (!p.settings.consent.transcription)
        throw new AppError(
          "CONSENT_REQUIRED",
          403,
          "Approve third-party transcription in settings first.",
        );
      if (!actor.grants.camera)
        throw new AppError(
          "FORBIDDEN",
          403,
          "Incoming media permission is required.",
        );
      if (
        v.mediaStatus !== "LIVE" ||
        !v.mediaSessionId ||
        !v.mediaExpiresAt ||
        v.mediaExpiresAt <= now()
      )
        throw new AppError(
          "MEDIA_UNAVAILABLE",
          409,
          "Incoming audio is unavailable or expired. Text still works.",
        );
      if (v.audioLease && v.audioLease.expiresAt > seconds())
        throw new AppError(
          "CAPTURE_BUSY",
          409,
          "An audio capture lease is already active.",
        );
      const lease = {
        id: id(),
        holderId: actor.userId,
        epoch: v.version,
        expiresAt: Math.min(
          seconds() + 30,
          Math.floor(v.mediaExpiresAt / 1000),
        ),
      };
      v.audioLease = lease;
      v.transcriptSource =
        (process.env.TRANSCRIBE_MODE || "fixture") === "fixture"
          ? "FIXTURE"
          : "AWS";
      extra.push(
        put(
          tables.runtime,
          {
            PK: pk,
            SK: "CAPTURE",
            ...lease,
            mediaSessionId: v.mediaSessionId,
            visitId,
            householdId: actor.householdId,
            sessionId: actor.sessionId,
          },
          "attribute_not_exists(expiresAt) OR expiresAt <= :now",
          { ":now": seconds() },
        ),
      );
      text = `${v.transcriptSource === "FIXTURE" ? "Demo transcript" : "AWS transcription"} capture explicitly authorized.`;
    } else if (cmd.type === "delete") {
      v.expiresAt = seconds();
      v.deleted = true;
      delete v.pendingHandoff;
      v.status = "CLOSED";
      v.mediaStatus = "ENDED";
      delete v.audioLease;
      delete v.mediaSessionId;
      extra.push(del(tables.runtime, { PK: pk, SK: "CAPTURE" }));
      extra.push(jobPut("DELETE_VISIT", actor.householdId, { visitId }, now()));
      text = "Content access revoked. Physical deletion queued.";
    }
  }
  if (
    before.mediaSource === "RING" &&
    before.mediaSessionId &&
    v.mediaSessionId !== before.mediaSessionId
  )
    extra.push(
      jobPut("RING_MEDIA_CLOSE", actor.householdId, {
        visitId,
        mediaSessionId: before.mediaSessionId,
      }),
    );
  const response = { visit: v };
  const transaction = [
    put(tables.visits, stateRow(v), "#version = :expected", {
      ":expected": before.version,
    }),
    ...auditWrites(v, text),
    put(
      tables.runtime,
      { ...ikey, fingerprint, response, expiresAt: ttl(), createdAt: now() },
      "attribute_not_exists(PK)",
    ),
    jobPut("NOTIFY", actor.householdId, {
      visitId,
      version: v.version,
      ...(cmd.type === "reply" || cmd.type === "associate"
        ? { threadId: cmd.threadId }
        : {}),
    }),
    ...extra,
    ...authConditions(actor, grant),
  ];
  (transaction[0] as any).Put.ExpressionAttributeNames = {
    "#version": "version",
  };
  try {
    await transact(transaction as any);
  } catch (error) {
    if (conditionConflict(error)) {
      const replay = await getItem(tables.runtime, ikey.PK, ikey.SK);
      if (replay?.fingerprint === fingerprint) return replay.response;
      await refresh(actor, grant);
      const current = await getItem(tables.visits, pk, "STATE");
      throw new AppError(
        "CONFLICT",
        409,
        "The visit changed. Review the current state.",
        current ? clean<Visit>(current) : undefined,
      );
    }
    throw error;
  }
  return response;
}
