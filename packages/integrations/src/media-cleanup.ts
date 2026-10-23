import { randomUUID } from "node:crypto";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, tables, getItem, conditionConflict } from "@captiondoor/db";
import { AppError } from "@captiondoor/domain";
import {
  RingClient,
  validateRingHardwareId,
  type RingMode,
  type RingTokens,
} from "./ring";
import {
  getOrCreateRingClientIdentity,
  validateRingClientIdentity,
} from "./ring-identity";
import {
  decryptRingCredentials,
  encryptRingCredentials,
  type CredentialEnvelope,
} from "./crypto";

export async function ringClientForHousehold(
  householdId: string,
  residentClient?: { residentId: string; backendOrigin: string },
): Promise<RingClient> {
  const mode = (process.env.RING_MODE || "demo") as RingMode;
  if (mode === "demo")
    throw new AppError(
      "RING_LOCAL_MODE",
      409,
      "Local simulation has no Ring media.",
    );
  if (mode === "playground") {
    if (!residentClient)
      throw new AppError(
        "RING_CLIENT_IDENTITY_REQUIRED",
        503,
        "A trusted resident/client scope is required for Playground requests.",
      );
    const identity = await getOrCreateRingClientIdentity(
      householdId,
      residentClient.residentId,
      residentClient.backendOrigin,
    );
    return new RingClient({
      mode,
      hardwareId: identity.hardwareId,
      accessToken: process.env.RING_PLAYGROUND_TOKEN,
    });
  }
  const key = { PK: `HOUSEHOLD#${householdId}`, SK: "INTEGRATION#ring" };
  const integration = await getItem(tables.config, key.PK, key.SK);
  if (
    !integration?.credentials ||
    integration.revoked ||
    integration.status !== "LINKED"
  )
    throw new AppError(
      "RING_LINK_REQUIRED",
      409,
      "Connect Ring before starting incoming media.",
    );
  const identity = validateRingClientIdentity(integration.clientIdentity);
  const identityMatches = (row: Record<string, any>) =>
    row.clientIdentity?.hardwareId === identity.hardwareId &&
    row.clientIdentity?.residentId === identity.residentId &&
    row.clientIdentity?.backendOrigin === identity.backendOrigin;
  const client = new RingClient({
    hardwareId: identity.hardwareId,
    mode,
    clientId: process.env.RING_CLIENT_ID,
    clientSecret: process.env.RING_CLIENT_SECRET,
    accessToken: async () => {
      const row = await getItem(tables.config, key.PK, key.SK);
      if (!row?.credentials || row.revoked || row.status !== "LINKED")
        throw new AppError(
          "RING_LINK_REQUIRED",
          409,
          "Connect Ring before starting incoming media.",
        );
      if (!identityMatches(row))
        throw new AppError(
          "RING_ACCESS_CHANGED",
          409,
          "Ring client identity changed during this request.",
        );
      const tokens = await decryptRingCredentials<
        RingTokens & Record<string, unknown>
      >(row.credentials as CredentialEnvelope, {
        householdId,
        integrationId: "ring",
      });
      const fresh = await getItem(tables.config, key.PK, key.SK);
      if (
        !fresh?.credentials ||
        JSON.stringify(fresh.credentials) !== JSON.stringify(row.credentials) ||
        !identityMatches(fresh) ||
        fresh.revoked ||
        fresh.status !== "LINKED"
      )
        throw new AppError(
          "RING_ACCESS_CHANGED",
          409,
          "Ring access changed during this request.",
        );
      if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
      const now = Date.now(),
        refreshOwner = randomUUID();
      try {
        await db.send(
          new UpdateCommand({
            TableName: tables.config,
            Key: key,
            UpdateExpression:
              "SET refreshUntil = :until, refreshOwner = :owner",
            ConditionExpression:
              "#status = :linked AND attribute_not_exists(revoked) AND clientIdentity = :identity AND credentials = :credentials AND (attribute_not_exists(refreshUntil) OR refreshUntil < :now)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":until": now + 15_000,
              ":owner": refreshOwner,
              ":linked": "LINKED",
              ":credentials": row.credentials,
              ":identity": identity,
              ":now": now,
            },
          }),
        );
      } catch (error) {
        if (conditionConflict(error))
          throw new AppError(
            "RING_REFRESH_BUSY",
            503,
            "Ring authorization changed or is refreshing. Please retry.",
          );
        throw error;
      }
      let refreshed: RingTokens | undefined;
      try {
        refreshed = await new RingClient({
          hardwareId: identity.hardwareId,
          mode: "live",
          clientId: process.env.RING_CLIENT_ID,
          clientSecret: process.env.RING_CLIENT_SECRET,
        }).refresh(tokens.refreshToken);
        const envelope = await encryptRingCredentials(refreshed, {
          householdId,
          integrationId: "ring",
        });
        await db.send(
          new UpdateCommand({
            TableName: tables.config,
            Key: key,
            UpdateExpression:
              "SET credentials = :credentials, updatedAt = :now REMOVE refreshUntil, refreshOwner",
            ConditionExpression:
              "#status = :linked AND attribute_not_exists(revoked) AND refreshOwner = :owner AND refreshUntil > :now AND credentials = :before AND clientIdentity = :identity",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":credentials": envelope,
              ":now": Date.now(),
              ":linked": "LINKED",
              ":owner": refreshOwner,
              ":before": row.credentials,
              ":identity": identity,
            },
          }),
        );
        return refreshed.accessToken;
      } catch (error) {
        // If token rotation succeeded but its durable write did not, block new access honestly.
        if (refreshed) {
          try {
            await db.send(
              new UpdateCommand({
                TableName: tables.config,
                Key: key,
                UpdateExpression: "SET #status = :relink, updatedAt = :now",
                ConditionExpression:
                  "#status = :linked AND attribute_not_exists(revoked) AND refreshOwner = :owner AND clientIdentity = :identity",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":relink": "RELINK_REQUIRED",
                  ":linked": "LINKED",
                  ":now": Date.now(),
                  ":owner": refreshOwner,
                  ":identity": identity,
                },
              }),
            );
          } catch {
            /* A later revoke or replaced lease wins. */
          }
          throw new AppError(
            "RING_REFRESH_UNCONFIRMED",
            503,
            "Ring token renewal could not be stored safely. Re-linking may be required.",
          );
        }
        throw error;
      } finally {
        try {
          await db.send(
            new UpdateCommand({
              TableName: tables.config,
              Key: key,
              UpdateExpression: "REMOVE refreshUntil, refreshOwner",
              ConditionExpression: "refreshOwner = :owner",
              ExpressionAttributeValues: { ":owner": refreshOwner },
            }),
          );
        } catch (error) {
          if (!conditionConflict(error)) throw error;
        }
      }
    },
  });
  return client;
}

