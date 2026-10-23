import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import {
  DeleteCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import QRCode from "qrcode";
import { z } from "zod";
import {
  service,
  db,
  tables,
  databaseConfig,
  getItem,
  queryPK,
} from "@captiondoor/db";
import { AppError, type Actor, assertFresh } from "@captiondoor/domain";
import {
  commandSchema,
  guestMessageSchema,
  identitySchema,
  settingsSchema,
} from "@captiondoor/contracts";
import { parseRingWebhook } from "@captiondoor/integrations";
import {
  enqueuePushTest,
  pushPublicKey,
  subscribePush,
} from "@captiondoor/integrations/push";
import {
  actor,
  body,
  checkOrigin,
  cookie,
  csrf,
  hash,
  idempotency,
  json,
  limit,
  origin,
  respond,
  setCookie,
} from "../../../server/http";
import { startOidc, finishOidc, pendingIdentity } from "../../../server/oidc";
import {
  startRing,
  finishRing,
  listRingDevices,
  startMedia,
  stopMedia,
  readyMedia,
  unlinkRing,
  selectRingDoor,
} from "../../../server/ring";
import {
  assertProviderSmokeRuntime,
  pressProviderSmoke,
  providerSmokeRuntimeStatus,
} from "../../../server/provider-smoke";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function run(req: Request, context: Context) {
  const path = (await context.params).path,
    route = path.join("/"),
    method = req.method,
    url = new URL(req.url);
  if (method === "GET" && route === "health") {
    await getItem(tables.config, "HEALTH", "CHECK");
    return json({
      status: "ok",
      database: "DynamoDB",
      databaseMode: databaseConfig.mode,
      environment: databaseConfig.environment,
      ringMode: process.env.RING_MODE || "demo",
      transcribeMode: process.env.TRANSCRIBE_MODE || "fixture",
      authMode: process.env.AUTH_MODE || "demo",
      ...providerSmokeRuntimeStatus(),
    });
  }
  if (method === "POST" && route === "auth/demo") {
    checkOrigin(req);
    await limit("demo-login", 60);
    if (
      (process.env.AUTH_MODE || "demo") !== "demo" ||
      process.env.NODE_ENV === "production" ||
      !["127.0.0.1", "localhost"].includes(new URL(origin).hostname)
    )
      throw new AppError(
        "DEMO_DISABLED",
        403,
        "Local demo authentication is disabled.",
      );
    const input = z.object({ identity: identitySchema }).parse(await body(req));
    const result = await service.demoLogin(input.identity);
    return json({ csrf: result.csrf, user: result.user }, 200, {
      "Set-Cookie": setCookie("cd_session", result.token),
    });
  }
  if (method === "GET" && route === "auth/login") return startOidc();
  if (method === "GET" && route === "auth/callback") return finishOidc(req);
  if (method === "GET" && route === "auth/pending") {
    const pending = await pendingIdentity(req);
    return json({ pending: true, csrf: pending.csrf });
  }
  if (method === "POST" && route === "members/accept") {
    checkOrigin(req);
    const pending = await pendingIdentity(req);
    const got = Buffer.from(req.headers.get("x-csrf-token") || ""),
      expected = Buffer.from(pending.csrf);
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      throw new AppError(
        "CSRF",
        403,
        "Refresh the invitation page and try again.",
      );
    await limit(`invite:${pending.PK}`, 10);
    const input = z
      .object({ inviteCode: z.string().min(20).max(128) })
      .parse(await body(req));
    const session = await service.acceptInvite(
      pending.subject,
      input.inviteCode,
      { PK: pending.PK, SK: pending.SK },
    );
    const headers = new Headers();
    headers.append("Set-Cookie", setCookie("cd_session", session.token));
    headers.append("Set-Cookie", setCookie("cd_pending", "", 0));
    return json({ csrf: session.csrf, user: session.user }, 200, headers);
  }

  if (method === "POST" && route === "auth/logout") {
    const who = await actor(req);
    csrf(req, who);
    await db.send(
      new DeleteCommand({
        TableName: tables.runtime,
        Key: { PK: `SESSION#${who.sessionId}`, SK: "SESSION" },
      }),
    );
    return json({ signedOut: true }, 200, {
      "Set-Cookie": setCookie("cd_session", "", 0),
    });
  }
  if (method === "POST" && route === "guest/sessions") {
    checkOrigin(req);
    await limit("guest-create", 60);
    const input = z
      .object({ publicDoorId: z.string().min(1).max(128) })
      .parse(await body(req));
    const old = cookie(req, "cd_guest");
    if (old) {
      try {
        const who = await service.authenticate(old);
        if (who.kind === "guest") {
          const existing = await service.guestView(who);
          const thread = await getItem(
            tables.visits,
            `HOUSEHOLD#${who.householdId}#THREAD#${who.threadId}`,
            "STATE",
          );
          const entrance = await getItem(
            tables.config,
            `PUBLICDOOR#${input.publicDoorId}`,
            "LOOKUP",
          );
          if (
            entrance &&
            !entrance.revoked &&
            entrance.householdId === who.householdId &&
            thread?.doorId === entrance.doorId
          )
            return json(existing);
        }
      } catch {
        /* Expired/revoked cookie receives a new isolated session. */
      }
    }
    const result = await service.createGuest(input.publicDoorId);
    return json(
      {
        thread: result.thread,
        messages: result.messages,
        csrf: result.csrf,
        wsUrl: result.wsUrl,
      },
      201,
      { "Set-Cookie": setCookie("cd_guest", result.token, 3600, "Strict") },
    );
  }
  if (method === "GET" && route === "guest") {
    const who = await actor(req, "guest");
    const publicDoorId = url.searchParams.get("publicDoorId");
    if (publicDoorId) {
      const entrance = await getItem(
          tables.config,
          `PUBLICDOOR#${publicDoorId}`,
          "LOOKUP",
        ),
        thread = await getItem(
          tables.visits,
          `HOUSEHOLD#${who.householdId}#THREAD#${who.threadId}`,
          "STATE",
        );
      if (
        !entrance ||
        entrance.revoked ||
        entrance.householdId !== who.householdId ||
        thread?.doorId !== entrance.doorId
      )
        throw new AppError(
          "UNAUTHENTICATED",
          401,
          "Start a new conversation for this entrance.",
        );
    }
    return json(
      await service.guestView(who, url.searchParams.get("cursor") || undefined),
    );
  }
  if (method === "POST" && route === "guest/messages") {
    const who = await actor(req, "guest");
    csrf(req, who);
    await limit(`guest-message:${who.sessionId}`, 20);
    return json(
      await service.guestMessage(
        who,
        guestMessageSchema.parse(await body(req)),
        idempotency(req),
      ),
      201,
    );
  }
  if (
    method === "POST" &&
    path[0] === "guest" &&
    path[1] === "messages" &&
    path[2] &&
    ["display", "confirm"].includes(path[3])
  ) {
    const who = await actor(req, "guest");
    csrf(req, who);
    return json(
      await service.delivery(
        who,
        path[2],
        path[3] === "display" ? "DISPLAYED" : "CONFIRMED",
      ),
    );
  }
  if (method === "POST" && route === "ring/webhook") {
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.length > 65536)
      throw new AppError("TOO_LARGE", 413, "Webhook too large.");
    const secret =
      (process.env.RING_MODE || "demo") === "demo"
        ? process.env.LOCAL_SIGNING_SECRET
        : process.env.RING_WEBHOOK_SECRET;
    if (!secret)
      throw new AppError(
        "RING_WEBHOOK_UNCONFIGURED",
        503,
        "Webhook signing is not configured.",
      );
    const event = parseRingWebhook(raw, req.headers.get("x-signature"), secret);
    if (event.type === "button_press")
      return json(
        await service.press({
          accountId: event.accountId,
          deviceId: event.deviceId!,
          eventId: event.eventId,
          deliveryId: event.deliveryId,
          source:
            process.env.RING_MODE === "live"
              ? "LIVE"
              : process.env.RING_MODE === "playground"
                ? "PLAYGROUND"
                : "LOCAL",
        }),
      );
    const linked = await getItem(
      tables.config,
      `RINGACCOUNT#${event.accountId}`,
      "LOOKUP",
    );
    if (!linked)
      throw new AppError(
        "RING_ACCOUNT_DENIED",
        403,
        "Ring account is not linked.",
      );
    if (event.type === "device_offline")
      await service.ringDeviceOffline(
        event.accountId,
        event.deviceId!,
        event.eventId,
        event.deliveryId,
      );
    else if (event.type !== "ignored")
      await service.revokeRingAccount(
        event.accountId,
        event.deviceId,
        event.type,
      );
    return json({ accepted: true, ignored: event.type === "ignored" });
  }
  if (method === "GET" && path[0] === "sign" && path[1]) {
    const door = await getItem(
      tables.config,
      `PUBLICDOOR#${path[1]}`,
      "LOOKUP",
    );
    if (!door) throw new AppError("NOT_FOUND", 404, "Door not found.");
    const address = `${origin}/door/${encodeURIComponent(path[1])}`,
      qr = await QRCode.toString(address, {
        type: "svg",
        margin: 2,
        width: 320,
        errorCorrectionLevel: "M",
      });
    return new Response(
      `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Text this household</title><style>body{color:#172b29;background:white;font:24px/1.5 Georgia,serif;text-align:center;max-width:620px;padding:40px 20px;margin:auto}svg{max-width:100%;height:auto}p{font:18px/1.5 sans-serif}a{overflow-wrap:anywhere;color:inherit}@media print{button{display:none}}</style><h1>Prefer to communicate by text?</h1><p>Scan here to message this household.</p>${qr}<p><a href="${address}">${address}</a></p><p>Keep the page open for a reply.</p></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  if (method === "GET" && route === "provider-smoke/budget") {
    assertProviderSmokeRuntime();
    const who = await actor(req);
    return json(
      process.env.CAPTIONDOOR_ENV === "remote-provider"
        ? await service.getRemoteProviderSmokeBudget(who)
        : await service.getRootSmokeBudget(who),
    );
  }
  if (method === "POST" && route === "provider-smoke/press")
    assertProviderSmokeRuntime();
  const who = await actor(req);
  if (method !== "GET") csrf(req, who);
  if (method === "POST" && route === "provider-smoke/press") {
    const input = z
      .object({ eventId: z.uuid() })
      .strict()
      .parse(await body(req));
    return json(await pressProviderSmoke(who, input.eventId, idempotency(req)));
  }
  if (method === "GET" && route === "me")
    return json(await service.bootstrap(who));
  if (method === "GET" && route === "ring/status") {
    const integration = await getItem(
        tables.config,
        `HOUSEHOLD#${who.householdId}`,
        "INTEGRATION#ring",
      ),
      boot = await service.bootstrap(who);
    const selected = boot.doors[0] as (typeof boot.doors)[number] & {
      ringDeviceId?: string;
    };
    return json({
      status: integration?.status || "UNLINKED",
      selectedDeviceId: selected?.ringDeviceId,
    });
  }
  if (method === "GET" && route === "ring/connect") return startRing(who);
  if (method === "GET" && route === "ring/callback")
    return finishRing(req, who);
  if (method === "GET" && route === "ring/devices")
    return json({ devices: await listRingDevices(who) });
  if (method === "POST" && route === "ring/select-door")
    return json(
      await selectRingDoor(
        who,
        z
          .object({ deviceId: z.string().min(1).max(256) })
          .parse(await body(req)).deviceId,
      ),
    );
  if (method === "GET" && path[0] === "visits" && path.length === 2)
    return json(
      await service.getVisit(
        who,
        path[1],
        url.searchParams.get("cursor") || undefined,
      ),
    );
  if (method === "POST" && path[0] === "visits" && path[2] === "commands") {
    return json(
      await service.command(
        who,
        path[1],
        commandSchema.parse(await body(req)),
        idempotency(req),
      ),
    );
  }
  if (
    method === "POST" &&
    path[0] === "visits" &&
    path[2] === "media" &&
    path[3] === "ready"
  ) {
    const input = z
      .object({ mediaSessionId: z.string().min(1).max(100) })
      .parse(await body(req));
    return json(await readyMedia(who, path[1], input.mediaSessionId));
  }
  if (
    method === "POST" &&
    path[0] === "visits" &&
    path[2] === "media" &&
    path.length === 3
  ) {
    const input = z
      .object({
        offer: z.string().min(1).max(65536),
        includeAudio: z.boolean().optional(),
        consent: z.literal(true),
      })
      .parse(await body(req, 70000));
    return json(await startMedia(who, path[1], input.offer));
  }
  if (
    method === "DELETE" &&
    path[0] === "visits" &&
    path[2] === "media" &&
    path[3]
  ) {
    return json(await stopMedia(who, path[1], path[3]));
  }
  if (method === "POST" && route === "settings")
    return json(
      await service.settings(who, settingsSchema.parse(await body(req))),
    );
  if (method === "POST" && route === "settings/unlink") {
    await unlinkRing(who);
    return json({ unlinked: true });
  }
  if (method === "POST" && path[0] === "members" && path[2] === "revoke") {
    await service.revoke(who, path[1]);
    return json({ revoked: true });
  }
  if (method === "POST" && route === "members/invite")
    return json(
      await service.invite(
        who,
        z
          .object({ name: z.string().trim().min(1).max(80) })
          .parse(await body(req)),
      ),
    );
  if (method === "GET" && route === "push/public-key")
    return json({ publicKey: pushPublicKey() });
  if (method === "POST" && route === "push/subscribe") {
    const input = z
      .object({ subscription: z.unknown() })
      .parse(await body(req));
    return json(await subscribePush(who, input.subscription));
  }
  if (method === "POST" && route === "push/test")
    return json(await enqueuePushTest(who), 202);
  if (path[0] === "demo") {
    if (
      (process.env.RING_MODE || "demo") !== "demo" ||
      process.env.NODE_ENV === "production"
    )
      throw new AppError("DEMO_DISABLED", 403, "Local scenarios are disabled.");
    if (method === "POST" && route === "demo/press") {
      const { scenario } = z
        .object({
          scenario: z
            .enum(["doorbell", "missing-audio", "duplicate-webhook"])
            .default("doorbell"),
        })
        .parse(await body(req));
      const boot = await service.bootstrap(who);
      const door = boot.doors[0];
      if (!door) throw new AppError("DOOR_REQUIRED", 409, "Select a door.");
      const lookup = await getItem(
        tables.config,
        `HOUSEHOLD#${who.householdId}`,
        `DOOR#${door.id}`,
      );
      const signingKey = process.env.LOCAL_SIGNING_SECRET;
      if (!signingKey)
        throw new AppError(
          "LOCAL_SIGNING_REQUIRED",
          503,
          "Rerun setup:local and restart the app to load the private local fixture signing key.",
        );
      const eventId = randomUUID(),
        accountId =
          (lookup?.ringAccountId as string) ||
          `demo-account${who.householdId === "h1" ? "" : "-h2"}`,
        deviceId = (lookup?.ringDeviceId as string) || door.id;
      const deliver = async () => {
        const raw = JSON.stringify({
          meta: {
            version: "1.1",
            account_id: accountId,
            request_id: randomUUID(),
          },
          data: {
            type: "button_press",
            id: eventId,
            attributes: {
              source: deviceId,
              source_type: "devices",
              timestamp: Date.now(),
            },
          },
        });
        const signature =
          "sha256=" +
          createHmac("sha256", signingKey).update(raw).digest("hex");
        const event = parseRingWebhook(raw, signature, signingKey);
        return service.press({
          accountId: event.accountId,
          deviceId: event.deviceId!,
          eventId: event.eventId,
          deliveryId: event.deliveryId,
          source: "LOCAL",
        });
      };
      let result = await deliver();
      if (scenario === "duplicate-webhook") {
        const duplicate = await deliver();
        return json(
          {
            ...result,
            duplicateDelivered: true,
            secondDeliveryDeduplicated: duplicate.duplicate,
          },
          201,
        );
      }
      if (scenario === "missing-audio")
        result = {
          ...result,
          ...(await service.simulateMediaUnavailable(who, result.visit.id)),
        };
      return json(result, 201);
    }
    if (method === "POST" && route === "demo/captions") {
      const input = z
        .object({ visitId: z.string().min(1), consent: z.literal(true) })
        .parse(await body(req));
      let { visit } = await service.getVisit(who, input.visitId);
      if (visit.handlerId !== who.userId)
        throw new AppError(
          "HANDLER_REQUIRED",
          403,
          "Only the current handler can start a demo transcript.",
        );
      if (!["LIVE"].includes(visit.mediaStatus))
        ({ visit } = await service.command(
          who,
          visit.id,
          {
            type: "media",
            expectedVersion: visit.version,
            action: "start",
            consent: true,
          },
          randomUUID(),
        ));
      if (!visit.audioLease)
        ({ visit } = await service.command(
          who,
          visit.id,
          { type: "capture", expectedVersion: visit.version, consent: true },
          randomUUID(),
        ));
      return json(await service.enqueueDemoCaptions(who, visit.id), 202);
    }
    if (method === "POST" && route === "demo/media-expire") {
      const input = z
        .object({ visitId: z.string().min(1) })
        .parse(await body(req));
      const { visit } = await service.getVisit(who, input.visitId);
      return json(
        await service.command(
          who,
          visit.id,
          {
            type: "media",
            expectedVersion: visit.version,
            action: "interrupt",
          },
          randomUUID(),
        ),
      );
    }
  }
  throw new AppError("NOT_FOUND", 404, "This endpoint does not exist.");
}
export const GET = (req: Request, context: Context) =>
  respond(() => run(req, context));
export const POST = GET;
export const DELETE = GET;
