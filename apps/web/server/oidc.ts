import * as oidc from "openid-client";
import { randomBytes } from "node:crypto";
import { PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { db, tables, getItem, service } from "@captiondoor/db";
import { AppError, assertFresh } from "@captiondoor/domain";
import { cookie, hash, json, origin, setCookie } from "./http";
async function config() {
  if (
    process.env.AUTH_MODE !== "oidc" ||
    !process.env.COGNITO_ISSUER ||
    !process.env.COGNITO_CLIENT_ID ||
    !process.env.COGNITO_CLIENT_SECRET
  )
    throw new AppError(
      "OIDC_UNCONFIGURED",
      503,
      "Cognito app sign-in is not configured.",
    );
  const issuer = new URL(process.env.COGNITO_ISSUER);
  if (
    issuer.protocol !== "https:" ||
    !/^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/.test(issuer.hostname)
  )
    throw new AppError("OIDC_CONFIG", 503, "Use a Cognito OIDC issuer.");
  return oidc.discovery(
    issuer,
    process.env.COGNITO_CLIENT_ID,
    process.env.COGNITO_CLIENT_SECRET,
  );
}
export async function startOidc() {
  const c = await config(),
    state = oidc.randomState(),
    verifier = oidc.randomPKCECodeVerifier(),
    challenge = await oidc.calculatePKCECodeChallenge(verifier);
  await db.send(
    new PutCommand({
      TableName: tables.runtime,
      Item: {
        PK: `OIDC#${hash(state)}`,
        SK: "STATE",
        verifier,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  const url = oidc.buildAuthorizationUrl(c, {
    redirect_uri: `${origin}/api/auth/callback`,
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.href,
      "Cache-Control": "no-store",
      "Set-Cookie": setCookie("cd_oidc_state", state, 600, "Lax"),
    },
  });
}
export async function finishOidc(req: Request) {
  const url = new URL(req.url),
    state = url.searchParams.get("state");
  if (!state || state !== cookie(req, "cd_oidc_state"))
    throw new AppError("OIDC_STATE", 403, "The sign-in attempt has expired.");
  const key = { PK: `OIDC#${hash(state)}`, SK: "STATE" },
    item = await getItem(tables.runtime, key.PK, key.SK);
  if (!item)
    throw new AppError("OIDC_STATE", 403, "The sign-in attempt has expired.");
  assertFresh(item.expiresAt as number);
  await db.send(
    new DeleteCommand({
      TableName: tables.runtime,
      Key: key,
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
  const c = await config();
  const tokens = await oidc.authorizationCodeGrant(
    c,
    new URL(`${origin}/api/auth/callback${url.search}`),
    { pkceCodeVerifier: item.verifier as string, expectedState: state },
  );
  const claims = tokens.claims();
  if (!claims?.sub)
    throw new AppError(
      "OIDC_IDENTITY",
      403,
      "The identity provider did not provide a valid identity.",
    );
  const lookup = await getItem(tables.config, `USER#${claims.sub}`, "LOOKUP");
  if (!lookup?.userId || !lookup.householdId) {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url");
    await db.send(
      new PutCommand({
        TableName: tables.runtime,
        Item: {
          PK: `PENDING_IDENTITY#${hash(token)}`,
          SK: "IDENTITY",
          subject: claims.sub,
          csrf,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    const pendingHeaders = new Headers({
      Location: "/onboarding?join=required",
      "Cache-Control": "no-store",
    });
    pendingHeaders.append("Set-Cookie", setCookie("cd_pending", token, 600));
    pendingHeaders.append(
      "Set-Cookie",
      setCookie("cd_oidc_state", "", 0, "Lax"),
    );
    return new Response(null, { status: 302, headers: pendingHeaders });
  }
  const session = await service.createResidentSession(
    lookup.userId as string,
    lookup.householdId as string,
  );
  const headers = new Headers({
    Location: "/home",
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", setCookie("cd_session", session.token));
  headers.append("Set-Cookie", setCookie("cd_oidc_state", "", 0, "Lax"));
  return new Response(null, { status: 302, headers });
}

export async function pendingIdentity(req: Request) {
  const token = cookie(req, "cd_pending");
  if (!token)
    throw new AppError(
      "IDENTITY_REQUIRED",
      401,
      "Sign in with Cognito before accepting a household invitation.",
    );
  const record = await getItem(
    tables.runtime,
    `PENDING_IDENTITY#${hash(token)}`,
    "IDENTITY",
  );
  if (!record)
    throw new AppError(
      "IDENTITY_REQUIRED",
      401,
      "The verified sign-in has expired. Sign in again.",
    );
  assertFresh(record.expiresAt);
  return record;
}
