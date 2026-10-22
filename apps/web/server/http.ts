import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { service, db, tables } from "@captiondoor/db";
import { AppError, validateModes, type Actor } from "@captiondoor/domain";
validateModes(process.env);
export const origin = process.env.APP_ORIGIN || "http://127.0.0.1:3410";
export const secure =
  process.env.NODE_ENV === "production" ||
  new URL(origin).protocol === "https:";
export function cookie(req: Request, name: string) {
  const value = (req.headers.get("cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + "="))
    ?.slice(name.length + 1);
  return value ? decodeURIComponent(value) : undefined;
}
export function setCookie(
  name: string,
  value: string,
  maxAge = 86400,
  sameSite = "Lax",
) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function json(value: unknown, status = 200, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store, private");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(value), { status, headers });
}
export async function actor(
  req: Request,
  kind: "resident" | "guest" = "resident",
): Promise<Actor> {
  const token = cookie(req, kind === "resident" ? "cd_session" : "cd_guest");
  if (!token)
    throw new AppError("UNAUTHENTICATED", 401, "Sign in to continue.");
  const who = await service.authenticate(token);
  if (who.kind !== kind)
    throw new AppError(
      "FORBIDDEN",
      403,
      "This session cannot access that page.",
    );
  return who;
}
export function checkOrigin(req: Request) {
  const received = req.headers.get("origin");
  if (received !== origin)
    throw new AppError(
      "ORIGIN_DENIED",
      403,
      "The request origin is not allowed.",
    );
}
export function csrf(req: Request, who: Actor) {
  checkOrigin(req);
  const got = req.headers.get("x-csrf-token") || "";
  const a = Buffer.from(got),
    b = Buffer.from(who.csrf);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new AppError("CSRF", 403, "Refresh the page and try again.");
}
export async function body(req: Request, max = 16384): Promise<unknown> {
  const text = await req.text();
  if (Buffer.byteLength(text) > max)
    throw new AppError("TOO_LARGE", 413, "The request is too large.");
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new AppError("INVALID_JSON", 400, "Use a valid JSON request.");
  }
}
export function idempotency(req: Request) {
  const value = req.headers.get("idempotency-key");
  if (!value || !/^[A-Za-z0-9_-]{8,128}$/.test(value))
    throw new AppError(
      "IDEMPOTENCY_REQUIRED",
      400,
      "A valid Idempotency-Key is required.",
    );
  return value;
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export async function limit(key: string, max = 30) {
  const bucket = Math.floor(Date.now() / 60000);
  try {
    await db.send(
      new UpdateCommand({
        TableName: tables.runtime,
        Key: { PK: `RATE#${hash(key)}#${bucket}`, SK: "COUNT" },
        UpdateExpression: "SET expiresAt=:expiry ADD #count :one",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: {
          ":expiry": Math.floor(Date.now() / 1000) + 120,
          ":one": 1,
          ":max": max,
        },
      }),
    );
  } catch (e) {
    if ((e as Error).name === "ConditionalCheckFailedException")
      throw new AppError(
        "RATE_LIMITED",
        429,
        "Please wait a moment before trying again.",
      );
    throw e;
  }
}
export async function respond(run: () => Promise<Response>) {
  const requestId = randomUUID();
  try {
    const response = await run();
    response.headers.set("X-Request-ID", requestId);
    return response;
  } catch (e) {
    const known = e instanceof AppError;
    const zod = (e as Error).name === "ZodError";
    const status = known ? e.status : zod ? 400 : 503;
    const code = known ? e.code : zod ? "VALIDATION" : "SERVICE_UNAVAILABLE";
    console.error(JSON.stringify({ requestId, code, status }));
    return json(
      {
        error: {
          code,
          message: known
            ? e.message
            : zod
              ? "Check the submitted fields."
              : "The service is temporarily unavailable. Your action was not confirmed.",
          ...(known && e.current ? { current: e.current } : {}),
        },
        requestId,
      },
      status,
      { "X-Request-ID": requestId },
    );
  }
}