type MediaCleanupCredential = {
  purpose: "WHEP_DELETE";
  accessToken: string;
  hardwareId: string;
  expiresAt: number;
  mediaSessionId: string;
  deviceId: string;
};
/** Access-only cleanup material; never copy a refresh token into a media record. */
export async function createMediaCleanupCredentials(
  householdId: string,
  mediaSessionId: string,
  deviceId: string,
  providerExpiresAt: number,
  hardwareId: string,
): Promise<{
  cleanupCredentials: CredentialEnvelope;
  cleanupExpiresAt: number;
  cleanupSource: "PLAYGROUND" | "LIVE";
}> {
  validateRingHardwareId(hardwareId);
  const now = Date.now();
  if (
    !mediaSessionId ||
    !deviceId ||
    !Number.isFinite(providerExpiresAt) ||
    providerExpiresAt <= now ||
    providerExpiresAt > now + 60_000
  )
    throw new AppError(
      "RING_CLEANUP_SCOPE_INVALID",
      500,
      "Media cleanup scope is invalid.",
    );
  const mode = process.env.RING_MODE;
  let accessToken: string,
    tokenExpiresAt = providerExpiresAt;
  if (mode === "playground") {
    accessToken = process.env.RING_PLAYGROUND_TOKEN ?? "";
  } else if (mode === "live") {
    const integration = await getItem(
      tables.config,
      `HOUSEHOLD#${householdId}`,
      "INTEGRATION#ring",
    );
    if (
      !integration?.credentials ||
      integration.revoked ||
      integration.status !== "LINKED"
    )
      throw new AppError(
        "RING_ACCESS_CHANGED",
        409,
        "Ring access changed before media cleanup could be secured.",
      );
    if (
      validateRingClientIdentity(integration.clientIdentity).hardwareId !==
      hardwareId
    )
      throw new AppError(
        "RING_ACCESS_CHANGED",
        409,
        "Ring client identity changed before cleanup authorization.",
      );
    const tokens = await decryptRingCredentials<
      RingTokens & Record<string, unknown>
    >(integration.credentials as CredentialEnvelope, {
      householdId,
      integrationId: "ring",
    });
    accessToken = tokens.accessToken;
    tokenExpiresAt = tokens.expiresAt;
  } else
    throw new AppError(
      "RING_LOCAL_MODE",
      409,
      "Local simulation has no Ring cleanup credentials.",
    );
  if (
    !accessToken ||
    /[\r\n]/.test(accessToken) ||
    !Number.isFinite(tokenExpiresAt) ||
    tokenExpiresAt <= now
  )
    throw new AppError(
      "RING_CLEANUP_EXPIRED",
      409,
      "Ring cleanup credentials are unavailable or expired.",
    );
  const cleanupExpiresAt = Math.min(
    providerExpiresAt,
    tokenExpiresAt,
    now + 60_000,
  );
  const value: MediaCleanupCredential = {
    purpose: "WHEP_DELETE",
    hardwareId,
    accessToken,
    expiresAt: cleanupExpiresAt,
    mediaSessionId,
    deviceId,
  };
  const cleanupCredentials = await encryptRingCredentials(value, {
    householdId,
    integrationId: "ring",
  });
  return {
    cleanupCredentials,
    cleanupExpiresAt,
    cleanupSource: mode === "playground" ? "PLAYGROUND" : "LIVE",
  };
}

