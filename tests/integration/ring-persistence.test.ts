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
import {
  getOrCreateRingClientIdentity,
  loadRingClientIdentity,
} from "../../packages/integrations/src/ring-identity";
import { origin as appOrigin } from "../../apps/web/server/http";
import { createRingOAuthAttempt } from "../../packages/integrations/src/ring";
import {
  ringClientForHousehold,
  closePersistedMedia,
} from "../../packages/integrations/src/media-cleanup";
import {
  finishRing,
  startRing,
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
  vi.stubEnv("RING_REDIRECT_URI", "https://localhost:3443/api/ring/callback");
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
  const clientIdentity = await getOrCreateRingClientIdentity(
    f.hid,
    f.userId,
    appOrigin,
  );
  await putItem(tables.runtime, {
    clientIdentity,
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
  const clientIdentity = await getOrCreateRingClientIdentity(
    f.hid,
    f.userId,
    appOrigin,
  );
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
    clientIdentity,
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
    const identity = await loadRingClientIdentity(f.hid, f.userId, appOrigin);
    expect(row?.clientIdentity).toEqual(identity);
    for (const [, init] of transport.mock.calls) {
      expect(new Headers(init?.headers).get("Hardware_Id")).toBe(
        identity.hardwareId,
      );
      expect(new Headers(init?.headers).get("User-Agent")).toBe(
        "CaptionDoor/0.1.0",
      );
    }
    expect(
      new Headers(transport.mock.calls[1][1]?.headers).get("Authorization"),
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
    const identity = await loadRingClientIdentity(f.hid, f.userId, appOrigin);
    expect(cleanup.hardwareId).toBe(identity.hardwareId);
    for (const [, init] of transport.mock.calls) {
      expect(new Headers(init?.headers).get("Hardware_Id")).toBe(
        identity.hardwareId,
      );
      expect(new Headers(init?.headers).get("User-Agent")).toBe(
        "CaptionDoor/0.1.0",
      );
    }
    expect(cleanup).not.toHaveProperty("refreshToken");
    await service.unlink(f.actor);
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.credentials,
    ).toBeUndefined();
    await expect(ringClientForHousehold(f.hid)).rejects.toMatchObject({
      code: "RING_LINK_REQUIRED",
    });
    const callsBeforeCleanup = transport.mock.calls.length;
    expect(
      await closePersistedMedia(f.hid, session.mediaSessionId!),
    ).toMatchObject({ closed: true, providerCloseConfirmed: true });
    const cleanupCalls = transport.mock.calls.slice(callsBeforeCleanup);
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0][0]).toBe(f.location);
    expect(cleanupCalls[0][1]?.method).toBe("DELETE");
    expect(new Headers(cleanupCalls[0][1]?.headers).get("Hardware_Id")).toBe(
      identity.hardwareId,
    );
    expect(new Headers(cleanupCalls[0][1]?.headers).get("User-Agent")).toBe(
      "CaptionDoor/0.1.0",
    );
    expect(new Headers(cleanupCalls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer rotated-access-fixture",
    );
    expect(await getItem(tables.runtime, mediaKey, "SESSION")).toBeUndefined();
    const integration = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(integration?.status).toBe("UNLINKED");
    expect(integration?.credentials).toBeUndefined();
  });
  it("revocation erases reusable credentials and leases while preserving only bounded media cleanup", async () => {
    localIntegrationEnv();
    const f = await mediaFixture();
    const transport = mediaTransport(f.location);
    vi.stubGlobal("fetch", transport);
    const session = await startMedia(f.actor, f.visit.id, mediaOffer);
    const ready = await readyMedia(
      f.actor,
      f.visit.id,
      session.mediaSessionId!,
    );
    const captured = await service.command(
      f.actor,
      f.visit.id,
      {
        type: "capture",
        consent: true,
        expectedVersion: ready.visit.version,
      },
      randomUUID(),
    );
    const leaseId = captured.visit.audioLease!.id;
    const mediaKey = `MEDIA#${f.hid}#${session.mediaSessionId}`;
    const stored = await getItem(tables.runtime, mediaKey, "SESSION");
    const before = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    const existingClient = await ringClientForHousehold(f.hid);
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: { PK: f.PK, SK: "INTEGRATION#ring" },
        UpdateExpression: "SET refreshOwner = :owner, refreshUntil = :until",
        ExpressionAttributeValues: {
          ":owner": "fixture-old-refresh",
          ":until": Date.now() + 60_000,
        },
      }),
    );
    await expect(
      service.revokeRingAccount(f.oldAccount, "wrong-fixture-device"),
    ).rejects.toMatchObject({ code: "UNKNOWN_ACCOUNT" });
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.credentials,
    ).toEqual(before?.credentials);
    const callsBeforeRevoke = transport.mock.calls.length;
    await service.revokeRingAccount(f.oldAccount, f.doorId);
    expect(transport).toHaveBeenCalledTimes(callsBeforeRevoke);
    const revoked = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(revoked).toMatchObject({
      status: "REVOKED",
      revoked: true,
      clientIdentity: before!.clientIdentity,
    });
    for (const field of ["credentials", "refreshOwner", "refreshUntil"])
      expect(revoked).not.toHaveProperty(field);
    expect(
      (await getItem(tables.runtime, mediaKey, "SESSION"))?.cleanupCredentials,
    ).toEqual(stored?.cleanupCredentials);
    const ended = (await service.getVisit(f.actor, f.visit.id)).visit;
    expect(ended).toMatchObject({
      status: "CLAIMED",
      handlerId: f.userId,
      mediaStatus: "ENDED",
    });
    expect(ended.mediaSessionId).toBeUndefined();
    expect(ended.audioLease).toBeUndefined();
    expect(
      await getItem(
        tables.runtime,
        `HOUSEHOLD#${f.hid}#VISIT#${f.visit.id}`,
        "CAPTURE",
      ),
    ).toBeUndefined();
    await expect(
      service.authorizeCapture(f.actor, f.visit.id, {
        leaseId,
        mediaSessionId: session.mediaSessionId!,
      }),
    ).rejects.toMatchObject({ code: "CONSENT_REVOKED" });
    await expect(existingClient.listDevices()).rejects.toMatchObject({
      code: "RING_LINK_REQUIRED",
    });
    await expect(ringClientForHousehold(f.hid)).rejects.toMatchObject({
      code: "RING_LINK_REQUIRED",
    });
    await service.revokeRingAccount(f.oldAccount, f.doorId);
    expect((await service.getVisit(f.actor, f.visit.id)).visit.version).toBe(
      ended.version,
    );
    const profile = await service.bootstrap(f.actor);
    expect(profile.settings.consent).toMatchObject({
      ring: false,
      transcription: false,
    });
    const cleanup = await cipher().decrypt(stored!.cleanupCredentials, {
      householdId: f.hid,
      integrationId: "ring",
    });
    expect(cleanup).toMatchObject({
      purpose: "WHEP_DELETE",
      mediaSessionId: session.mediaSessionId,
      deviceId: f.doorId,
    });
    expect(cleanup).not.toHaveProperty("refreshToken");
    expect(cleanup).not.toHaveProperty("clientSecret");
    transport.mockImplementationOnce(
      async () => new Response(null, { status: 503 }),
    );
    await expect(
      closePersistedMedia(f.hid, session.mediaSessionId!),
    ).rejects.toMatchObject({ code: "RING_REQUEST_FAILED" });
    expect(
      (await getItem(tables.runtime, mediaKey, "SESSION"))?.cleanupCredentials,
    ).toEqual(stored?.cleanupCredentials);
    expect(
      await closePersistedMedia(f.hid, session.mediaSessionId!),
    ).toMatchObject({ closed: true, providerCloseConfirmed: true });
    const cleanupCalls = transport.mock.calls.slice(callsBeforeRevoke);
    expect(cleanupCalls).toHaveLength(2);
    for (const [url, init] of cleanupCalls) {
      expect(url).toBe(f.location);
      expect(init?.method).toBe("DELETE");
      expect(new Headers(init?.headers).get("Hardware_Id")).toBe(
        cleanup.hardwareId,
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer rotated-access-fixture",
      );
    }
    expect(await getItem(tables.runtime, mediaKey, "SESSION")).toBeUndefined();
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.credentials,
    ).toBeUndefined();
  });
  it("revocation transaction failure retains credentials, consent and safe cleanup until retry commits", async () => {
    localIntegrationEnv();
    const f = await mediaFixture();
    vi.stubGlobal("fetch", mediaTransport(f.location));
    const session = await startMedia(f.actor, f.visit.id, mediaOffer);
    const mediaKey = `MEDIA#${f.hid}#${session.mediaSessionId}`;
    const before = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    const stored = await getItem(tables.runtime, mediaKey, "SESSION");
    const version = (await service.getVisit(f.actor, f.visit.id)).visit.version;
    const original = db.send.bind(db);
    const spy = vi.spyOn(db, "send").mockImplementation(((command: any) => {
      if (
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some(
          (item: any) =>
            item.Update?.ExpressionAttributeValues?.[":revoked"] === "REVOKED",
        )
      )
        return Promise.reject(
          Object.assign(new Error("Injected local revocation failure"), {
            name: "InternalServerError",
          }),
        );
      return original(command);
    }) as any);
    try {
      await expect(
        service.revokeRingAccount(f.oldAccount, f.doorId),
      ).rejects.toMatchObject({ name: "InternalServerError" });
    } finally {
      spy.mockRestore();
    }
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.credentials,
    ).toEqual(before?.credentials);
    expect(
      (await getItem(tables.config, `RINGACCOUNT#${f.oldAccount}`, "LOOKUP"))
        ?.revoked,
    ).toBeUndefined();
    expect((await service.bootstrap(f.actor)).settings.consent.ring).toBe(true);
    expect((await service.getVisit(f.actor, f.visit.id)).visit).toMatchObject({
      version,
      mediaStatus: "CONNECTING",
      mediaSessionId: session.mediaSessionId,
    });
    expect(
      (await getItem(tables.runtime, mediaKey, "SESSION"))?.cleanupCredentials,
    ).toEqual(stored?.cleanupCredentials);
    await service.revokeRingAccount(f.oldAccount, f.doorId);
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.credentials,
    ).toBeUndefined();
    await closePersistedMedia(f.hid, session.mediaSessionId!);
  });
  it("an in-flight refresh cannot restore reusable credentials after webhook revocation commits", async () => {
    localIntegrationEnv();
    const f = await mediaFixture();
    const transport = vi.fn<typeof fetch>(async () => {
      await service.revokeRingAccount(f.oldAccount, f.doorId);
      return tokenResponse();
    });
    vi.stubGlobal("fetch", transport);
    const client = await ringClientForHousehold(f.hid);
    await expect(client.listDevices()).rejects.toMatchObject({
      code: "RING_REFRESH_UNCONFIRMED",
    });
    const revoked = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(revoked).toMatchObject({ status: "REVOKED", revoked: true });
    for (const field of ["credentials", "refreshOwner", "refreshUntil"])
      expect(revoked).not.toHaveProperty(field);
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(ringClientForHousehold(f.hid)).rejects.toMatchObject({
      code: "RING_LINK_REQUIRED",
    });
  });
  it("expiry cleanup erases its bounded credential copy without claiming observed provider deletion", async () => {
    localIntegrationEnv();
    const f = await mediaFixture();
    const transport = mediaTransport(f.location);
    vi.stubGlobal("fetch", transport);
    const session = await startMedia(f.actor, f.visit.id, mediaOffer);
    const mediaKey = `MEDIA#${f.hid}#${session.mediaSessionId}`;
    const stored = await getItem(tables.runtime, mediaKey, "SESSION");
    await service.revokeRingAccount(f.oldAccount, f.doorId);
    const callsBeforeExpiry = transport.mock.calls.length;
    vi.spyOn(Date, "now").mockReturnValue(stored!.providerExpiresAt + 1);
    expect(
      await closePersistedMedia(f.hid, session.mediaSessionId!),
    ).toMatchObject({
      closed: true,
      providerCloseConfirmed: false,
      providerExpiryElapsed: true,
    });
    expect(transport).toHaveBeenCalledTimes(callsBeforeExpiry);
    expect(await getItem(tables.runtime, mediaKey, "SESSION")).toBeUndefined();
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.credentials,
    ).toBeUndefined();
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
  const clientIdentity = await getOrCreateRingClientIdentity(
    f.hid,
    f.userId,
    appOrigin,
  );
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
    clientIdentity,
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

describe("durable Ring server client identity", () => {
  it("converges concurrent creation and isolates resident, backend and household scopes", async () => {
    const f = await fixture();
    const identities = await Promise.all(
      Array.from({ length: 10 }, () =>
        getOrCreateRingClientIdentity(f.hid, f.userId, appOrigin),
      ),
    );
    expect(new Set(identities.map((item) => item.hardwareId)).size).toBe(1);
    expect(await loadRingClientIdentity(f.hid, f.userId, appOrigin)).toEqual(
      identities[0],
    );
    const other = await Promise.all([
      getOrCreateRingClientIdentity(f.hid, `${f.userId}-other`, appOrigin),
      getOrCreateRingClientIdentity(
        f.hid,
        f.userId,
        "https://other-backend.example.invalid",
      ),
      getOrCreateRingClientIdentity(`${f.hid}-other`, f.userId, appOrigin),
    ]);
    expect(
      new Set([...identities, ...other].map((item) => item.hardwareId)).size,
    ).toBe(4);
    await putItem(tables.config, {
      PK: f.PK,
      SK: `RING_CLIENT#${hashToken(f.userId)}#${hashToken(new URL(appOrigin).origin)}`,
      clientIdentity: { ...identities[0], hardwareId: "corrupted" },
    });
    await expect(
      getOrCreateRingClientIdentity(f.hid, f.userId, appOrigin),
    ).rejects.toMatchObject({ code: "RING_CLIENT_IDENTITY_REQUIRED" });
  });
  it("persists the identity before redirect and reuses it through OAuth exchange and completion", async () => {
    localIntegrationEnv();
    const f = await fixture();
    const started = await startRing(f.actor);
    const state = new URL(started.headers.get("Location")!).searchParams.get(
      "state",
    )!;
    const attempt = await getItem(
      tables.runtime,
      `RING_OAUTH#${hashToken(state)}`,
      "STATE",
    );
    const identity = await loadRingClientIdentity(f.hid, f.userId, appOrigin);
    expect(attempt?.clientIdentity).toEqual(identity);
    const transport = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("oauth.ring.com")
        ? tokenResponse()
        : String(input).includes("/v1/users/me")
          ? Response.json({ data: { type: "users", id: `account-${f.hid}` } })
          : Response.json({ status: "completed" }),
    );
    vi.stubGlobal("fetch", transport);
    const result = await finishRing(
      new Request(
        `https://localhost:3443/api/ring/callback?state=${state}&code=fixture-code`,
      ),
      f.actor,
    );
    expect(result.status).toBe(302);
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.clientIdentity,
    ).toEqual(identity);
    expect(transport).toHaveBeenCalledTimes(3);
    for (const [, init] of transport.mock.calls) {
      expect(new Headers(init?.headers).get("Hardware_Id")).toBe(
        identity.hardwareId,
      );
      expect(new Headers(init?.headers).get("User-Agent")).toBe(
        "CaptionDoor/0.1.0",
      );
    }
    await service.unlink(f.actor);
    const boot = await service.bootstrap(f.actor);
    await service.settings(f.actor, {
      ...boot.settings,
      consent: { ...boot.settings.consent, ring: true },
    });
    await startRing(f.actor);
    expect(await loadRingClientIdentity(f.hid, f.userId, appOrigin)).toEqual(
      identity,
    );
  });
  it("rejects a callback whose stored client identity changed before any provider request", async () => {
    localIntegrationEnv();
    const f = await oauthFixture();
    const key = { PK: `RING_OAUTH#${hashToken(f.attempt.state)}`, SK: "STATE" };
    const row = await getItem(tables.runtime, key.PK, key.SK);
    await putItem(tables.runtime, {
      ...row!,
      clientIdentity: { ...row!.clientIdentity, hardwareId: randomUUID() },
    });
    const transport = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", transport);
    await expect(finishRing(f.request, f.actor)).rejects.toMatchObject({
      code: "RING_OAUTH_STATE_INVALID",
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it("fences refresh if its bound client identity changes during token rotation", async () => {
    localIntegrationEnv();
    const f = await fixture();
    const before = await expiredLink(f);
    const replacement = await getOrCreateRingClientIdentity(
      f.hid,
      `${f.userId}-replacement`,
      appOrigin,
    );
    const transport = vi.fn<typeof fetch>(async () => {
      await db.send(
        new UpdateCommand({
          TableName: tables.config,
          Key: { PK: f.PK, SK: "INTEGRATION#ring" },
          UpdateExpression: "SET clientIdentity = :identity",
          ExpressionAttributeValues: { ":identity": replacement },
        }),
      );
      return tokenResponse();
    });
    vi.stubGlobal("fetch", transport);
    await expect(
      (await ringClientForHousehold(f.hid)).listDevices(),
    ).rejects.toMatchObject({ code: "RING_REFRESH_UNCONFIRMED" });
    expect(transport).toHaveBeenCalledTimes(1);
    const row = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(row?.clientIdentity).toEqual(replacement);
    expect(row?.credentials).toEqual(before);
    expect(row?.status).toBe("LINKED");
  });
  it("rejects missing live metadata and requires trusted Playground resident scope with durable reuse", async () => {
    localIntegrationEnv();
    const f = await fixture();
    await expiredLink(f);
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: { PK: f.PK, SK: "INTEGRATION#ring" },
        UpdateExpression: "REMOVE clientIdentity",
      }),
    );
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [] }),
    );
    vi.stubGlobal("fetch", transport);
    await expect(ringClientForHousehold(f.hid)).rejects.toMatchObject({
      code: "RING_CLIENT_IDENTITY_REQUIRED",
    });
    localIntegrationEnv("playground");
    await expect(ringClientForHousehold(f.hid)).rejects.toMatchObject({
      code: "RING_CLIENT_IDENTITY_REQUIRED",
    });
    expect(transport).not.toHaveBeenCalled();
    const scope = { residentId: f.userId, backendOrigin: appOrigin };
    const first = await ringClientForHousehold(f.hid, scope);
    const reconstructed = await ringClientForHousehold(f.hid, scope);
    expect(first.hardwareId).toBe(reconstructed.hardwareId);
    await first.listDevices();
    await reconstructed.listDevices();
    for (const [, init] of transport.mock.calls)
      expect(new Headers(init?.headers).get("Hardware_Id")).toBe(
        first.hardwareId,
      );
  });
});

