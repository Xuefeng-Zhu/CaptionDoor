import {
  AppError,
  assertRemoteProviderSmokeEnvironment,
} from "@captiondoor/domain";

type Env = Record<string, string | undefined>;
export type RemoteProviderSmokeReservation = {
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
  previousSeconds: number;
  previousMicrousd: number;
  baselineSha256: string;
};
const brand: unique symbol = Symbol("worker-issued-remote-provider-permit");
export type RemoteProviderPermit = Readonly<RemoteProviderSmokeReservation> & {
  readonly allowRoot: boolean;
  readonly [brand]: true;
};
const issued = new WeakMap<
  RemoteProviderPermit,
  { armed: boolean; identity?: "ROOT" | "NON_ROOT" }
>();
function denied(): never {
  throw new AppError(
    "REMOTE_PROVIDER_SMOKE_PERMIT_INVALID",
    403,
    "The bounded remote transcription test permit is unavailable or expired.",
  );
}
function validate(
  permit: RemoteProviderSmokeReservation,
  env: Env,
  now: number,
) {
  const config = assertRemoteProviderSmokeEnvironment(env);
  if (
    permit.scope !== config.scope ||
    permit.accountId !== config.accountId ||
    permit.region !== config.region ||
    permit.tablePrefix !== config.tablePrefix ||
    permit.previousSeconds !== config.previousSeconds ||
    permit.previousMicrousd !== config.previousMicrousd ||
    permit.baselineSha256 !== config.baselineSha256 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      permit.attemptId,
    ) ||
    !permit.householdId ||
    !Number.isSafeInteger(permit.issuedAt) ||
    !Number.isSafeInteger(permit.expiresAt) ||
    permit.issuedAt > now ||
    permit.expiresAt <= now ||
    permit.expiresAt > permit.issuedAt + config.maxAttemptSeconds * 1000 ||
    permit.maxSeconds !== config.maxAttemptSeconds ||
    permit.reservedSeconds !== config.maxAttemptSeconds ||
    !Number.isSafeInteger(permit.cumulativeReservedSeconds) ||
    permit.cumulativeReservedSeconds <
      config.previousSeconds + config.maxAttemptSeconds ||
    permit.cumulativeReservedSeconds > config.maxSeconds ||
    (permit.cumulativeReservedSeconds - config.previousSeconds) %
      config.maxAttemptSeconds !==
      0 ||
    permit.cumulativeEstimatedMicrousd !==
      permit.cumulativeReservedSeconds * config.microusdPerSecond ||
    permit.cumulativeEstimatedMicrousd > config.maxMicrousd
  )
    denied();
  return config;
}
/** Trusted worker only, after the remote DynamoDB transaction reserves the full attempt. */
export function issueRemoteProviderPermit(
  reservation: RemoteProviderSmokeReservation,
  env: Env = process.env,
): RemoteProviderPermit {
  const config = validate(reservation, env, Date.now());
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
    previousSeconds: reservation.previousSeconds,
    previousMicrousd: reservation.previousMicrousd,
    baselineSha256: reservation.baselineSha256,
    allowRoot: config.allowRoot,
    [brand]: true as const,
  });
  issued.set(permit, { armed: false });
  return permit;
}
export function assertRemoteProviderPermit(
  permit: RemoteProviderPermit,
  config: { accountId: string; region: string },
  env: Env = process.env,
): void {
  if (!issued.has(permit)) denied();
  const policy = validate(permit, env, Date.now());
  if (permit.allowRoot !== policy.allowRoot) denied();
  if (permit.accountId !== config.accountId || permit.region !== config.region)
    denied();
}
/** Arms once at stream construction, including identity verification time. */
export function armRemoteProviderDeadline(
  permit: RemoteProviderPermit,
  onLimit: () => void,
  env: Env = process.env,
): () => void {
  assertRemoteProviderPermit(permit, permit, env);
  const state = issued.get(permit)!;
  if (state.armed) denied();
  state.armed = true;
  const timer = setTimeout(onLimit, Math.max(1, permit.expiresAt - Date.now()));
  return () => clearTimeout(timer);
}
export function recordRemoteProviderIdentity(
  permit: RemoteProviderPermit,
  identity: "ROOT" | "NON_ROOT",
  env: Env = process.env,
): void {
  assertRemoteProviderPermit(permit, permit, env);
  const state = issued.get(permit);
  if (
    !state?.armed ||
    !["ROOT", "NON_ROOT"].includes(identity) ||
    (identity === "ROOT" && !permit.allowRoot)
  )
    denied();
  state.identity = identity;
}
export function remoteProviderSmokeReceipt(
  permit: RemoteProviderPermit,
  env: Env = process.env,
) {
  assertRemoteProviderPermit(permit, permit, env);
  const state = issued.get(permit);
  if (
    !state?.armed ||
    !state.identity ||
    (state.identity === "ROOT" && !permit.allowRoot)
  )
    denied();
  return {
    attemptId: permit.attemptId,
    scope: permit.scope,
    maxSeconds: permit.maxSeconds,
    expiresAt: permit.expiresAt,
    previousSeconds: permit.previousSeconds,
    previousMicrousd: permit.previousMicrousd,
    baselineSha256: permit.baselineSha256,
    cumulativeReservedSeconds: permit.cumulativeReservedSeconds,
    cumulativeEstimatedMicrousd: permit.cumulativeEstimatedMicrousd,
    identity: state.identity,
  };
}
