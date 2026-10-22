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
async function writeSettings(
  actor: Actor,
  input: SettingsInput,
  extraWrites: any[] = [],
): Promise<Settings> {
  actor = await resident(actor, "membership");
  const mine = await member(actor.householdId, actor.userId);
  if (mine.role !== "owner")
    throw new AppError(
      "FORBIDDEN",
      403,
      "Only a household owner can change privacy settings.",
    );
  const value = settingsSchema.parse(input);
  const p = await profile(actor.householdId);
  const extra: any[] = [];
  if (
    !value.consent.ring ||
    !value.consent.transcription ||
    !value.consent.sharing
  ) {
    const doors = await rows(
      tables.config,
      householdPK(actor.householdId),
      "DOOR#",
    );
    for (const door of doors) {
      if (!door.activeVisitId) continue;
      const old = await getItem(
        tables.visits,
        visitPK(actor.householdId, door.activeVisitId),
        "STATE",
      );
      if (!old || old.status === "CLOSED") continue;
      const v = clean<Visit>(old);
      v.version++;
      v.mediaStatus = "ENDED";
      delete v.audioLease;
      delete v.mediaSessionId;
      extra.push(
        put(tables.visits, stateRow(v), "#version = :version", {
          ":version": old.version,
        }),
      );
      extra.at(-1).Put.ExpressionAttributeNames = { "#version": "version" };
      if (old.mediaSource === "RING" && old.mediaSessionId)
        extra.push(
          jobPut("RING_MEDIA_CLOSE", actor.householdId, {
            visitId: v.id,
            mediaSessionId: old.mediaSessionId,
          }),
        );
      extra.push(
        del(tables.runtime, { PK: old.PK, SK: "CAPTURE" }),
        ...auditWrites(
          v,
          "Consent revoked. Incoming media and transcription stopped.",
        ),
        jobPut("NOTIFY", actor.householdId, {
          visitId: v.id,
          version: v.version,
        }),
      );
    }
  }
  await transact([
    put(
      tables.config,
      { ...p, settings: value },
      p.membershipVersion === undefined
        ? "attribute_not_exists(membershipVersion)"
        : "membershipVersion = :membershipVersion",
      p.membershipVersion === undefined
        ? undefined
        : { ":membershipVersion": p.membershipVersion },
    ),
    ...extra,
    ...extraWrites,
    ...authConditions(actor, "membership"),
  ] as any);
  return value;
}

export async function settings(
  actor: Actor,
  input: SettingsInput,
): Promise<Settings> {
  return writeSettings(actor, input);
}

export async function unlink(actor: Actor) {
  actor = await resident(actor, "membership");
  const p = await profile(actor.householdId);
  const integrationKey = {
    PK: householdPK(actor.householdId),
    SK: "INTEGRATION#ring",
  };
  const extraWrites: any[] = [
    put(tables.config, {
      ...integrationKey,
      status: "UNLINKED",
      revoked: true,
      updatedAt: now(),
    }),
  ];
  const doors = await rows(
    tables.config,
    householdPK(actor.householdId),
    "DOOR#",
  );
  for (const door of doors) {
    if (!door.ringAccountId) continue;
    const mapping = await getItem(
      tables.config,
      `RINGACCOUNT#${door.ringAccountId}`,
      "LOOKUP",
    );
    if (mapping?.householdId === actor.householdId)
      extraWrites.push(
        put(
          tables.config,
          { ...mapping, revoked: true },
          "householdId = :household",
          { ":household": actor.householdId },
        ),
      );
  }
  await writeSettings(
    actor,
    {
      ...p.settings,
      consent: { ...p.settings.consent, ring: false, transcription: false },
    },
    extraWrites,
  );
  return { status: "UNLINKED" };
}

