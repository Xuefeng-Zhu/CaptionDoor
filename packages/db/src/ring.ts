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
export async function press(input: {
  accountId: string;
  deviceId: string;
  eventId: string;
  deliveryId: string;
  source?: "LOCAL" | "PLAYGROUND" | "LIVE";
}): Promise<{ visit: Visit; duplicate: boolean }> {
  const account = await getItem(
    tables.config,
    `RINGACCOUNT#${input.accountId}`,
    "LOOKUP",
  );
  if (!account || account.revoked || account.deviceId !== input.deviceId)
    throw new AppError(
      "UNKNOWN_ACCOUNT",
      403,
      "Unknown Ring account or device.",
    );
  const source = input.source || "LIVE";
  if (source === "LOCAL" && (process.env.RING_MODE || "demo") !== "demo")
    throw new AppError(
      "DEMO_DISABLED",
      403,
      "Local event simulation is disabled.",
    );
  const semantic = {
    PK: `SEMANTIC#${input.accountId}#${hashToken(input.eventId)}`,
    SK: "EVENT",
  };
  const deliveryKey = {
    PK: `DEDUP#${input.accountId}#${hashToken(input.deliveryId)}`,
    SK: "DELIVERY",
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    const existing =
      (await getItem(tables.runtime, semantic.PK, semantic.SK)) ||
      (await getItem(tables.runtime, deliveryKey.PK, deliveryKey.SK));
    if (existing) {
      const old = await getItem(
        tables.visits,
        visitPK(account.householdId, existing.visitId),
        "STATE",
      );
      if (!old)
        throw new AppError(
          "EXPIRED",
          410,
          "This event was already processed and its visit expired.",
        );
      return { visit: clean<Visit>(old), duplicate: true };
    }
    const door = await getItem(
      tables.config,
      householdPK(account.householdId),
      `DOOR#${account.doorId || account.deviceId}`,
    );
    if (!door) throw new AppError("NOT_FOUND", 404, "Door is unavailable.");
    if (
      (door.ringAccountId && door.ringAccountId !== input.accountId) ||
      (door.ringDeviceId && door.ringDeviceId !== input.deviceId)
    )
      throw new AppError(
        "UNKNOWN_ACCOUNT",
        403,
        "This Ring device is no longer selected.",
      );
    let old: Row | undefined;
    if (door.activeVisitId)
      old = await getItem(
        tables.visits,
        visitPK(account.householdId, door.activeVisitId),
        "STATE",
      );
    const p = await profile(account.householdId);
    if (old && old.historyVersion !== 2) {
      await ensureTimeline(old.PK);
      old.historyVersion = 2;
    }
    const active =
      !!old &&
      old.status !== "CLOSED" &&
      !old.deleted &&
      old.expiresAt > seconds();
    const visit: Visit = active
      ? { ...clean<Visit>(old!), version: old!.version + 1, updatedAt: now() }
      : {
          id: id(),
          householdId: account.householdId,
          doorId: door.id,
          doorName: door.name,
          status: "UNCLAIMED",
          version: 1,
          createdAt: now(),
          updatedAt: now(),
          expiresAt: ttl(p.settings.retentionHours),
          mediaStatus: "IDLE",
          eventSource: source,
          mediaSource: "NONE",
          transcriptSource: "NONE",
        };
    const pointerValues: Record<string, unknown> = { ":visit": visit.id };
    if (door.activeVisitId) pointerValues[":old"] = door.activeVisitId;
    pointerValues[":account"] = input.accountId;
    pointerValues[":device"] = input.deviceId;
    const state = put(
      tables.visits,
      { ...stateRow(visit), historyVersion: 2 },
      active ? "#version = :expected" : "attribute_not_exists(PK)",
      active ? { ":expected": old!.version } : undefined,
    );
    if (active)
      (state as any).Put.ExpressionAttributeNames = { "#version": "version" };
    try {
      await transact([
        state,
        {
          Update: {
            TableName: tables.config,
            Key: { PK: door.PK, SK: door.SK },
            UpdateExpression: "SET activeVisitId = :visit",
            ConditionExpression: `${door.activeVisitId ? "activeVisitId = :old" : "attribute_not_exists(activeVisitId)"} AND (attribute_not_exists(ringAccountId) OR ringAccountId = :account) AND (attribute_not_exists(ringDeviceId) OR ringDeviceId = :device)`,
            ExpressionAttributeValues: pointerValues,
          },
        },
        {
          ConditionCheck: {
            TableName: tables.config,
            Key: { PK: account.PK, SK: account.SK },
            ConditionExpression:
              "attribute_not_exists(revoked) AND householdId = :household AND deviceId = :device",
            ExpressionAttributeValues: {
              ":household": account.householdId,
              ":device": input.deviceId,
            },
          },
        },
        put(
          tables.runtime,
          { ...semantic, visitId: visit.id, expiresAt: ttl(24 * 7) },
          "attribute_not_exists(PK)",
        ),
        put(
          tables.runtime,
          { ...deliveryKey, visitId: visit.id, expiresAt: ttl(24 * 7) },
          "attribute_not_exists(PK)",
        ),
        ...auditWrites(
          visit,
          `${source === "LOCAL" ? "LOCAL simulated" : "Ring"} doorbell button event received. This event is not identity or presence proof.`,
        ),
        jobPut("NOTIFY", visit.householdId, {
          visitId: visit.id,
          version: visit.version,
        }),
        ...(!active
          ? [
              jobPut(
                "DELETE_VISIT",
                visit.householdId,
                { visitId: visit.id },
                visit.expiresAt * 1000,
              ),
            ]
          : []),
      ] as any);
      return { visit, duplicate: false };
    } catch (error) {
      if (conditionConflict(error)) continue;
      throw error;
    }
  }
  throw new AppError(
    "BUSY",
    503,
    "Door event persistence is busy. Retry this delivery.",
  );
}

