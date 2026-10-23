import { AppError, type RemoteProviderSmokeConfig } from "@captiondoor/domain";

/** Pure validation only; the repository persists and conditionally advances this ledger. */
export function validateRemoteProviderSmokeLedger(
  row: Record<string, unknown> | undefined,
  householdId: string,
  config: RemoteProviderSmokeConfig,
) {
  if (!row)
    return {
      attempts: 0,
      reservedSeconds: config.previousSeconds,
      reservedMicrousd: config.previousMicrousd,
      version: 0,
    };
  if (row.householdId !== householdId)
    throw new AppError(
      "REMOTE_PROVIDER_SMOKE_SCOPE_MISMATCH",
      403,
      "This remote provider smoke budget belongs to a different household.",
    );
  const attempts = row.attempts as number;
  const reservedSeconds =
    config.previousSeconds + attempts * config.maxAttemptSeconds;
  const reservedMicrousd =
    config.previousMicrousd +
    attempts * config.maxAttemptSeconds * config.microusdPerSecond;
  if (
    row.PK !== `PROVIDER_SMOKE#${config.scope}` ||
    row.SK !== "BUDGET" ||
    row.kind !== "REMOTE_PROVIDER_SMOKE_BUDGET" ||
    row.scope !== config.scope ||
    row.accountId !== config.accountId ||
    row.region !== config.region ||
    row.tablePrefix !== config.tablePrefix ||
    row.previousSeconds !== config.previousSeconds ||
    row.previousMicrousd !== config.previousMicrousd ||
    row.baselineSha256 !== config.baselineSha256 ||
    row.maxAttemptSeconds !== config.maxAttemptSeconds ||
    row.maxSeconds !== config.maxSeconds ||
    row.maxMicrousd !== config.maxMicrousd ||
    row.microusdPerSecond !== config.microusdPerSecond ||
    "expiresAt" in row ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    row.version !== attempts ||
    row.reservedSeconds !== reservedSeconds ||
    reservedSeconds > config.maxSeconds ||
    row.reservedMicrousd !== reservedMicrousd ||
    reservedMicrousd > config.maxMicrousd ||
    !Number.isSafeInteger(row.createdAt) ||
    (row.createdAt as number) <= 0 ||
    !Number.isSafeInteger(row.updatedAt) ||
    (row.updatedAt as number) < (row.createdAt as number)
  )
    throw new AppError(
      "REMOTE_PROVIDER_SMOKE_LEDGER_INVALID",
      503,
      "The remote provider reservation ledger is invalid. No paid attempt is permitted.",
    );
  return {
    attempts,
    reservedSeconds,
    reservedMicrousd,
    version: attempts,
  };
}