export async function revoke(actor: Actor, userId: string) {
  actor = await resident(actor, "membership");
  const mine = await member(actor.householdId, actor.userId);
  if (mine.role !== "owner" || userId === actor.userId)
    throw new AppError("FORBIDDEN", 403, "An owner can revoke another member.");
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = await getItem(
      tables.config,
      householdPK(actor.householdId),
      `MEMBER#${userId}`,
    );
    if (!target) throw new AppError("NOT_FOUND", 404, "Member is unavailable.");
    if (target.revoked) return { revoked: true };
    const transaction: any[] = [
      put(
        tables.config,
        { ...target, revoked: true, revokedAt: now() },
        "attribute_not_exists(revoked)",
      ),
      ...authConditions(actor, "membership"),
    ];
    const doors = await rows(
      tables.config,
      householdPK(actor.householdId),
      "DOOR#",
    );
    for (const door of doors) {
      if (!door.activeVisitId) continue;
      const old = await getItem(
        tables.visits,
        visitPK(actor.householdId, door.activeVisitId),
        "STATE",
      );
      if (
        !old ||
        (old.handlerId !== userId && old.audioLease?.holderId !== userId)
      )
        continue;
      const v = clean<Visit>(old);
      v.version++;
      if (v.mediaSessionId || v.audioLease) v.mediaStatus = "ENDED";
      delete v.audioLease;
      delete v.mediaSessionId;
      const state = put(tables.visits, stateRow(v), "#version = :version", {
        ":version": old.version,
      });
      (state as any).Put.ExpressionAttributeNames = { "#version": "version" };
      transaction.push(
        state,
        del(tables.runtime, { PK: old.PK, SK: "CAPTURE" }),
        ...auditWrites(
          v,
          "Member access revoked; capture stopped. Responsibility requires explicit authorized takeover.",
        ),
        jobPut("NOTIFY", actor.householdId, {
          visitId: v.id,
          version: v.version,
        }),
      );
      if (old.mediaSource === "RING" && old.mediaSessionId)
        transaction.push(
          jobPut("RING_MEDIA_CLOSE", actor.householdId, {
            visitId: v.id,
            mediaSessionId: old.mediaSessionId,
          }),
        );
    }
    try {
      await transact(transaction);
      return { revoked: true };
    } catch (error) {
      if (conditionConflict(error)) {
        await refresh(actor, "membership");
        continue;
      }
      throw error;
    }
  }
  throw new AppError("BUSY", 503, "Member revocation is busy. Please retry.");
}

export async function invite(actor: Actor, input: { name: string }) {
  actor = await resident(actor, "membership");
  const mine = await member(actor.householdId, actor.userId);
  if (mine.role !== "owner")
    throw new AppError("FORBIDDEN", 403, "Only an owner can invite a member.");
  const name = input.name.trim();
  if (!name || name.length > 80)
    throw new AppError("VALIDATION", 400, "Enter a name up to 80 characters.");
  const code = secret();
  const expiresAt = seconds() + 86400;
  await transact([
    put(tables.runtime, {
      PK: `INVITE#${hashToken(code)}`,
      SK: "INVITE",
      householdId: actor.householdId,
      name,
      createdBy: actor.userId,
      expiresAt,
    }),
    ...authConditions(actor, "membership"),
  ] as any);
  return { inviteCode: code, expiresAt };
}