export async function revokeRingAccount(
  accountId: string,
  deviceId?: string,
  reason = "Ring access revoked",
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const account = await getItem(
      tables.config,
      `RINGACCOUNT#${accountId}`,
      "LOOKUP",
    );
    if (!account || (deviceId && account.deviceId !== deviceId))
      throw new AppError(
        "UNKNOWN_ACCOUNT",
        403,
        "Unknown Ring account or device.",
      );
    const doors = (
      await rows(tables.config, householdPK(account.householdId), "DOOR#")
    ).filter((door) => door.ringAccountId === accountId);
    if (!doors.length)
      throw new AppError(
        "UNKNOWN_ACCOUNT",
        403,
        "This Ring account is no longer selected.",
      );
    const p = await profile(account.householdId),
      integration = await getItem(
        tables.config,
        householdPK(account.householdId),
        "INTEGRATION#ring",
      );
    if (integration?.accountId && integration.accountId !== accountId)
      throw new AppError(
        "UNKNOWN_ACCOUNT",
        403,
        "This Ring account was superseded.",
      );
    const transaction: any[] = [
      {
        Update: {
          TableName: tables.config,
          Key: { PK: account.PK, SK: account.SK },
          UpdateExpression:
            "SET revoked = :yes, revokedAt = if_not_exists(revokedAt, :now)",
          ConditionExpression:
            "householdId = :household AND deviceId = :device",
          ExpressionAttributeValues: {
            ":yes": true,
            ":now": now(),
            ":household": account.householdId,
            ":device": account.deviceId,
          },
        },
      },
      {
        Update: {
          TableName: tables.config,
          Key: { PK: p.PK, SK: p.SK },
          UpdateExpression:
            "SET settings.consent.ring = :no, settings.consent.transcription = :no",
          ExpressionAttributeValues: { ":no": false },
        },
      },
    ];
    if (integration)
      transaction.push({
        Update: {
          TableName: tables.config,
          Key: { PK: integration.PK, SK: integration.SK },
          UpdateExpression: "SET #status = :revoked, revoked = :yes",
          ConditionExpression:
            "attribute_not_exists(accountId) OR accountId = :account",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":revoked": "REVOKED",
            ":yes": true,
            ":account": accountId,
          },
        },
      });
    for (const door of doors) {
      transaction.push({
        ConditionCheck: {
          TableName: tables.config,
          Key: { PK: door.PK, SK: door.SK },
          ConditionExpression: `ringAccountId = :account AND ${door.activeVisitId ? "activeVisitId = :visit" : "attribute_not_exists(activeVisitId)"}`,
          ExpressionAttributeValues: {
            ":account": accountId,
            ...(door.activeVisitId ? { ":visit": door.activeVisitId } : {}),
          },
        },
      });
      if (!door.activeVisitId) continue;
      const old = await getItem(
        tables.visits,
        visitPK(account.householdId, door.activeVisitId),
        "STATE",
      );
      if (
        !old ||
        old.status === "CLOSED" ||
        (old.mediaStatus === "ENDED" && !old.mediaSessionId && !old.audioLease)
      )
        continue;
      const v = clean<Visit>(old);
      v.version++;
      v.mediaStatus = "ENDED";
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
          "Ring access revoked. Media and capture ended; text remains available.",
        ),
        jobPut("NOTIFY", account.householdId, {
          visitId: v.id,
          version: v.version,
        }),
      );
      if (old.mediaSource === "RING" && old.mediaSessionId)
        transaction.push(
          jobPut("RING_MEDIA_CLOSE", account.householdId, {
            visitId: v.id,
            mediaSessionId: old.mediaSessionId,
          }),
        );
    }
    try {
      await transact(transaction);
      return { revoked: true };
    } catch (error) {
      if (conditionConflict(error)) continue;
      throw error;
    }
  }
  throw new AppError(
    "BUSY",
    503,
    "Ring revocation persistence is busy. Retry delivery.",
  );
}