describe("Ring identity revision checks", () => {
  it("accepts the same identity regardless of stored DynamoDB attribute order", async () => {
    localIntegrationEnv();
    const f = await fixture();
    await expiredLink(f);
    const identity = await loadRingClientIdentity(f.hid, f.userId, appOrigin);
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: { PK: f.PK, SK: "INTEGRATION#ring" },
        UpdateExpression: "SET clientIdentity = :identity",
        ExpressionAttributeValues: {
          ":identity": {
            backendOrigin: identity.backendOrigin,
            residentId: identity.residentId,
            hardwareId: identity.hardwareId,
          },
        },
      }),
    );
    const transport = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("oauth.ring.com")
        ? tokenResponse()
        : Response.json({ data: [] }),
    );
    vi.stubGlobal("fetch", transport);
    expect(await (await ringClientForHousehold(f.hid)).listDevices()).toEqual(
      [],
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      new Headers(transport.mock.calls[1][1]?.headers).get("Hardware_Id"),
    ).toBe(identity.hardwareId);
  });
  it("rejects an old client after relink identity changes without sending mixed identity and credentials", async () => {
    localIntegrationEnv();
    const f = await fixture();
    await expiredLink(f);
    const oldClient = await ringClientForHousehold(f.hid);
    const replacement = await getOrCreateRingClientIdentity(
      f.hid,
      `${f.userId}-new`,
      appOrigin,
    );
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: { PK: f.PK, SK: "INTEGRATION#ring" },
        UpdateExpression: "SET clientIdentity = :identity",
        ExpressionAttributeValues: { ":identity": replacement },
      }),
    );
    const transport = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", transport);
    await expect(oldClient.listDevices()).rejects.toMatchObject({
      code: "RING_ACCESS_CHANGED",
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
