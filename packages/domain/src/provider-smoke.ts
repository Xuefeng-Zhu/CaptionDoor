import { AppError } from "./index";
import { assertRemoteProviderSmokeEnvironment } from "./remote-provider-smoke";

export type ProviderSmokeEnvironment = Record<string, string | undefined>;
/** A local-only mixed-provenance bridge. This never grants access to Ring or AWS. */
export function assertProviderSmokeEnvironment(env: ProviderSmokeEnvironment): {
  tablePrefix: string;
} {
  const config = env.CAPTIONDOOR_CONFIG_TABLE || "";
  const prefix = config.endsWith("Config") ? config.slice(0, -6) : "";
  if (
    Object.entries(env).some(
      ([key, value]) =>
        key.startsWith("CAPTIONDOOR_REMOTE_PROVIDER_") && value !== undefined,
    ) ||
    env.NODE_ENV === "production" ||
    env.CAPTIONDOOR_ENV !== "local" ||
    env.CAPTIONDOOR_DB_MODE !== "local" ||
    env.AUTH_MODE !== "demo" ||
    env.RING_MODE !== "playground" ||
    env.CAPTIONDOOR_PROVIDER_SMOKE !== "1" ||
    env.APP_ORIGIN !== "http://127.0.0.1:3410" ||
    !/^CaptionDoorProviderSmoke[A-Za-z0-9_-]{0,70}$/.test(prefix) ||
    env.CAPTIONDOOR_VISITS_TABLE !== `${prefix}Visits` ||
    env.CAPTIONDOOR_RUNTIME_TABLE !== `${prefix}Runtime`
  )
    throw new AppError(
      "PROVIDER_SMOKE_DISABLED",
      403,
      "The local Playground smoke bridge requires explicit isolated configuration.",
    );
  return { tablePrefix: prefix };
}

/** Selects a configured bridge without allowing remote markers into Local mode. */
export function assertActiveProviderSmokeEnvironment(
  env: ProviderSmokeEnvironment,
) {
  if (
    env.CAPTIONDOOR_ENV === "remote-provider" ||
    Object.entries(env).some(
      ([key, value]) =>
        key.startsWith("CAPTIONDOOR_REMOTE_PROVIDER_") && value !== undefined,
    )
  )
    return assertRemoteProviderSmokeEnvironment(env);
  return assertProviderSmokeEnvironment(env);
}