export async function closePersistedMedia(
  householdId: string,
  mediaSessionId: string,
) {
  const key = { PK: `MEDIA#${householdId}#${mediaSessionId}`, SK: "SESSION" },
    row = await getItem(tables.runtime, key.PK, key.SK);
  if (!row)
    return { closed: true, alreadyAbsent: true, providerCloseConfirmed: false };
  if (row.householdId !== householdId || row.mediaSessionId !== mediaSessionId)
    throw new AppError(
      "RING_CLEANUP_SCOPE_INVALID",
      403,
      "Media cleanup scope does not match.",
    );
  const providerExpiresAt = row.providerExpiresAt ?? row.expiresAt * 1000;
  let providerCloseConfirmed = false;
  if (providerExpiresAt > Date.now()) {
    if (
      !row.cleanupCredentials ||
      !row.cleanupExpiresAt ||
      row.cleanupExpiresAt <= Date.now()
    )
      throw new AppError(
        "RING_CLEANUP_EXPIRED",
        409,
        "Media cleanup authorization expired. Provider session expiry remains bounded.",
      );
    const credentials = await decryptRingCredentials<
      MediaCleanupCredential & Record<string, unknown>
    >(row.cleanupCredentials as CredentialEnvelope, {
      householdId,
      integrationId: "ring",
    });
    if (
      credentials.purpose !== "WHEP_DELETE" ||
      credentials.mediaSessionId !== mediaSessionId ||
      credentials.deviceId !== row.deviceId ||
      typeof credentials.accessToken !== "string" ||
      credentials.expiresAt !== row.cleanupExpiresAt ||
      credentials.expiresAt <= Date.now() ||
      credentials.expiresAt > providerExpiresAt
    )
      throw new AppError(
        "RING_CLEANUP_SCOPE_INVALID",
        403,
        "Media cleanup authorization is invalid or expired.",
      );
    // This client has no refresh/client credentials and is used only for the stored DELETE.
    const client = new RingClient({
      mode: row.cleanupSource === "PLAYGROUND" ? "playground" : "live",
      accessToken: credentials.accessToken,
      hardwareId: credentials.hardwareId,
    });
    await client.closeWhepSession({
      deviceId: row.deviceId,
      location: row.location,
    });
    providerCloseConfirmed = true;
  }
  await db.send(new DeleteCommand({ TableName: tables.runtime, Key: key }));
  return {
    closed: true,
    providerCloseConfirmed,
    providerExpiryElapsed: !providerCloseConfirmed,
  };
}
