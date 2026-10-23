import { randomUUID } from "node:crypto";
import {
  db,
  tables,
  getItem,
  hashToken,
  conditionConflict,
  PutCommand,
} from "@captiondoor/db";
import { AppError } from "@captiondoor/domain";
import { validateRingHardwareId } from "./ring";

/** Backend device means this configured server integration origin, not a resident browser or Ring camera. */
export type RingClientIdentity = {
  hardwareId: string;
  residentId: string;
  backendOrigin: string;
};
function scope(householdId: string, residentId: string, backendOrigin: string) {
  let url: URL;
  try {
    url = new URL(backendOrigin);
  } catch {
    throw new AppError(
      "RING_CLIENT_SCOPE_INVALID",
      503,
      "Configure the Ring backend client origin first.",
    );
  }
  if (
    !householdId ||
    !residentId ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new AppError(
      "RING_CLIENT_SCOPE_INVALID",
      503,
      "Ring client scope is invalid.",
    );
  return {
    key: {
      PK: `HOUSEHOLD#${householdId}`,
      SK: `RING_CLIENT#${hashToken(residentId)}#${hashToken(url.origin)}`,
    },
    residentId,
    backendOrigin: url.origin,
  };
}
export function validateRingClientIdentity(value: unknown): RingClientIdentity {
  const identity = value as Partial<RingClientIdentity> | undefined;
  if (
    !identity ||
    typeof identity.residentId !== "string" ||
    !identity.residentId ||
    typeof identity.backendOrigin !== "string"
  )
    throw new AppError(
      "RING_CLIENT_IDENTITY_REQUIRED",
      503,
      "The linked Ring client identity is unavailable. Re-linking may be required.",
    );
  const canonical = scope(
    "validation",
    identity.residentId,
    identity.backendOrigin,
  );
  if (canonical.backendOrigin !== identity.backendOrigin)
    throw new AppError(
      "RING_CLIENT_SCOPE_INVALID",
      503,
      "Ring client origin is invalid.",
    );
  return {
    hardwareId: validateRingHardwareId(identity.hardwareId),
    residentId: identity.residentId,
    backendOrigin: identity.backendOrigin,
  };
}
export async function loadRingClientIdentity(
  householdId: string,
  residentId: string,
  backendOrigin: string,
): Promise<RingClientIdentity> {
  const requested = scope(householdId, residentId, backendOrigin);
  const row = await getItem(tables.config, requested.key.PK, requested.key.SK);
  const identity = validateRingClientIdentity(row?.clientIdentity);
  if (
    identity.residentId !== requested.residentId ||
    identity.backendOrigin !== requested.backendOrigin
  )
    throw new AppError(
      "RING_CLIENT_SCOPE_INVALID",
      503,
      "Ring client identity does not match its stored scope.",
    );
  return identity;
}
/** Trusted resident/server inputs only. Conditional creation and a strong winner read converge across processes. */
export async function getOrCreateRingClientIdentity(
  householdId: string,
  residentId: string,
  backendOrigin: string,
): Promise<RingClientIdentity> {
  const requested = scope(householdId, residentId, backendOrigin);
  const existing = await getItem(
    tables.config,
    requested.key.PK,
    requested.key.SK,
  );
  if (!existing) {
    try {
      await db.send(
        new PutCommand({
          TableName: tables.config,
          Item: {
            ...requested.key,
            clientIdentity: {
              hardwareId: randomUUID(),
              residentId: requested.residentId,
              backendOrigin: requested.backendOrigin,
            },
            createdAt: Date.now(),
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (error) {
      if (!conditionConflict(error)) throw error;
    }
  }
  return loadRingClientIdentity(householdId, residentId, backendOrigin);
}
