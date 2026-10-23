import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { AppError } from "@captiondoor/domain";

function denied(): never {
  throw new AppError(
    "REMOTE_PROVIDER_TEMPORARY_CREDENTIALS_REQUIRED",
    503,
    "The remote provider test requires valid temporary AWS session credentials.",
  );
}

/** Pure metadata check. Never logs, copies or returns a credential value. */
export function validateTemporaryRemoteCredentials(
  credentials: unknown,
  now = Date.now(),
): void {
  if (!credentials || typeof credentials !== "object") denied();
  const { sessionToken, expiration } = credentials as {
    sessionToken?: unknown;
    expiration?: unknown;
  };
  if (
    typeof sessionToken !== "string" ||
    !sessionToken ||
    /[\s\x00-\x1f\x7f]/.test(sessionToken) ||
    !Number.isFinite(now) ||
    (expiration !== undefined &&
      (!(expiration instanceof Date) ||
        !Number.isFinite(expiration.getTime()) ||
        expiration.getTime() <= now))
  )
    denied();
}

/** Keep the normal SDK chain and its refresh behavior; sanitize every failed resolution. */
export function temporaryRemoteCredentialsProvider<Args extends unknown[], T>(
  load: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T> {
  return async (...args) => {
    try {
      const credentials = await load(...args);
      validateTemporaryRemoteCredentials(credentials);
      return credentials;
    } catch {
      denied();
    }
  };
}

/** Call only for the explicit remote-provider mode; DocumentClient inherits the guard. */
export function installTemporaryRemoteDatabaseCredentialsGuard(
  client: DynamoDBClient,
): void {
  client.config.credentials = temporaryRemoteCredentialsProvider(
    client.config.credentials,
  );
  client.middlewareStack.add(
    (next) => async (args) => {
      await client.config.credentials();
      return next(args);
    },
    {
      step: "initialize",
      name: "captionDoorRemoteTemporaryCredentials",
      priority: "high",
    },
  );
}
