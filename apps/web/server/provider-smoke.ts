import {
  service,
  tables,
  databaseConfig,
  getItem,
  queryPK,
} from "@captiondoor/db";
import {
  AppError,
  assertProviderSmokeEnvironment,
  type Actor,
} from "@captiondoor/domain";
import { origin } from "./http";

/** Check both explicit environment and the already-created database client's captured scope. */
export function assertProviderSmokeRuntime() {
  const config = assertProviderSmokeEnvironment(process.env);
  if (
    tables.config !== process.env.CAPTIONDOOR_CONFIG_TABLE ||
    tables.visits !== process.env.CAPTIONDOOR_VISITS_TABLE ||
    tables.runtime !== process.env.CAPTIONDOOR_RUNTIME_TABLE ||
    origin !== process.env.APP_ORIGIN
  )
    throw new AppError(
      "PROVIDER_SMOKE_DISABLED",
      403,
      "The running client does not match the explicitly selected smoke scope.",
    );
  assertProviderSmokeEnvironment({
    ...process.env,
    CAPTIONDOOR_DB_MODE: databaseConfig.mode,
    CAPTIONDOOR_ENV: databaseConfig.environment,
    CAPTIONDOOR_CONFIG_TABLE: tables.config,
    CAPTIONDOOR_VISITS_TABLE: tables.visits,
    CAPTIONDOOR_RUNTIME_TABLE: tables.runtime,
    APP_ORIGIN: origin,
  });
  return config;
}

export function providerSmokeRuntimeStatus(): {
  providerSmoke: boolean;
  providerSmokeTablePrefix?: string;
} {
  try {
    const { tablePrefix } = assertProviderSmokeRuntime();
    return { providerSmoke: true, providerSmokeTablePrefix: tablePrefix };
  } catch {
    return { providerSmoke: false };
  }
}
export function providerSmokeRuntimeEnabled(): boolean {
  return providerSmokeRuntimeStatus().providerSmoke;
}

/** Local event feeder only: no provider request, credential use, or fabricated Ring delivery. */
export async function pressProviderSmoke(
  inputActor: Actor,
  eventId: string,
  requestKey: string,
) {
  assertProviderSmokeRuntime();
  const actor = await service.refreshActor(inputActor, "membership");
  if (actor.kind !== "resident")
    throw new AppError("FORBIDDEN", 403, "Resident owner access is required.");
  const pk = `HOUSEHOLD#${actor.householdId}`;
  const [membership, profile, selected] = await Promise.all([
    getItem(tables.config, pk, `MEMBER#${actor.userId}`),
    getItem(tables.config, pk, "PROFILE"),
    queryPK(tables.config, pk, { prefix: "DOOR#", limit: 2 }),
  ]);
  if (
    !membership ||
    membership.role !== "owner" ||
    membership.revoked ||
    membership.expiresAt <= Math.floor(Date.now() / 1000) ||
    membership.grants?.membership !== true
  )
    throw new AppError(
      "FORBIDDEN",
      403,
      "Only the current household owner can create a local smoke event.",
    );
  if (profile?.settings?.consent?.ring !== true)
    throw new AppError(
      "CONSENT_REQUIRED",
      403,
      "Approve Ring media consent before the local smoke event.",
    );
  const door = selected.items[0];
  if (
    selected.cursor ||
    selected.items.length !== 1 ||
    !door ||
    door.revoked ||
    door.householdId !== actor.householdId ||
    typeof door.id !== "string" ||
    typeof door.ringAccountId !== "string" ||
    typeof door.ringDeviceId !== "string" ||
    !door.ringAccountId ||
    !door.ringDeviceId
  )
    throw new AppError(
      "RING_SELECTION_REQUIRED",
      409,
      "Select one authorized Playground door before a local smoke event.",
    );
  const mapping = await getItem(
    tables.config,
    `RINGACCOUNT#${door.ringAccountId}`,
    "LOOKUP",
  );
  if (
    !mapping ||
    mapping.revoked ||
    mapping.householdId !== actor.householdId ||
    mapping.doorId !== door.id ||
    mapping.deviceId !== door.ringDeviceId
  )
    throw new AppError(
      "RING_SELECTION_REQUIRED",
      409,
      "The selected Playground account and door no longer match this household.",
    );
  const result = await service.press({
    accountId: door.ringAccountId,
    deviceId: door.ringDeviceId,
    eventId: `provider-smoke:${eventId}`,
    deliveryId: `provider-smoke:${actor.sessionId}:${requestKey}`,
    source: "LOCAL",
    localActor: actor,
  });
  return {
    ...result,
    localSimulation: true as const,
    eventSource: "LOCAL" as const,
  };
}
