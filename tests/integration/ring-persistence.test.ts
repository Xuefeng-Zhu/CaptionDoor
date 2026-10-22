import { randomUUID } from "node:crypto";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  db,
  tables,
  getItem,
  putItem,
  service,
  hashToken,
} from "@captiondoor/db";
import { presets } from "@captiondoor/domain";
import { ensureTables } from "../../scripts/setup-local";
import { CredentialCipher } from "../../packages/integrations/src/crypto";
import { createRingOAuthAttempt } from "../../packages/integrations/src/ring";
import {
  ringClientForHousehold,
  closePersistedMedia,
} from "../../packages/integrations/src/media-cleanup";
import {
  finishRing,
  selectRingDoor,
  startMedia,
  readyMedia,
} from "../../apps/web/server/ring";
// Dedicated Local tables prevent a running application worker from dispatching mock-provider jobs.
const previousTableEnv = vi.hoisted(() => {
  const names = [
    "CAPTIONDOOR_CONFIG_TABLE",
    "CAPTIONDOOR_VISITS_TABLE",
    "CAPTIONDOOR_RUNTIME_TABLE",
  ] as const;
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.CAPTIONDOOR_CONFIG_TABLE = "CaptionDoorRingTestConfig";
  process.env.CAPTIONDOOR_VISITS_TABLE = "CaptionDoorRingTestVisits";
  process.env.CAPTIONDOOR_RUNTIME_TABLE = "CaptionDoorRingTestRuntime";
  return previous;
});
const sec = () => Math.floor(Date.now() / 1000);
const devKey = Buffer.alloc(32, 9).toString("base64");
const cipher = () =>
  new CredentialCipher({
    mode: "development",
    keyBase64: devKey,
    nodeEnv: "test",
  });
function localIntegrationEnv(mode: "playground" | "live" = "live") {
  vi.stubEnv("RING_MODE", mode);
  vi.stubEnv("RING_CLIENT_ID", "unit-integration-client");
  vi.stubEnv("RING_CLIENT_SECRET", "unit-integration-secret");
  vi.stubEnv("RING_PLAYGROUND_TOKEN", "unit-integration-playground");
  vi.stubEnv("CREDENTIAL_ENCRYPTION_MODE", "development");
  vi.stubEnv("DEV_CREDENTIAL_KEY", devKey);
}
async function fixture() {
  const hid = `ring-test-${randomUUID()}`,
    userId = `owner-${randomUUID()}`,
    doorId = `door-${randomUUID()}`,
    oldAccount = `old-account-${randomUUID()}`,
    PK = `HOUSEHOLD#${hid}`;
  await Promise.all([
    putItem(tables.config, {
      PK,
      SK: "PROFILE",
      id: hid,
      name: "Integration fixture",
      settings: {
        retentionHours: 24,
        captionSize: 32,
        consent: { ring: true, transcription: true, sharing: true },
        presets,
      },
    }),
    putItem(tables.config, {
      PK,
      SK: `MEMBER#${userId}`,
      userId,
      name: "Fixture owner",
      role: "owner",
      expiresAt: sec() + 3600,
      grants: {
        camera: true,
        captions: true,
        visitorText: true,
        membership: true,
      },
    }),
    putItem(tables.config, {
      PK,
      SK: `DOOR#${doorId}`,
      id: doorId,
      name: "Fixture door",
      householdId: hid,
      publicDoorId: `public-${randomUUID()}`,
      ringAccountId: oldAccount,
    }),
    putItem(tables.config, {
      PK: `RINGACCOUNT#${oldAccount}`,
      SK: "LOOKUP",
      householdId: hid,
      doorId,
      deviceId: doorId,
    }),
    putItem(tables.config, {
      PK,
      SK: "INTEGRATION#ring",
      status: "LOCAL_SIMULATION",
    }),
  ]);
  const actor = (await service.createResidentSession(userId, hid)).actor;
  return { hid, PK, userId, doorId, oldAccount, actor };
}
async function oauthFixture() {
  const f = await fixture(),
    { attempt } = createRingOAuthAttempt(
      "unit-integration-client",
      "https://localhost:3443/api/ring/callback",
    );
  await putItem(tables.runtime, {
    PK: `RING_OAUTH#${hashToken(attempt.state)}`,
    SK: "STATE",
    householdId: f.hid,
    sessionId: f.actor.sessionId,
    attempt,
    expiresAt: Math.floor(attempt.expiresAt / 1000),
  });
  const request = new Request(
    `https://localhost:3443/api/ring/callback?state=${attempt.state}&code=fixture-code`,
  );
  return { ...f, attempt, request };
}
async function expiredLink(f: Awaited<ReturnType<typeof fixture>>) {
  const credentials = await cipher().encrypt(
    {
      accessToken: "expired-access-fixture",
      refreshToken: "refresh-fixture",
      expiresAt: Date.now() - 1000,
      tokenType: "Bearer",
      scope: "ava.v1:read",
    },
    { householdId: f.hid, integrationId: "ring" },
  );
  await putItem(tables.config, {
    PK: f.PK,
    SK: "INTEGRATION#ring",
    status: "LINKED",
    credentials,
    accountId: `account-${f.hid}`,
  });
  return credentials;
}
const tokenResponse = () =>
  Response.json({
    access_token: "rotated-access-fixture",
    refresh_token: "rotated-refresh-fixture",
    expires_in: 14400,
    token_type: "Bearer",
    scope: "ava.v1:read",
  });
