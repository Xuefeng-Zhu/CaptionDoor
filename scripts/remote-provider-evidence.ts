import { assertRemoteProviderSmokeEnvironment } from "@captiondoor/domain";
import type {
  SmokeEnvironment,
  RootSmokeBudgetEvidence,
  RootSmokeReceiptEvidence,
} from "./provider-smoke-config";

/** Authenticated AWS budget metadata only; never actual billing or proof of paid transport. */
export function remoteProviderBudgetEvidence(
  summary: unknown,
  env: SmokeEnvironment,
  requireCapacity: boolean,
): RootSmokeBudgetEvidence {
  const c = assertRemoteProviderSmokeEnvironment(env),
    v = summary as Record<string, unknown> | null;
  if (
    !v ||
    v.scope !== c.scope ||
    v.accountId !== c.accountId ||
    v.region !== c.region ||
    v.tablePrefix !== c.tablePrefix ||
    v.previousSeconds !== c.previousSeconds ||
    v.previousMicrousd !== c.previousMicrousd ||
    v.baselineSha256 !== c.baselineSha256 ||
    v.maxAttemptSeconds !== 30 ||
    v.maxSeconds !== 90 ||
    v.maxMicrousd !== c.maxMicrousd ||
    v.microusdPerSecond !== c.microusdPerSecond ||
    v.conservativeReservation !== true
  )
    throw new Error("REMOTE_PROVIDER_BUDGET_INVALID");
  const reserved = v.reservedSeconds,
    cost = v.cumulativeEstimatedMicrousd,
    attempts = v.attempts;
  if (
    typeof attempts !== "number" ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    typeof reserved !== "number" ||
    reserved !== c.previousSeconds + attempts * 30 ||
    reserved > 90 ||
    typeof cost !== "number" ||
    cost !== c.previousMicrousd + attempts * 30 * 400 ||
    v.reservedMicrousd !== cost ||
    cost > c.maxMicrousd ||
    v.remainingSeconds !== 90 - reserved ||
    v.remainingMicrousd !== c.maxMicrousd - cost
  )
    throw new Error("REMOTE_PROVIDER_BUDGET_INVALID");
  if (
    requireCapacity &&
    (90 - reserved < 30 || c.maxMicrousd - cost < 30 * 400)
  )
    throw new Error("REMOTE_PROVIDER_BUDGET_EXHAUSTED");
  return {
    scope: c.scope,
    maxAttemptSeconds: 30,
    maxSeconds: 90,
    maxMicrousd: c.maxMicrousd,
    reservedSeconds: reserved,
    cumulativeEstimatedMicrousd: cost,
    remainingSeconds: 90 - reserved,
    remainingEstimatedMicrousd: c.maxMicrousd - cost,
    attempts,
  };
}

/** Only own-visit capture-ready from the authenticated worker can establish this receipt. */
export function remoteProviderReceiptEvidence(
  receipt: unknown,
  before: RootSmokeBudgetEvidence,
  env: SmokeEnvironment,
  now = Date.now(),
): RootSmokeReceiptEvidence {
  const c = assertRemoteProviderSmokeEnvironment(env),
    v = receipt as Record<string, unknown> | null;
  const cumulative = before.reservedSeconds + 30;
  if (
    before.scope !== c.scope ||
    before.maxAttemptSeconds !== 30 ||
    before.maxSeconds !== 90 ||
    before.maxMicrousd !== c.maxMicrousd ||
    cumulative > 90 ||
    !v ||
    v.scope !== c.scope ||
    v.previousSeconds !== c.previousSeconds ||
    v.previousMicrousd !== c.previousMicrousd ||
    v.baselineSha256 !== c.baselineSha256 ||
    typeof v.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v.attemptId,
    ) ||
    !(v.identity === "NON_ROOT" || (c.allowRoot && v.identity === "ROOT")) ||
    v.maxSeconds !== 30 ||
    typeof v.expiresAt !== "number" ||
    !Number.isSafeInteger(v.expiresAt) ||
    v.expiresAt <= now ||
    v.expiresAt > now + 30_000 ||
    v.cumulativeReservedSeconds !== cumulative ||
    v.cumulativeEstimatedMicrousd !== cumulative * 400
  )
    throw new Error("REMOTE_PROVIDER_RECEIPT_INVALID");
  return {
    identity: v.identity as "ROOT" | "NON_ROOT",
    expiresAt: v.expiresAt,
    maxSeconds: 30,
    cumulativeReservedSeconds: cumulative,
    cumulativeEstimatedMicrousd: cumulative * 400,
  };
}
