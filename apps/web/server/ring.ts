import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  db,
  tables,
  getItem,
  service,
  conditionConflict,
  makeJob,
} from "@captiondoor/db";
import { AppError, type Actor } from "@captiondoor/domain";
import {
  RingClient,
  createRingOAuthAttempt,
  validateRingOAuthState,
  encryptRingCredentials,
  decryptRingCredentials,
  type RingMediaSession,
  type RingOAuthAttempt,
} from "@captiondoor/integrations";
import {
  ringClientForHousehold,
  createMediaCleanupCredentials,
} from "@captiondoor/integrations/media-cleanup";
import {
  beginProviderMediaCheckpoint,
  bindProviderMediaCheckpoint,
} from "../../../packages/integrations/src/provider-media-checkpoint";
import { origin, hash } from "./http";
import {
  getOrCreateRingClientIdentity,
  loadRingClientIdentity,
  validateRingClientIdentity,
} from "../../../packages/integrations/src/ring-identity";

type Writes = NonNullable<TransactWriteCommandInput["TransactItems"]>;
const householdKey = (actor: Actor) => `HOUSEHOLD#${actor.householdId}`;
function managementChecks(actor: Actor, requireConsent = true): Writes {
  const seconds = Math.floor(Date.now() / 1000);
  return [
    {
      ConditionCheck: {
        TableName: tables.runtime,
        Key: { PK: `SESSION#${actor.sessionId}`, SK: "SESSION" },
        ConditionExpression:
          "expiresAt > :now AND attribute_not_exists(revoked)",
        ExpressionAttributeValues: { ":now": seconds },
      },
    },
    {
      ConditionCheck: {
        TableName: tables.config,
        Key: { PK: householdKey(actor), SK: `MEMBER#${actor.userId}` },
        ConditionExpression:
          "expiresAt > :now AND attribute_not_exists(revoked) AND #role = :owner AND grants.membership = :yes",
        ExpressionAttributeNames: { "#role": "role" },
        ExpressionAttributeValues: {
          ":now": seconds,
          ":owner": "owner",
          ":yes": true,
        },
      },
    },
    ...(requireConsent
      ? [
          {
            ConditionCheck: {
              TableName: tables.config,
              Key: { PK: householdKey(actor), SK: "PROFILE" },
              ConditionExpression: "#settings.consent.ring = :yes",
              ExpressionAttributeNames: { "#settings": "settings" },
              ExpressionAttributeValues: { ":yes": true },
            },
          },
        ]
      : []),
  ];
}
async function owner(actor: Actor, requireConsent = false) {
  actor = await service.refreshActor(actor, "membership");
  const boot = await service.bootstrap(actor);
  if (
    actor.kind !== "resident" ||
    boot.members.find((m) => m.userId === actor.userId)?.role !== "owner"
  )
    throw new AppError(
      "FORBIDDEN",
      403,
      "Only the household owner can manage Ring linking.",
    );
  if (requireConsent && !boot.settings.consent.ring)
    throw new AppError(
      "CONSENT_REQUIRED",
      409,
      "Approve the separate Ring consent first.",
    );
  return { actor, boot };
}
export async function startRing(inputActor: Actor) {
  const { actor } = await owner(inputActor, true);
  if (
    process.env.RING_MODE !== "live" ||
    !process.env.RING_CLIENT_ID ||
    !process.env.RING_CLIENT_SECRET
  )
    throw new AppError(
      "RING_CREDENTIALS_REQUIRED",
      503,
      "Ring partner OAuth is not configured. Use the clearly labelled local demo or configure authorized credentials.",
    );
  const existing = await getItem(
    tables.config,
    householdKey(actor),
    "INTEGRATION#ring",
  );
  if (
    existing &&
    ["LINKED", "LINKING", "LINKING_REVIEW_REQUIRED"].includes(existing.status)
  )
    throw new AppError(
      "RING_LINK_EXISTS",
      409,
      "Resolve or unlink the existing Ring connection before linking again.",
    );
  const clientIdentity = await getOrCreateRingClientIdentity(
    actor.householdId,
    actor.userId,
    origin,
  );
  const redirect =
    process.env.RING_REDIRECT_URI || `${origin}/api/ring/callback`;
  const { attempt, authorizationUrl } = createRingOAuthAttempt(
    process.env.RING_CLIENT_ID,
    redirect,
  );
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tables.runtime,
            Item: {
              PK: `RING_OAUTH#${hash(attempt.state)}`,
              SK: "STATE",
              attempt,
              clientIdentity,
              householdId: actor.householdId,
              sessionId: actor.sessionId,
              expiresAt: Math.floor(attempt.expiresAt / 1000),
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...managementChecks(actor),
      ],
    }),
  );
  return new Response(null, {
    status: 302,
    headers: { Location: authorizationUrl, "Cache-Control": "no-store" },
  });
}
async function markLinkUnconfirmed(actor: Actor, attemptId: string) {
  try {
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: { PK: householdKey(actor), SK: "INTEGRATION#ring" },
        UpdateExpression:
          "SET #status = :review, completionOutcome = :outcome, updatedAt = :now",
        ConditionExpression:
          "#status = :linking AND linkAttemptId = :attempt AND attribute_not_exists(revoked)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":review": "LINKING_REVIEW_REQUIRED",
          ":outcome": "UNCONFIRMED",
          ":now": Date.now(),
          ":linking": "LINKING",
          ":attempt": attemptId,
        },
      }),
    );
  } catch {
    /* A later unlink/revocation must win. The durable LINKING row remains honest if DB is unavailable. */
  }
}
export async function finishRing(req: Request, inputActor: Actor) {
  const { actor, boot } = await owner(inputActor, true);
  const url = new URL(req.url),
    state = url.searchParams.get("state"),
    code = url.searchParams.get("code");
  if (!state || !code)
    throw new AppError(
      "RING_OAUTH_STATE_INVALID",
      403,
      "Ring did not return a complete linking attempt.",
    );
  const attemptId = hash(state),
    key = { PK: `RING_OAUTH#${attemptId}`, SK: "STATE" };
  const row = await getItem(tables.runtime, key.PK, key.SK);
  if (
    !row ||
    row.sessionId !== actor.sessionId ||
    row.householdId !== actor.householdId
  )
    throw new AppError(
      "RING_OAUTH_STATE_INVALID",
      403,
      "Ring linking did not match your session.",
    );
  validateRingOAuthState(row.attempt as RingOAuthAttempt, state);
  const clientIdentity = validateRingClientIdentity(row.clientIdentity);
  const persistedIdentity = await loadRingClientIdentity(
    actor.householdId,
    actor.userId,
    origin,
  );
  if (
    clientIdentity.residentId !== actor.userId ||
    clientIdentity.backendOrigin !== persistedIdentity.backendOrigin ||
    clientIdentity.hardwareId !== persistedIdentity.hardwareId
  )
    throw new AppError(
      "RING_OAUTH_STATE_INVALID",
      403,
      "Ring linking did not match its persisted resident/client identity.",
    );
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: tables.runtime,
              Key: key,
              ConditionExpression:
                "sessionId = :session AND householdId = :household AND expiresAt > :now",
              ExpressionAttributeValues: {
                ":session": actor.sessionId,
                ":household": actor.householdId,
                ":now": Math.floor(Date.now() / 1000),
              },
            },
          },
          ...managementChecks(actor),
        ],
      }),
    );
  } catch (error) {
    if (conditionConflict(error))
      throw new AppError(
        "RING_OAUTH_STATE_INVALID",
        403,
        "Ring linking was consumed, expired or revoked.",
      );
    throw error;
  }
  const client = new RingClient({
    hardwareId: clientIdentity.hardwareId,
    mode: "live",
    clientId: process.env.RING_CLIENT_ID,
    clientSecret: process.env.RING_CLIENT_SECRET,
  });
  const tokens = await client.exchangeAuthorizationCode(
    code,
    (row.attempt as RingOAuthAttempt).verifier,
  );
  const linked = new RingClient({
    hardwareId: clientIdentity.hardwareId,
    mode: "live",
    accessToken: tokens.accessToken,
    clientId: process.env.RING_CLIENT_ID,
    clientSecret: process.env.RING_CLIENT_SECRET,
  });
  const accountId = await linked.getAccountId();
  const envelope = await encryptRingCredentials(tokens, {
    householdId: actor.householdId,
    integrationId: "ring",
  });
  // Preserve encrypted recovery material before the external completion operation.
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tables.config,
              Item: {
                PK: householdKey(actor),
                SK: "INTEGRATION#ring",
                status: "LINKING",
                accountId,
                linkMethod: "partner-oauth",
                clientIdentity,
                linkAttemptId: attemptId,
                credentials: envelope,
                updatedAt: Date.now(),
              },
              ConditionExpression:
                "attribute_not_exists(PK) OR (#status <> :linking AND #status <> :linked AND #status <> :review)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":linking": "LINKING",
                ":linked": "LINKED",
                ":review": "LINKING_REVIEW_REQUIRED",
              },
            },
          },
          ...managementChecks(actor),
        ],
      }),
    );
  } catch (error) {
    if (conditionConflict(error))
      throw new AppError(
        "RING_LINK_SUPERSEDED",
        409,
        "Ring linking was superseded or consent changed. Account completion was not requested.",
      );
    throw error;
  }
  try {
    await owner(actor, true);
    const pending = await getItem(
      tables.config,
      householdKey(actor),
      "INTEGRATION#ring",
    );
    if (
      pending?.status !== "LINKING" ||
      pending.linkAttemptId !== attemptId ||
      pending.revoked
    )
      throw new AppError(
        "RING_LINK_SUPERSEDED",
        409,
        "Ring linking was superseded.",
      );
    await linked.completeLink(`${boot.user.name.slice(0, 1)}***`);
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tables.config,
              Key: { PK: householdKey(actor), SK: "INTEGRATION#ring" },
              UpdateExpression:
                "SET #status = :linked, completionOutcome = :completed, updatedAt = :now",
              ConditionExpression:
                "#status = :linking AND linkAttemptId = :attempt AND attribute_not_exists(revoked)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":linked": "LINKED",
                ":linking": "LINKING",
                ":completed": "CONFIRMED",
                ":attempt": attemptId,
                ":now": Date.now(),
              },
            },
          },
          ...managementChecks(actor),
        ],
      }),
    );
  } catch {
    await markLinkUnconfirmed(actor, attemptId);
    throw new AppError(
      "RING_LINK_UNCONFIRMED",
      503,
      "Ring account completion could not be confirmed in CaptionDoor. Media access is blocked. Review or remove the integration in Ring before linking again.",
    );
  }
  return new Response(null, {
    status: 302,
    headers: { Location: "/settings?ring=linked", "Cache-Control": "no-store" },
  });
}
export async function listRingDevices(actor: Actor) {
  await owner(actor, true);
  const client = await ringClientForHousehold(actor.householdId, {
    residentId: actor.userId,
    backendOrigin: origin,
  });
  return (await client.listDevices()).map((d) => ({
    id: d.id,
    type: d.type,
    name:
      typeof d.attributes.name === "string" ? d.attributes.name : "Ring door",
    status:
      d.online === true ? "online" : d.online === false ? "offline" : "unknown",
  }));
}
export async function selectRingDoor(inputActor: Actor, deviceId: string) {
  const { actor, boot } = await owner(inputActor, true);
  const client = await ringClientForHousehold(actor.householdId, {
      residentId: actor.userId,
      backendOrigin: origin,
    }),
    devices = await client.listDevices();
  if (!devices.some((d) => d.id === deviceId))
    throw new AppError(
      "NOT_FOUND",
      404,
      "The selected Ring device is unavailable.",
    );
  const integration = await getItem(
    tables.config,
    householdKey(actor),
    "INTEGRATION#ring",
  );
  const accountId = await client.getAccountId();
  if (process.env.RING_MODE === "live" && integration?.accountId !== accountId)
    throw new AppError(
      "RING_ACCOUNT_INVALID",
      502,
      "Ring account correlation changed. Re-linking is required.",
    );
  const door = boot.doors[0];
  if (!door)
    throw new AppError(
      "DOOR_REQUIRED",
      409,
      "Provision the household entrance first.",
    );
  const current = await getItem(
    tables.config,
    householdKey(actor),
    `DOOR#${door.id}`,
  );
  if (!current)
    throw new AppError(
      "DOOR_REQUIRED",
      409,
      "The household entrance is unavailable.",
    );
  const conditions = ["attribute_exists(PK)"];
  const values: Record<string, unknown> = {};
  for (const name of [
    "activeVisitId",
    "ringAccountId",
    "ringDeviceId",
  ] as const) {
    if (current[name] === undefined)
      conditions.push(`attribute_not_exists(${name})`);
    else {
      conditions.push(`${name} = :${name}`);
      values[`:${name}`] = current[name];
    }
  }
  const writes: Writes = [
    {
      Put: {
        TableName: tables.config,
        Item: { ...current, ringDeviceId: deviceId, ringAccountId: accountId },
        ConditionExpression: conditions.join(" AND "),
        ...(Object.keys(values).length
          ? { ExpressionAttributeValues: values }
          : {}),
      },
    },
    {
      Put: {
        TableName: tables.config,
        Item: {
          PK: `RINGACCOUNT#${accountId}`,
          SK: "LOOKUP",
          householdId: actor.householdId,
          doorId: door.id,
          deviceId,
        },
        ConditionExpression:
          "attribute_not_exists(PK) OR householdId = :household",
        ExpressionAttributeValues: { ":household": actor.householdId },
      },
    },
    ...managementChecks(actor),
  ];
  if (current.activeVisitId) {
    const visit = await service.getVisit(actor, current.activeVisitId);
    if (visit.visit.status !== "CLOSED")
      throw new AppError(
        "ACTIVE_VISIT",
        409,
        "Close the active session before selecting another device.",
      );
    writes.push({
      ConditionCheck: {
        TableName: tables.visits,
        Key: {
          PK: `HOUSEHOLD#${actor.householdId}#VISIT#${current.activeVisitId}`,
          SK: "STATE",
        },
        ConditionExpression: "#status = :closed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED" },
      },
    });
  }
  if (current.ringAccountId && current.ringAccountId !== accountId)
    writes.push({
      Delete: {
        TableName: tables.config,
        Key: { PK: `RINGACCOUNT#${current.ringAccountId}`, SK: "LOOKUP" },
        ConditionExpression:
          "attribute_not_exists(PK) OR (householdId = :household AND doorId = :door)",
        ExpressionAttributeValues: {
          ":household": actor.householdId,
          ":door": door.id,
        },
      },
    });
  if (process.env.RING_MODE === "live")
    writes.push({
      ConditionCheck: {
        TableName: tables.config,
        Key: { PK: householdKey(actor), SK: "INTEGRATION#ring" },
        ConditionExpression:
          "#status = :linked AND attribute_not_exists(revoked) AND accountId = :account",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":linked": "LINKED",
          ":account": accountId,
        },
      },
    });
  try {
    await db.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (error) {
    if (conditionConflict(error))
      throw new AppError(
        "RING_SELECTION_CONFLICT",
        409,
        "Door selection changed, access was revoked, or this Ring account belongs to another household. Refresh before trying again.",
      );
    throw error;
  }
  return { selected: true, doorId: door.id };
}
/** Persisting a cleanup envelope grants DELETE only, never authority to return SDP. */
function mediaAdmissionChecks(
  actor: Actor,
  visitId: string,
  mediaSessionId: string,
  door: { id: string; ringDeviceId: string; ringAccountId: string },
  hardwareId: string,
): Writes {
  const now = Date.now(),
    seconds = Math.floor(now / 1000);
  return [
    {
      ConditionCheck: {
        TableName: tables.runtime,
        Key: { PK: `SESSION#${actor.sessionId}`, SK: "SESSION" },
        ConditionExpression:
          "expiresAt > :sec AND attribute_not_exists(revoked) AND householdId = :household AND userId = :user AND kind = :resident",
        ExpressionAttributeValues: {
          ":sec": seconds,
          ":household": actor.householdId,
          ":user": actor.userId,
          ":resident": "resident",
        },
      },
    },
    {
      ConditionCheck: {
        TableName: tables.config,
        Key: { PK: householdKey(actor), SK: `MEMBER#${actor.userId}` },
        ConditionExpression:
          "expiresAt > :sec AND attribute_not_exists(revoked) AND grants.camera = :yes",
        ExpressionAttributeValues: { ":sec": seconds, ":yes": true },
      },
    },
    {
      ConditionCheck: {
        TableName: tables.config,
        Key: { PK: householdKey(actor), SK: "PROFILE" },
        ConditionExpression: "#settings.consent.ring = :yes",
        ExpressionAttributeNames: { "#settings": "settings" },
        ExpressionAttributeValues: { ":yes": true },
      },
    },
    {
      ConditionCheck: {
        TableName: tables.visits,
        Key: {
          PK: `HOUSEHOLD#${actor.householdId}#VISIT#${visitId}`,
          SK: "STATE",
        },
        ConditionExpression:
          "householdId = :household AND handlerId = :user AND #status = :claimed AND mediaSessionId = :media AND mediaStatus = :connecting AND mediaSource = :ring AND mediaExpiresAt > :now AND expiresAt > :sec AND (attribute_not_exists(deleted) OR deleted = :no)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":household": actor.householdId,
          ":user": actor.userId,
          ":claimed": "CLAIMED",
          ":media": mediaSessionId,
          ":connecting": "CONNECTING",
          ":ring": "RING",
          ":now": now,
          ":sec": seconds,
          ":no": false,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: tables.config,
        Key: { PK: householdKey(actor), SK: `DOOR#${door.id}` },
        ConditionExpression:
          "ringDeviceId = :device AND ringAccountId = :account",
        ExpressionAttributeValues: {
          ":device": door.ringDeviceId,
          ":account": door.ringAccountId,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: tables.config,
        Key: { PK: `RINGACCOUNT#${door.ringAccountId}`, SK: "LOOKUP" },
        ConditionExpression:
          "householdId = :household AND doorId = :door AND deviceId = :device AND attribute_not_exists(revoked)",
        ExpressionAttributeValues: {
          ":household": actor.householdId,
          ":door": door.id,
          ":device": door.ringDeviceId,
        },
      },
    },
    ...(process.env.RING_MODE === "live"
      ? [
          {
            ConditionCheck: {
              TableName: tables.config,
              Key: { PK: householdKey(actor), SK: "INTEGRATION#ring" },
              ConditionExpression:
                "#status = :linked AND attribute_not_exists(revoked) AND attribute_exists(credentials) AND accountId = :account AND clientIdentity.hardwareId = :hardware",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":linked": "LINKED",
                ":account": door.ringAccountId,
                ":hardware": hardwareId,
              },
            },
          },
        ]
      : []),
  ];
}
export async function startMedia(
  inputActor: Actor,
  visitId: string,
  offer: string,
) {
  const checkpoint = await beginProviderMediaCheckpoint(visitId);
  let actor = await service.refreshActor(inputActor, "camera");
  const current = await service.getVisit(actor, visitId),
    boot = await service.bootstrap(actor);
  if (current.visit.handlerId !== actor.userId || !boot.settings.consent.ring)
    throw new AppError(
      "FORBIDDEN",
      403,
      "The current handler must approve incoming media.",
    );
  const door = await getItem(
    tables.config,
    householdKey(actor),
    `DOOR#${current.visit.doorId}`,
  );
  if (!door?.ringDeviceId || !door.ringAccountId)
    throw new AppError(
      "RING_DEVICE_REQUIRED",
      409,
      "Select an authorized Ring door first.",
    );
  const selectedDoor = {
    id: String(door.id),
    ringDeviceId: String(door.ringDeviceId),
    ringAccountId: String(door.ringAccountId),
  };
  const client = await ringClientForHousehold(actor.householdId, {
    residentId: actor.userId,
    backendOrigin: origin,
  });
  const { visit } = await service.command(
    actor,
    visitId,
    {
      type: "media",
      expectedVersion: current.visit.version,
      action: "start",
      consent: true,
    },
    randomUUID(),
  );
  const mediaSessionId = visit.mediaSessionId!;
  if (checkpoint) await bindProviderMediaCheckpoint(checkpoint, mediaSessionId);
  const key = {
    PK: `MEDIA#${actor.householdId}#${mediaSessionId}`,
    SK: "SESSION",
  };
  let session: RingMediaSession | undefined;
  let cleanup:
    Awaited<ReturnType<typeof createMediaCleanupCredentials>> | undefined;
  const cleanupRow = () => ({
    ...key,
    householdId: actor.householdId,
    visitId,
    mediaSessionId,
    deviceId: session!.deviceId,
    location: session!.location,
    expiresAt: Math.ceil(session!.expiresAt / 1000),
    providerExpiresAt: session!.expiresAt,
    ...cleanup!,
  });
  const cleanupWrites = (runAt: number): Writes => [
    { Put: { TableName: tables.runtime, Item: cleanupRow() } },
    {
      Put: {
        TableName: tables.runtime,
        Item: makeJob(
          "RING_MEDIA_CLOSE",
          actor.householdId,
          { visitId, mediaSessionId },
          runAt,
        ),
      },
    },
  ];
  try {
    // Resolve any required refresh while still authorized, before retaining access-only DELETE material.
    // createWhepSession repeats the documented readiness check using the normal authorized client.
    await client.getDeviceConfigurations(selectedDoor.ringDeviceId);
    cleanup = await createMediaCleanupCredentials(
      actor.householdId,
      mediaSessionId,
      selectedDoor.ringDeviceId,
      Math.min(visit.mediaExpiresAt!, Date.now() + 30_000),
      client.hardwareId,
    );
    session = await client.createWhepSession(
      selectedDoor.ringDeviceId,
      offer,
      "battery",
    );
    // A delayed 201 is not permission: recheck current actor, then fence every admission dependency atomically.
    actor = await service.refreshActor(inputActor, "camera");
    const fresh = await service.getVisit(actor, visitId);
    if (
      fresh.visit.handlerId !== actor.userId ||
      fresh.visit.mediaSessionId !== mediaSessionId ||
      fresh.visit.mediaStatus !== "CONNECTING"
    )
      throw new AppError(
        "MEDIA_STALE",
        409,
        "This incoming media session is no longer authorized.",
      );
    const expiresAt = Math.min(session.expiresAt, cleanup.cleanupExpiresAt);
    if (expiresAt <= Date.now())
      throw new AppError(
        "MEDIA_EXPIRED",
        409,
        "Incoming media expired during negotiation. Text remains available.",
      );
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            ...cleanupWrites(session.expiresAt),
            ...mediaAdmissionChecks(
              actor,
              visitId,
              mediaSessionId,
              selectedDoor,
              client.hardwareId,
            ),
          ],
        }),
      );
    } catch (error) {
      if (conditionConflict(error))
        throw new AppError(
          "MEDIA_STALE",
          409,
          "Incoming media access changed during negotiation. Text remains available.",
        );
      throw error;
    }
    return { mediaSessionId, answer: session.answer, expiresAt };
  } catch (error) {
    let cleanupUnconfirmed = false;
    if (session && cleanup) {
      try {
        if (session.expiresAt > Date.now()) {
          // The original client may now be revoked. This copy can only DELETE this allowlisted session.
          const value = await decryptRingCredentials<Record<string, unknown>>(
            cleanup.cleanupCredentials,
            { householdId: actor.householdId, integrationId: "ring" },
          );
          if (
            value.purpose !== "WHEP_DELETE" ||
            value.mediaSessionId !== mediaSessionId ||
            value.deviceId !== session.deviceId ||
            value.hardwareId !== client.hardwareId ||
            value.expiresAt !== cleanup.cleanupExpiresAt ||
            cleanup.cleanupExpiresAt <= Date.now() ||
            typeof value.accessToken !== "string"
          )
            throw new Error("Media cleanup authorization unavailable");
          await new RingClient({
            mode:
              cleanup.cleanupSource === "PLAYGROUND" ? "playground" : "live",
            hardwareId: client.hardwareId,
            accessToken: value.accessToken,
          }).closeWhepSession(session);
        }
        // Remove a possibly committed cleanup copy only after observed DELETE or bounded provider expiry.
        await db.send(
          new DeleteCommand({ TableName: tables.runtime, Key: key }),
        );
      } catch {
        try {
          // Revocation may have dispatched its close job before the delayed provider response existed.
          // Persist a fresh cleanup-only job even when media admission is denied; never return its SDP.
          const runAt =
            cleanup.cleanupExpiresAt > Date.now()
              ? Date.now()
              : session.expiresAt;
          await db.send(
            new TransactWriteCommand({ TransactItems: cleanupWrites(runAt) }),
          );
        } catch {
          cleanupUnconfirmed = true;
        }
      }
    }
    try {
      const fresh = await service.getVisit(actor, visitId);
      if (fresh.visit.mediaSessionId === mediaSessionId)
        await service.command(
          actor,
          visitId,
          {
            type: "media",
            expectedVersion: fresh.visit.version,
            action: "unavailable",
          },
          randomUUID(),
        );
    } catch {
      /* A newer handler/revocation fences this request. */
    }
    if (cleanupUnconfirmed)
      throw new AppError(
        "RING_MEDIA_CLEANUP_UNCONFIRMED",
        503,
        "Media was not admitted. Provider cleanup and durable retry could not be confirmed; provider expiry remains bounded.",
      );
    throw error;
  }
}
export async function stopMedia(
  actor: Actor,
  visitId: string,
  mediaSessionId: string,
) {
  const { visit } = await service.getVisit(actor, visitId);
  if (visit.handlerId !== actor.userId)
    throw new AppError(
      "HANDLER_REQUIRED",
      403,
      "Only the current handler can stop this media session.",
    );
  if (visit.mediaSessionId && visit.mediaSessionId !== mediaSessionId)
    throw new AppError("MEDIA_STALE", 409, "The media session has changed.");
  return service.command(
    actor,
    visitId,
    { type: "media", expectedVersion: visit.version, action: "stop" },
    randomUUID(),
  );
}
export async function unlinkRing(actor: Actor) {
  await owner(actor);
  let externalError: unknown;
  if (process.env.RING_MODE === "live") {
    try {
      const client = await ringClientForHousehold(actor.householdId, {
        residentId: actor.userId,
        backendOrigin: origin,
      });
      await client.unlink("partner-oauth");
    } catch (error) {
      externalError = error;
    }
  }
  await service.unlink(actor);
  if (externalError)
    throw new AppError(
      "RING_UNLINK_PENDING",
      503,
      "CaptionDoor access is revoked locally. Ring did not confirm external unlinking; remove the integration in Ring and retry when available.",
    );
  return { unlinked: true };
}

/** Reported by the browser only after ICE connected and an incoming video track arrived. */
export async function readyMedia(
  actor: Actor,
  visitId: string,
  mediaSessionId: string,
) {
  const { visit } = await service.getVisit(actor, visitId);
  if (
    visit.handlerId !== actor.userId ||
    visit.mediaSessionId !== mediaSessionId
  )
    throw new AppError(
      "MEDIA_STALE",
      409,
      "This incoming media session is no longer authorized.",
    );
  const record = await getItem(
    tables.runtime,
    `MEDIA#${actor.householdId}#${mediaSessionId}`,
    "SESSION",
  );
  if (
    !record ||
    record.visitId !== visitId ||
    record.expiresAt * 1000 <= Date.now()
  )
    throw new AppError(
      "MEDIA_EXPIRED",
      409,
      "Incoming media expired. Visitor text remains available.",
    );
  if (visit.mediaStatus === "LIVE") return { visit };
  return service.completeMedia(actor, visitId, {
    mediaSessionId,
    expiresAt: Math.min(
      record.providerExpiresAt || record.expiresAt * 1000,
      record.cleanupExpiresAt || Infinity,
    ),
  });
}