beforeAll(async () => {
  expect(tables).toEqual({
    config: "CaptionDoorRingTestConfig",
    visits: "CaptionDoorRingTestVisits",
    runtime: "CaptionDoorRingTestRuntime",
  });
  await ensureTables();
}, 30_000);
afterAll(() => {
  for (const [name, value] of Object.entries(previousTableEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Ring authorization fences with real DynamoDB Local", () => {
  it("does not remap another household account or modify the selected door on conflict", async () => {
    localIntegrationEnv("playground");
    const f = await fixture(),
      accountId = `shared-${randomUUID()}`,
      deviceId = `new-${randomUUID()}`;
    await putItem(tables.config, {
      PK: `RINGACCOUNT#${accountId}`,
      SK: "LOOKUP",
      householdId: "different-household",
      doorId: "other-door",
      deviceId,
    });
    const transport = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/v1/devices")
        ? Response.json({
            data: [
              {
                type: "devices",
                id: deviceId,
                attributes: { name: "Fixture device" },
              },
            ],
          })
        : Response.json({
            data: { type: "users", id: accountId, attributes: {} },
          }),
    );
    vi.stubGlobal("fetch", transport);
    await expect(selectRingDoor(f.actor, deviceId)).rejects.toMatchObject({
      code: "RING_SELECTION_CONFLICT",
    });
    expect(
      (await getItem(tables.config, f.PK, `DOOR#${f.doorId}`))?.ringAccountId,
    ).toBe(f.oldAccount);
    expect(
      (await getItem(tables.config, `RINGACCOUNT#${accountId}`, "LOOKUP"))
        ?.householdId,
    ).toBe("different-household");
    expect(
      await getItem(tables.config, `RINGACCOUNT#${f.oldAccount}`, "LOOKUP"),
    ).toBeDefined();
  });
  it("moves its own selected mapping atomically and invalidates the former account", async () => {
    localIntegrationEnv("playground");
    const f = await fixture(),
      accountId = `account-${randomUUID()}`,
      deviceId = `new-${randomUUID()}`;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        String(input).includes("/v1/devices")
          ? Response.json({
              data: [{ type: "devices", id: deviceId, attributes: {} }],
            })
          : Response.json({
              data: { type: "users", id: accountId, attributes: {} },
            }),
      ),
    );
    expect(await selectRingDoor(f.actor, deviceId)).toMatchObject({
      selected: true,
      doorId: f.doorId,
    });
    expect(
      await getItem(tables.config, `RINGACCOUNT#${f.oldAccount}`, "LOOKUP"),
    ).toBeUndefined();
    expect(
      (await getItem(tables.config, `RINGACCOUNT#${accountId}`, "LOOKUP"))
        ?.householdId,
    ).toBe(f.hid);
    expect(
      (await getItem(tables.config, f.PK, `DOOR#${f.doorId}`))?.ringDeviceId,
    ).toBe(deviceId);
  });
  it("rejects callback consent withdrawal before any provider request", async () => {
    localIntegrationEnv();
    const f = await oauthFixture();
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: { PK: f.PK, SK: "PROFILE" },
        UpdateExpression: "SET #settings.consent.ring = :no",
        ExpressionAttributeNames: { "#settings": "settings" },
        ExpressionAttributeValues: { ":no": false },
      }),
    );
    const transport = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", transport);
    await expect(finishRing(f.request, f.actor)).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it("fences consent withdrawn during code exchange before external completion", async () => {
    localIntegrationEnv();
    const f = await oauthFixture();
    const transport = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("oauth.ring.com")) {
        await db.send(
          new UpdateCommand({
            TableName: tables.config,
            Key: { PK: f.PK, SK: "PROFILE" },
            UpdateExpression: "SET #settings.consent.ring = :no",
            ExpressionAttributeNames: { "#settings": "settings" },
            ExpressionAttributeValues: { ":no": false },
          }),
        );
        return tokenResponse();
      }
      return Response.json({
        data: { type: "users", id: `account-${f.hid}`, attributes: {} },
      });
    });
    vi.stubGlobal("fetch", transport);
    await expect(finishRing(f.request, f.actor)).rejects.toMatchObject({
      code: "RING_LINK_SUPERSEDED",
    });
    expect(
      transport.mock.calls.some((call) => call[1]?.method === "PATCH"),
    ).toBe(false);
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.status,
    ).toBe("LOCAL_SIMULATION");
  });
  it("keeps encrypted recovery material and reports uncertainty after external completion/local failure", async () => {
    localIntegrationEnv();
    const f = await oauthFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        String(input).includes("oauth.ring.com")
          ? tokenResponse()
          : String(input).includes("/v1/users/me")
            ? Response.json({
                data: { type: "users", id: `account-${f.hid}`, attributes: {} },
              })
            : Response.json({ status: "completed" }),
      ),
    );
    const original = db.send.bind(db);
    let injected = false;
    vi.spyOn(db, "send").mockImplementation(((command: any) => {
      if (
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some(
          (item: any) =>
            item.Update?.ExpressionAttributeValues?.[":completed"] ===
            "CONFIRMED",
        ) &&
        !injected
      ) {
        injected = true;
        return Promise.reject(
          Object.assign(new Error("Injected local persistence failure"), {
            name: "InternalServerError",
          }),
        );
      }
      return original(command);
    }) as any);
    await expect(finishRing(f.request, f.actor)).rejects.toMatchObject({
      code: "RING_LINK_UNCONFIRMED",
    });
    const row = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(row?.status).toBe("LINKING_REVIEW_REQUIRED");
    expect(row?.completionOutcome).toBe("UNCONFIRMED");
    expect(row?.credentials.mode).toBe("development");
    expect(JSON.stringify(row)).not.toContain("rotated-access-fixture");
  });
  it("does not resurrect credentials when unlink wins during provider token rotation", async () => {
    localIntegrationEnv();
    const f = await fixture();
    await expiredLink(f);
    const transport = vi.fn<typeof fetch>(async () => {
      await db.send(
        new UpdateCommand({
          TableName: tables.config,
          Key: { PK: f.PK, SK: "INTEGRATION#ring" },
          UpdateExpression:
            "SET #status = :unlinked, revoked = :yes REMOVE credentials",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":unlinked": "UNLINKED", ":yes": true },
        }),
      );
      return tokenResponse();
    });
    vi.stubGlobal("fetch", transport);
    const client = await ringClientForHousehold(f.hid);
    await expect(client.listDevices()).rejects.toMatchObject({
      code: "RING_REFRESH_UNCONFIRMED",
    });
    const row = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(row?.status).toBe("UNLINKED");
    expect(row?.revoked).toBe(true);
    expect(row?.credentials).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("cannot release or overwrite a newer refresh lease", async () => {
    localIntegrationEnv();
    const f = await fixture(),
      before = await expiredLink(f);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        await db.send(
          new UpdateCommand({
            TableName: tables.config,
            Key: { PK: f.PK, SK: "INTEGRATION#ring" },
            UpdateExpression:
              "SET refreshOwner = :owner, refreshUntil = :until",
            ExpressionAttributeValues: {
              ":owner": "new-refresh-owner",
              ":until": Date.now() + 60_000,
            },
          }),
        );
        return tokenResponse();
      }),
    );
    await expect(
      (await ringClientForHousehold(f.hid)).listDevices(),
    ).rejects.toMatchObject({ code: "RING_REFRESH_UNCONFIRMED" });
    const row = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(row?.refreshOwner).toBe("new-refresh-owner");
    expect(row?.credentials).toEqual(before);
    expect(row?.status).toBe("LINKED");
  });
  it("persists rotated credentials before issuing the protected provider request", async () => {
    localIntegrationEnv();
    const f = await fixture();
    await expiredLink(f);
    const transport = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("oauth.ring.com")
        ? tokenResponse()
        : Response.json({ data: [] }),
    );
    vi.stubGlobal("fetch", transport);
    expect(await (await ringClientForHousehold(f.hid)).listDevices()).toEqual(
      [],
    );
    const row = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(row?.refreshOwner).toBeUndefined();
    expect(row?.refreshUntil).toBeUndefined();
    const tokens = await cipher().decrypt(row!.credentials, {
      householdId: f.hid,
      integrationId: "ring",
    });
    expect(tokens.refreshToken).toBe("rotated-refresh-fixture");
    expect(
      (transport.mock.calls[1][1]?.headers as Record<string, string>)
        .Authorization,
    ).toBe("Bearer rotated-access-fixture");
  });
  it("can DELETE active provider media after unlink removes main credentials, without refresh or resurrection", async () => {
    localIntegrationEnv();
    const f = await mediaFixture();
    const transport = mediaTransport(f.location);
    vi.stubGlobal("fetch", transport);
    const session = await startMedia(f.actor, f.visit.id, mediaOffer);
    const mediaKey = `MEDIA#${f.hid}#${session.mediaSessionId}`;
    const stored = await getItem(tables.runtime, mediaKey, "SESSION");
    expect(stored?.cleanupCredentials).toBeDefined();
    expect(stored?.cleanupExpiresAt).toBeLessThanOrEqual(
      stored?.providerExpiresAt,
    );
    expect(stored?.cleanupExpiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(JSON.stringify(stored)).not.toContain("rotated-access-fixture");
    const cleanup = await cipher().decrypt(stored!.cleanupCredentials, {
      householdId: f.hid,
      integrationId: "ring",
    });
    expect(cleanup).toMatchObject({
      purpose: "WHEP_DELETE",
      accessToken: "rotated-access-fixture",
      deviceId: f.doorId,
      mediaSessionId: session.mediaSessionId,
    });
    expect(cleanup).not.toHaveProperty("refreshToken");
    await service.unlink(f.actor);
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.credentials,
    ).toBeUndefined();
    await expect(
      (await ringClientForHousehold(f.hid)).listDevices(),
    ).rejects.toMatchObject({ code: "RING_LINK_REQUIRED" });
    const callsBeforeCleanup = transport.mock.calls.length;
    expect(
      await closePersistedMedia(f.hid, session.mediaSessionId!),
    ).toMatchObject({ closed: true, providerCloseConfirmed: true });
    const cleanupCalls = transport.mock.calls.slice(callsBeforeCleanup);
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0][0]).toBe(f.location);
    expect(cleanupCalls[0][1]?.method).toBe("DELETE");
    expect(
      (cleanupCalls[0][1]?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer rotated-access-fixture");
    expect(await getItem(tables.runtime, mediaKey, "SESSION")).toBeUndefined();
    const integration = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(integration?.status).toBe("UNLINKED");
    expect(integration?.credentials).toBeUndefined();
  });
  it("keeps WHEP201 CONNECTING until an explicit browser-ready signal is authorized", async () => {
    localIntegrationEnv();
    const f = await mediaFixture();
    vi.stubGlobal("fetch", mediaTransport(f.location));
    const session = await startMedia(f.actor, f.visit.id, mediaOffer);
    const connecting = await service.getVisit(f.actor, f.visit.id);
    expect(connecting.visit.mediaStatus).toBe("CONNECTING");
    expect(connecting.visit.audioLease).toBeUndefined();
    expect(
      connecting.items.some(
        (item) =>
          item.kind === "event" && item.text.includes("connection established"),
      ),
    ).toBe(false);
    await expect(
      readyMedia(f.actor, f.visit.id, "guessed-media-session"),
    ).rejects.toMatchObject({ code: "MEDIA_STALE" });
    expect(
      (await readyMedia(f.actor, f.visit.id, session.mediaSessionId!)).visit
        .mediaStatus,
    ).toBe("LIVE");
    expect(
      (await service.getVisit(f.actor, f.visit.id)).visit.mediaStatus,
    ).toBe("LIVE");
    await closePersistedMedia(f.hid, session.mediaSessionId!);
  });
});