export async function ringDeviceOffline(
  accountId: string,
  deviceId: string,
  eventId: string,
  deliveryId: string,
) {
  const account = await getItem(
    tables.config,
    `RINGACCOUNT#${accountId}`,
    "LOOKUP",
  );
  if (!account || account.revoked || account.deviceId !== deviceId)
    throw new AppError(
      "UNKNOWN_ACCOUNT",
      403,
      "Unknown Ring account or device.",
    );
  const semantic = {
      PK: `SEMANTIC#${accountId}#${hashToken(eventId)}`,
      SK: "EVENT",
    },
    deliveryKey = {
      PK: `DEDUP#${accountId}#${hashToken(deliveryId)}`,
      SK: "DELIVERY",
    };
  for (let attempt = 0; attempt < 5; attempt++) {
    if (
      (await getItem(tables.runtime, semantic.PK, semantic.SK)) ||
      (await getItem(tables.runtime, deliveryKey.PK, deliveryKey.SK))
    )
      return { duplicate: true };
    const door = await getItem(
      tables.config,
      householdPK(account.householdId),
      `DOOR#${account.doorId || account.deviceId}`,
    );
    if (
      !door ||
      (door.ringAccountId && door.ringAccountId !== accountId) ||
      (door.ringDeviceId && door.ringDeviceId !== deviceId)
    )
      throw new AppError(
        "UNKNOWN_ACCOUNT",
        403,
        "This Ring device is no longer selected.",
      );
    const transaction: any[] = [
      put(
        tables.runtime,
        { ...semantic, visitId: door.activeVisitId, expiresAt: ttl(24 * 7) },
        "attribute_not_exists(PK)",
      ),
      put(
        tables.runtime,
        { ...deliveryKey, visitId: door.activeVisitId, expiresAt: ttl(24 * 7) },
        "attribute_not_exists(PK)",
      ),
      {
        ConditionCheck: {
          TableName: tables.config,
          Key: { PK: account.PK, SK: account.SK },
          ConditionExpression:
            "attribute_not_exists(revoked) AND deviceId = :device",
          ExpressionAttributeValues: { ":device": deviceId },
        },
      },
    ];
    const old = door.activeVisitId
      ? await getItem(
          tables.visits,
          visitPK(account.householdId, door.activeVisitId),
          "STATE",
        )
      : undefined;
    if (old && old.status !== "CLOSED" && !old.deleted) {
      const v = clean<Visit>(old);
      v.version++;
      v.mediaStatus = "UNAVAILABLE";
      delete v.mediaSessionId;
      delete v.audioLease;
      const state = put(tables.visits, stateRow(v), "#version = :version", {
        ":version": old.version,
      });
      (state as any).Put.ExpressionAttributeNames = { "#version": "version" };
      transaction.push(
        state,
        del(tables.runtime, { PK: old.PK, SK: "CAPTURE" }),
        ...auditWrites(
          v,
          "Ring device reported offline. Incoming media is unavailable; text remains available.",
        ),
        jobPut("NOTIFY", account.householdId, {
          visitId: v.id,
          version: v.version,
        }),
      );
      if (old.mediaSource === "RING" && old.mediaSessionId)
        transaction.push(
          jobPut("RING_MEDIA_CLOSE", account.householdId, {
            visitId: v.id,
            mediaSessionId: old.mediaSessionId,
          }),
        );
    }
    try {
      await transact(transaction);
      return { duplicate: false };
    } catch (error) {
      if (conditionConflict(error)) continue;
      throw error;
    }
  }
  throw new AppError(
    "BUSY",
    503,
    "Offline event persistence is busy. Retry delivery.",
  );
}
