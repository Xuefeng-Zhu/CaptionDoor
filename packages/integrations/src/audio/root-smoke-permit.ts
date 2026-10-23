import { AppError, assertRootSmokeEnvironment } from "@captiondoor/domain";
import { assertLocalRootScopeAvailable } from "../../../db/src/local-root-retirement";

type Env = Record<string, string | undefined>;
export type RootSmokeReservation = {
  attemptId: string;
  scope: string;
  accountId: string;
  region: string;
  householdId: string;
  issuedAt: number;
  expiresAt: number;
  maxSeconds: number;
  reservedSeconds: number;
  cumulativeReservedSeconds: number;
  cumulativeEstimatedMicrousd: number;
  tablePrefix: string;
};
const brand: unique symbol = Symbol("worker-issued-root-smoke-permit");
export type RootSmokePermit = Readonly<RootSmokeReservation> & {
  readonly [brand]: true;
};
const issued = new WeakMap<
  RootSmokePermit,
  { armed: boolean; identity?: "ROOT" | "NON_ROOT" }
>();
function denied(): never {
  throw new AppError(
    "ROOT_SMOKE_PERMIT_INVALID",
    403,
    "The one-off local transcription test permit is unavailable or expired.",
  );
}
function validate(permit: RootSmokeReservation, env: Env, now: number) {
  const config = assertRootSmokeEnvironment(env);
  assertLocalRootScopeAvailable();
  if (
    permit.scope !== config.scope ||
    permit.accountId !== config.accountId ||
    permit.region !== config.region ||
    permit.tablePrefix !== config.tablePrefix ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      permit.attemptId,
    ) ||
    !permit.householdId ||
    !Number.isSafeInteger(permit.issuedAt) ||
    !Number.isSafeInteger(permit.expiresAt) ||
    permit.issuedAt > now ||
    permit.expiresAt <= now ||
    permit.expiresAt > permit.issuedAt + 30_000 ||
    permit.maxSeconds !== 30 ||
    permit.reservedSeconds !== 30 ||
    !Number.isSafeInteger(permit.cumulativeReservedSeconds) ||
    permit.cumulativeReservedSeconds < 30 ||
    permit.cumulativeReservedSeconds > 90 ||
    permit.cumulativeReservedSeconds % 30 !== 0 ||
    permit.cumulativeEstimatedMicrousd !==
      permit.cumulativeReservedSeconds * 400
  )
    denied();
}
/** Trusted worker only: call after the real Local transaction has reserved the attempt. */
export function issueRootSmokePermit(
  reservation: RootSmokeReservation,
  env: Env = process.env,
): RootSmokePermit {
  validate(reservation, env, Date.now());
  const permit = Object.freeze({
    attemptId: reservation.attemptId,
    scope: reservation.scope,
    accountId: reservation.accountId,
    region: reservation.region,
    householdId: reservation.householdId,
    issuedAt: reservation.issuedAt,
    expiresAt: reservation.expiresAt,
    maxSeconds: reservation.maxSeconds,
    reservedSeconds: reservation.reservedSeconds,
    cumulativeReservedSeconds: reservation.cumulativeReservedSeconds,
    cumulativeEstimatedMicrousd: reservation.cumulativeEstimatedMicrousd,
    tablePrefix: reservation.tablePrefix,
    [brand]: true as const,
  });
  issued.set(permit, { armed: false });
  return permit;
}
export function assertRootSmokePermit(
  permit: RootSmokePermit,
  config: { accountId: string; region: string },
  env: Env = process.env,
): void {
  if (!issued.has(permit)) denied();
  validate(permit, env, Date.now());
  if (permit.accountId !== config.accountId || permit.region !== config.region)
    denied();
}
/** One server-side timer per reserved attempt; cannot be reused for a second stream. */
export function armRootSmokeDeadline(
  permit: RootSmokePermit,
  onLimit: () => void,
  env: Env = process.env,
): () => void {
  assertRootSmokePermit(permit, permit, env);
  const state = issued.get(permit)!;
  if (state.armed) denied();
  state.armed = true;
  const timer = setTimeout(onLimit, Math.max(1, permit.expiresAt - Date.now()));
  return () => clearTimeout(timer);
}
export function recordRootSmokeIdentity(
  permit: RootSmokePermit,
  identity: "ROOT" | "NON_ROOT",
): void {
  assertLocalRootScopeAvailable();
  const state = issued.get(permit);
  if (!state?.armed) denied();
  state.identity = identity;
}
export function rootSmokeReceipt(permit: RootSmokePermit) {
  assertLocalRootScopeAvailable();
  const state = issued.get(permit);
  if (!state?.armed || !state.identity) denied();
  return {
    attemptId: permit.attemptId,
    scope: permit.scope,
    maxSeconds: permit.maxSeconds,
    expiresAt: permit.expiresAt,
    cumulativeReservedSeconds: permit.cumulativeReservedSeconds,
    cumulativeEstimatedMicrousd: permit.cumulativeEstimatedMicrousd,
    identity: state.identity,
  };
}
