import {
  AppError,
  assertRootSmokeEnvironment,
  type Actor,
  type RootSmokeConfig,
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

export type RootSmokeReservation = {
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
export type RootSmokeBudget = {
  scope: string;
  accountId: string;
  region: string;
  tablePrefix: string;
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
function runtimePolicy(): RootSmokeConfig {
  const config = assertRootSmokeEnvironment(process.env);
  if (
    databaseConfig.mode !== "local" ||
    databaseConfig.environment !== "local" ||
    databaseConfig.endpoint !==
      new URL(process.env.DYNAMODB_ENDPOINT!).toString() ||
    tables.config !== `${config.tablePrefix}Config` ||
    tables.visits !== `${config.tablePrefix}Visits` ||
    tables.runtime !== `${config.tablePrefix}Runtime`
  )
    throw new AppError(
      "ROOT_SMOKE_DISABLED",
      403,
      "Root smoke storage must use the captured isolated Local configuration.",
    );
  return config;
}
function key(config: RootSmokeConfig) {
  return { PK: `PROVIDER_SMOKE#${config.scope}`, SK: "BUDGET" };
}
function invalid(): never {
  throw new AppError(
    "ROOT_SMOKE_LEDGER_INVALID",
    503,
    "The root smoke reservation ledger is invalid. No paid attempt is permitted.",
  );
}
function counters(
  row: Row | undefined,
  householdId: string,
  config: RootSmokeConfig,
) {
  if (!row)
    return { attempts: 0, reservedSeconds: 0, reservedMicrousd: 0, version: 0 };
  if (row.householdId !== householdId)
    throw new AppError(
      "ROOT_SMOKE_SCOPE_MISMATCH",
      403,
      "This root smoke budget belongs to a different household.",
    );
  if (
    row.PK !== key(config).PK ||
    row.SK !== "BUDGET" ||
    row.kind !== "ROOT_SMOKE_BUDGET" ||
    row.scope !== config.scope ||
    row.accountId !== config.accountId ||
    row.region !== config.region ||
    row.tablePrefix !== config.tablePrefix ||
    row.maxAttemptSeconds !== config.maxAttemptSeconds ||
    row.maxSeconds !== config.maxSeconds ||
    row.maxMicrousd !== config.maxMicrousd ||
    row.microusdPerSecond !== config.microusdPerSecond ||
    "expiresAt" in row ||
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 0 ||
    row.attempts > config.maxSeconds / config.maxAttemptSeconds ||
    row.version !== row.attempts ||
    row.reservedSeconds !== row.attempts * config.maxAttemptSeconds ||
    row.reservedMicrousd !== row.reservedSeconds * config.microusdPerSecond ||
    row.reservedMicrousd > config.maxMicrousd ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt <= 0 ||
    !Number.isSafeInteger(row.updatedAt) ||
    row.updatedAt < row.createdAt
  )
    invalid();
  return {
    attempts: row.attempts as number,
    reservedSeconds: row.reservedSeconds as number,
    reservedMicrousd: row.reservedMicrousd as number,
    version: row.version as number,
  };
}
export async function getRootSmokeBudget(
  actor: Actor,
): Promise<RootSmokeBudget> {
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
export async function reserveRootSmokeAttempt(
  actor: Actor,
  visitId: string,
  fence: { leaseId: string; mediaSessionId: string },
): Promise<RootSmokeReservation> {
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
        "Capture authorization ended before root smoke reservation.",
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
        "ROOT_SMOKE_BUDGET_EXHAUSTED",
        409,
        "The approved root smoke reservation limit is exhausted.",
      );
    const receipt: RootSmokeReservation = {
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
      kind: "ROOT_SMOKE_BUDGET",
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
              ? "#version = :version AND householdId = :household AND reservedSeconds = :seconds AND reservedMicrousd = :cost AND attempts = :attempts"
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
              kind: "ROOT_SMOKE_ATTEMPT",
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
    "ROOT_SMOKE_RESERVATION_BUSY",
    409,
    "Root smoke reservation changed. Recheck authorization and remaining budget.",
  );
}
export const rootSmokeService = { reserveRootSmokeAttempt, getRootSmokeBudget };
