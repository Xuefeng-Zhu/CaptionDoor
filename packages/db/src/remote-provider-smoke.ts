import {
  AppError,
  assertRemoteProviderSmokeEnvironment,
  type Actor,
  type RemoteProviderSmokeConfig,
} from "@captiondoor/domain";
import {
  databaseConfig,
  tables,
  getItem,
  transact,
  conditionConflict,
  now,
  seconds,
  id,
  householdPK,
  visitPK,
  type Row,
} from "./repository";
import { resident, authConditions } from "./auth";
import { authorizeCapture } from "./capture";
import { validateRemoteProviderSmokeLedger } from "./remote-provider-budget-policy";

export type RemoteProviderSmokeReservation = {
  previousSeconds: number;
  previousMicrousd: number;
  baselineSha256: string;
  attemptId: string;
  scope: string;
  accountId: string;
  region: string;
  householdId: string;
  issuedAt: number;
  expiresAt: number;
  maxSeconds: 30;
  reservedSeconds: 30;
  cumulativeReservedSeconds: number;
  cumulativeEstimatedMicrousd: number;
  tablePrefix: string;
};
export type RemoteProviderSmokeBudget = {
  scope: string;
  accountId: string;
  region: string;
  tablePrefix: string;
  previousSeconds: number;
  previousMicrousd: number;
  baselineSha256: string;
  householdId?: string;
  maxAttemptSeconds: 30;
  maxSeconds: 90;
  maxMicrousd: number;
  microusdPerSecond: number;
  reservedSeconds: number;
  reservedMicrousd: number;
  cumulativeEstimatedMicrousd: number;
  attempts: number;
  remainingSeconds: number;
  remainingMicrousd: number;
  conservativeReservation: true;
};
function runtimePolicy(): RemoteProviderSmokeConfig {
  const config = assertRemoteProviderSmokeEnvironment(process.env);
  if (
    databaseConfig.mode !== "aws" ||
    databaseConfig.environment !== "remote-provider" ||
    databaseConfig.region !== config.region ||
    databaseConfig.accountId !== config.accountId ||
    !!databaseConfig.endpoint ||
    tables.config !== `${config.tablePrefix}Config` ||
    tables.visits !== `${config.tablePrefix}Visits` ||
    tables.runtime !== `${config.tablePrefix}Runtime`
  )
    throw new AppError(
      "REMOTE_PROVIDER_SMOKE_DISABLED",
      403,
      "Remote provider smoke storage must use the captured isolated AWS configuration.",
    );
  return config;
}
function key(config: RemoteProviderSmokeConfig) {
  return { PK: `PROVIDER_SMOKE#${config.scope}`, SK: "BUDGET" };
}
function counters(
  row: Row | undefined,
  householdId: string,
  config: RemoteProviderSmokeConfig,
) {
  return validateRemoteProviderSmokeLedger(row, householdId, config);
}
export async function getRemoteProviderSmokeBudget(
  actor: Actor,
): Promise<RemoteProviderSmokeBudget> {
  const config = runtimePolicy();
  actor = await resident(actor, "captions");
  const ledgerKey = key(config),
    row = await getItem(tables.runtime, ledgerKey.PK, ledgerKey.SK);
  const value = counters(row, actor.householdId, config);
  return {
    ...config,
    householdId: row ? actor.householdId : undefined,
    reservedSeconds: value.reservedSeconds,
    reservedMicrousd: value.reservedMicrousd,
    cumulativeEstimatedMicrousd: value.reservedMicrousd,
    attempts: value.attempts,
    remainingSeconds: config.maxSeconds - value.reservedSeconds,
    remainingMicrousd: config.maxMicrousd - value.reservedMicrousd,
    conservativeReservation: true,
  };
}
/** Reserve conservatively before identity/paid transport. No refund or TTL resets this scope. */
export async function reserveRemoteProviderSmokeAttempt(
  actor: Actor,
  visitId: string,
  fence: { leaseId: string; mediaSessionId: string },
): Promise<RemoteProviderSmokeReservation> {
  const config = runtimePolicy(),
    attemptId = id();
  for (let attempt = 0; attempt < 5; attempt++) {
    actor = await resident(actor, "captions");
    const visit = await authorizeCapture(actor, visitId, fence),
      pk = visitPK(actor.householdId, visitId);
    const lease = await getItem(tables.runtime, pk, "CAPTURE");
    if (
      !lease ||
      lease.id !== fence.leaseId ||
      lease.holderId !== actor.userId ||
      lease.mediaSessionId !== fence.mediaSessionId ||
      lease.expiresAt <= seconds()
    )
      throw new AppError(
        "LEASE_LOST",
        409,
        "Capture authorization ended before remote provider smoke reservation.",
      );
    const issuedAt = now(),
      expiresAt = Math.min(
        issuedAt + config.maxAttemptSeconds * 1000,
        visit.mediaExpiresAt!,
        lease.expiresAt * 1000,
        actor.expiresAt * 1000,
      );
    if (expiresAt <= issuedAt)
      throw new AppError("LEASE_LOST", 409, "Capture authorization expired.");
    const ledgerKey = key(config),
      row = await getItem(tables.runtime, ledgerKey.PK, ledgerKey.SK);
    const before = counters(row, actor.householdId, config);
    const reservedSeconds = before.reservedSeconds + config.maxAttemptSeconds,
      reservedMicrousd = reservedSeconds * config.microusdPerSecond;
    if (
      reservedSeconds > config.maxSeconds ||
      reservedMicrousd > config.maxMicrousd
    )
      throw new AppError(
        "REMOTE_PROVIDER_SMOKE_BUDGET_EXHAUSTED",
        409,
        "The approved remote provider smoke reservation limit is exhausted.",
      );
    const receipt: RemoteProviderSmokeReservation = {
      previousSeconds: config.previousSeconds,
      previousMicrousd: config.previousMicrousd,
      baselineSha256: config.baselineSha256,
      attemptId,
      scope: config.scope,
      accountId: config.accountId,
      region: config.region,
      householdId: actor.householdId,
      issuedAt,
      expiresAt,
      maxSeconds: 30,
      reservedSeconds: 30,
      cumulativeReservedSeconds: reservedSeconds,
      cumulativeEstimatedMicrousd: reservedMicrousd,
      tablePrefix: config.tablePrefix,
    };
    const ledger = {
      ...ledgerKey,
      kind: "REMOTE_PROVIDER_SMOKE_BUDGET",
      ...config,
      householdId: actor.householdId,
      attempts: before.attempts + 1,
      version: before.version + 1,
      reservedSeconds,
      reservedMicrousd,
      createdAt: row?.createdAt ?? issuedAt,
      updatedAt: issuedAt,
    };
    const checks = authConditions(actor, "captions");
    checks[1].ConditionCheck.ConditionExpression += " AND grants.camera = :yes";
    try {
      await transact([
        {
          Put: {
            TableName: tables.runtime,
            Item: ledger,
            ConditionExpression: row
              ? "#version = :version AND householdId = :household AND reservedSeconds = :seconds AND reservedMicrousd = :cost AND attempts = :attempts AND previousSeconds = :previousSeconds AND previousMicrousd = :previousMicrousd AND baselineSha256 = :baselineSha256"
              : "attribute_not_exists(PK)",
            ...(row
              ? {
                  ExpressionAttributeNames: { "#version": "version" },
                  ExpressionAttributeValues: {
                    ":version": before.version,
                    ":household": actor.householdId,
                    ":seconds": before.reservedSeconds,
                    ":cost": before.reservedMicrousd,
                    ":attempts": before.attempts,
                    ":previousSeconds": config.previousSeconds,
                    ":previousMicrousd": config.previousMicrousd,
                    ":baselineSha256": config.baselineSha256,
                  },
                }
              : {}),
          },
        },
        {
          Put: {
            TableName: tables.runtime,
            Item: {
              PK: ledgerKey.PK,
              SK: `ATTEMPT#${attemptId}`,
              kind: "REMOTE_PROVIDER_SMOKE_ATTEMPT",
              ...Object.fromEntries(
                Object.entries(receipt).filter(
                  ([name]) => name !== "expiresAt",
                ),
              ),
              deadlineAt: receipt.expiresAt,
              visitId,
              conservativeReservation: true,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...checks,
        {
          ConditionCheck: {
            TableName: tables.config,
            Key: { PK: householdPK(actor.householdId), SK: "PROFILE" },
            ConditionExpression:
              "settings.consent.ring = :yes AND settings.consent.transcription = :yes",
            ExpressionAttributeValues: { ":yes": true },
          },
        },
        {
          ConditionCheck: {
            TableName: tables.visits,
            Key: { PK: pk, SK: "STATE" },
            ConditionExpression:
              "#version = :version AND #status = :claimed AND handlerId = :user AND mediaSessionId = :media AND mediaStatus = :live AND mediaExpiresAt > :now AND expiresAt > :sec AND (attribute_not_exists(deleted) OR deleted = :no)",
            ExpressionAttributeNames: {
              "#version": "version",
              "#status": "status",
            },
            ExpressionAttributeValues: {
              ":version": visit.version,
              ":claimed": "CLAIMED",
              ":user": actor.userId,
              ":media": fence.mediaSessionId,
              ":live": "LIVE",
              ":now": issuedAt,
              ":sec": seconds(),
              ":no": false,
            },
          },
        },
        {
          ConditionCheck: {
            TableName: tables.runtime,
            Key: { PK: pk, SK: "CAPTURE" },
            ConditionExpression:
              "id = :lease AND holderId = :user AND mediaSessionId = :media AND expiresAt > :sec",
            ExpressionAttributeValues: {
              ":lease": fence.leaseId,
              ":user": actor.userId,
              ":media": fence.mediaSessionId,
              ":sec": seconds(),
            },
          },
        },
      ]);
      return receipt;
    } catch (error) {
      if (!conditionConflict(error)) throw error;
    }
  }
  throw new AppError(
    "REMOTE_PROVIDER_SMOKE_RESERVATION_BUSY",
    409,
    "Remote provider smoke reservation changed. Recheck authorization and remaining budget.",
  );
}
export const remoteProviderSmokeService = {
  reserveRemoteProviderSmokeAttempt,
  getRemoteProviderSmokeBudget,
};