const mediaOffer =
  "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n";
async function mediaFixture() {
  const f = await fixture();
  const credentials = await cipher().encrypt(
    {
      accessToken: "expired-access-fixture",
      refreshToken: "refresh-fixture",
      expiresAt: Date.now() - 1000,
      tokenType: "Bearer",
      scope: "ava.v1:read",
    },
    { householdId: f.hid, integrationId: "ring" },
  );
  await putItem(tables.config, {
    PK: f.PK,
    SK: "INTEGRATION#ring",
    status: "LINKED",
    credentials,
    accountId: f.oldAccount,
  });
  await db.send(
    new UpdateCommand({
      TableName: tables.config,
      Key: { PK: f.PK, SK: `DOOR#${f.doorId}` },
      UpdateExpression: "SET ringDeviceId = :device",
      ExpressionAttributeValues: { ":device": f.doorId },
    }),
  );
  const press = await service.press({
    accountId: f.oldAccount,
    deviceId: f.doorId,
    eventId: randomUUID(),
    deliveryId: randomUUID(),
    source: "LIVE",
  });
  const { visit } = await service.command(
    f.actor,
    press.visit.id,
    { type: "claim", expectedVersion: press.visit.version },
    randomUUID(),
  );
  const location = `https://api.amazonvision.com/v1/devices/${encodeURIComponent(f.doorId)}/media/streaming/whep/sessions/provider-${randomUUID()}`;
  return { ...f, visit, location };
}
function mediaTransport(location: string) {
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes("oauth.ring.com")) return tokenResponse();
    if (String(input).endsWith("/configurations"))
      return Response.json({
        data: { attributes: { e2e_encryption: { enabled: false } } },
      });
    if (init?.method === "POST" && String(input).endsWith("/whep/sessions"))
      return new Response("v=0\r\ns=fixture-answer\r\n", {
        status: 201,
        headers: { Location: location },
      });
    if (init?.method === "DELETE" && String(input) === location)
      return new Response(null, { status: 204 });
    throw new Error("Unexpected mock provider operation");
  });
}