/** Subject/proof are supplied only by the verified Cognito/OIDC server flow. */
export async function acceptInvite(
  verifiedSubject: string,
  inviteCode: string,
  pendingProof?: Key,
) {
  if (process.env.AUTH_MODE !== "oidc")
    throw new AppError(
      "OIDC_REQUIRED",
      403,
      "Member invitations require verified app sign-in.",
    );
  if (
    !verifiedSubject ||
    verifiedSubject.length > 200 ||
    !inviteCode ||
    inviteCode.length > 256
  )
    throw new AppError("VALIDATION", 400, "Invalid invitation.");
  if (
    pendingProof &&
    (!pendingProof.PK.startsWith("PENDING_IDENTITY#") ||
      pendingProof.SK !== "IDENTITY")
  )
    throw new AppError(
      "IDENTITY_REQUIRED",
      401,
      "The verified sign-in is unavailable.",
    );
  const proofDelete = () => ({
    Delete: {
      TableName: tables.runtime,
      Key: pendingProof!,
      ConditionExpression: "subject = :subject AND expiresAt > :now",
      ExpressionAttributeValues: {
        ":subject": verifiedSubject,
        ":now": seconds(),
      },
    },
  });
  const sessionResult = (
    userId: string,
    householdId: string,
    name: string,
    grants: Actor["grants"],
  ) => {
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
      grants,
    };
    return { token, csrf, user: { id: userId, name }, actor };
  };
  const sessionPut = (result: ReturnType<typeof sessionResult>) =>
    put(tables.runtime, {
      PK: `SESSION#${result.actor.sessionId}`,
      SK: "SESSION",
      ...result.actor,
      createdAt: now(),
    });
  const checkProof = async () => {
    if (!pendingProof) return;
    const row = await getItem(tables.runtime, pendingProof.PK, pendingProof.SK);
    if (!row || row.subject !== verifiedSubject || row.expiresAt <= seconds())
      throw new AppError(
        "IDENTITY_REQUIRED",
        401,
        "The verified sign-in expired or was consumed. Sign in again.",
      );
  };
  const inviteKey = { PK: `INVITE#${hashToken(inviteCode)}`, SK: "INVITE" };
  for (let attempt = 0; attempt < 5; attempt++) {
    await checkProof();
    const invitation = await getItem(
      tables.runtime,
      inviteKey.PK,
      inviteKey.SK,
    );
    if (!invitation)
      throw new AppError(
        "INVITE_NOT_FOUND",
        404,
        "This invitation is unavailable.",
      );
    if (invitation.expiresAt <= seconds())
      throw new AppError("INVITE_EXPIRED", 410, "This invitation has expired.");
    const lookup = await getItem(
      tables.config,
      `USER#${verifiedSubject}`,
      "LOOKUP",
    );
    if (lookup && lookup.householdId !== invitation.householdId)
      throw new AppError(
        "HOUSEHOLD_CONFLICT",
        409,
        "This app identity already belongs to a different household.",
      );
    const userId = lookup?.userId || verifiedSubject,
      PK = householdPK(invitation.householdId);
    if (invitation.consumedBy) {
      if (invitation.consumedBy !== verifiedSubject)
        throw new AppError(
          "INVITE_USED",
          409,
          "This invitation has already been used.",
        );
      if (!pendingProof)
        return createResidentSession(userId, invitation.householdId);
      const current = await member(invitation.householdId, userId),
        result = sessionResult(
          userId,
          invitation.householdId,
          current.name,
          current.grants,
        );
      try {
        await transact([
          sessionPut(result),
          proofDelete(),
          {
            ConditionCheck: {
              TableName: tables.config,
              Key: { PK, SK: `MEMBER#${userId}` },
              ConditionExpression:
                "attribute_not_exists(revoked) AND expiresAt > :now",
              ExpressionAttributeValues: { ":now": seconds() },
            },
          },
        ] as any);
        return result;
      } catch (error) {
        if (conditionConflict(error)) {
          await checkProof();
          continue;
        }
        throw error;
      }
    }
    const p = await profile(invitation.householdId),
      memberships = await rows(tables.config, PK, "MEMBER#");
    const active = memberships.filter(
        (m) => !m.revoked && m.expiresAt > seconds(),
      ),
      existing = active.find((m) => m.userId === userId);
    if (!existing && active.length >= 2)
      throw new AppError(
        "HOUSEHOLD_FULL",
        409,
        "This MVP supports two active household members.",
      );
    const grants: Actor["grants"] = existing?.grants || {
      camera: true,
      captions: true,
      visitorText: true,
      membership: false,
    };
    const result = sessionResult(
      userId,
      invitation.householdId,
      existing?.name || invitation.name,
      grants,
    );
    const transaction: any[] = [
      {
        Update: {
          TableName: tables.runtime,
          Key: inviteKey,
          UpdateExpression: "SET consumedBy = :subject, consumedAt = :now",
          ConditionExpression:
            "attribute_not_exists(consumedBy) AND expiresAt > :seconds",
          ExpressionAttributeValues: {
            ":subject": verifiedSubject,
            ":now": now(),
            ":seconds": seconds(),
          },
        },
      },
      put(
        tables.config,
        {
          PK: `USER#${verifiedSubject}`,
          SK: "LOOKUP",
          userId,
          householdId: invitation.householdId,
        },
        "attribute_not_exists(PK) OR householdId = :household",
        { ":household": invitation.householdId },
      ),
      {
        Update: {
          TableName: tables.config,
          Key: { PK, SK: "PROFILE" },
          UpdateExpression: "SET membershipVersion = :next",
          ConditionExpression:
            p.membershipVersion === undefined
              ? "attribute_not_exists(membershipVersion)"
              : "membershipVersion = :old",
          ExpressionAttributeValues: {
            ":next": (p.membershipVersion || 0) + 1,
            ...(p.membershipVersion === undefined
              ? {}
              : { ":old": p.membershipVersion }),
          },
        },
      },
      sessionPut(result),
      ...(pendingProof ? [proofDelete()] : []),
    ];
    if (!existing)
      transaction.push(
        put(
          tables.config,
          {
            PK,
            SK: `MEMBER#${userId}`,
            userId,
            name: invitation.name,
            role: "member",
            expiresAt: seconds() + 365 * 86400,
            grants,
          },
          "attribute_not_exists(PK) OR revoked = :yes OR expiresAt <= :now",
          { ":yes": true, ":now": seconds() },
        ),
      );
    else
      transaction.push({
        ConditionCheck: {
          TableName: tables.config,
          Key: { PK, SK: `MEMBER#${userId}` },
          ConditionExpression:
            "attribute_not_exists(revoked) AND expiresAt > :now",
          ExpressionAttributeValues: { ":now": seconds() },
        },
      });
    try {
      await transact(transaction);
      return result;
    } catch (error) {
      if (conditionConflict(error)) {
        await checkProof();
        continue;
      }
      throw error;
    }
  }
  throw new AppError(
    "BUSY",
    503,
    "Invitation acceptance is busy. Please try again.",
  );
}
