import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, tables, service, getItem, putItem } from "@captiondoor/db";
import { presets } from "@captiondoor/domain";
import { ensureTables } from "../../scripts/setup-local";
import { CredentialCipher } from "../../packages/integrations/src/crypto";
import { getOrCreateRingClientIdentity } from "../../packages/integrations/src/ring-identity";
import { closePersistedMedia } from "../../packages/integrations/src/media-cleanup";
import { startMedia } from "../../apps/web/server/ring";
import { origin } from "../../apps/web/server/http";
const priorTables = vi.hoisted(() => {
  const names = [
    "CAPTIONDOOR_CONFIG_TABLE",
    "CAPTIONDOOR_VISITS_TABLE",
    "CAPTIONDOOR_RUNTIME_TABLE",
  ] as const;
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.CAPTIONDOOR_CONFIG_TABLE = "CaptionDoorMediaRaceTestConfig";
  process.env.CAPTIONDOOR_VISITS_TABLE = "CaptionDoorMediaRaceTestVisits";
  process.env.CAPTIONDOOR_RUNTIME_TABLE = "CaptionDoorMediaRaceTestRuntime";
  return before;
});
const key = Buffer.alloc(32, 17).toString("base64");
const cipher = () =>
  new CredentialCipher({
    mode: "development",
    keyBase64: key,
    nodeEnv: "test",
  });
const sec = () => Math.floor(Date.now() / 1000);
const offer =
  "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n";
function localProviderEnv() {
  vi.stubEnv("RING_MODE", "live");
  vi.stubEnv("CREDENTIAL_ENCRYPTION_MODE", "development");
  vi.stubEnv("DEV_CREDENTIAL_KEY", key);
  vi.stubEnv("RING_CLIENT_ID", "fictional-race-client");
  vi.stubEnv("RING_CLIENT_SECRET", "fictional-race-secret");
}
async function fixture() {
  localProviderEnv();
  const hid = `media-race-${randomUUID()}`,
    owner = `owner-${randomUUID()}`,
    member = `member-${randomUUID()}`,
    doorId = `door-${randomUUID()}`,
    accountId = `account-${randomUUID()}`,
    PK = `HOUSEHOLD#${hid}`;
  await putItem(tables.config, {
    PK,
    SK: "PROFILE",
    id: hid,
    name: "Fictional media race",
    settings: {
      retentionHours: 24,
      captionSize: 32,
      consent: { ring: true, transcription: true, sharing: true },
      presets,
    },
  });
  for (const [userId, role, name] of [
    [owner, "owner", "Alex fixture"],
    [member, "member", "Sam fixture"],
  ])
    await putItem(tables.config, {
      PK,
      SK: `MEMBER#${userId}`,
      userId,
      name,
      role,
      expiresAt: sec() + 3600,
      grants: {
        camera: true,
        captions: true,
        visitorText: true,
        membership: true,
      },
    });
  await putItem(tables.config, {
    PK,
    SK: `DOOR#${doorId}`,
    id: doorId,
    name: "Fictional door",
    householdId: hid,
    publicDoorId: `fictional-${randomUUID()}`,
    ringAccountId: accountId,
    ringDeviceId: doorId,
  });
  await putItem(tables.config, {
    PK: `RINGACCOUNT#${accountId}`,
    SK: "LOOKUP",
    householdId: hid,
    doorId,
    deviceId: doorId,
  });
  const identity = await getOrCreateRingClientIdentity(hid, owner, origin);
  const credentials = await cipher().encrypt(
    {
      accessToken: "fictional-race-access",
      refreshToken: "fictional-race-refresh",
      expiresAt: Date.now() + 3600_000,
      tokenType: "Bearer",
      scope: "ava.v1:read",
    },
    { householdId: hid, integrationId: "ring" },
  );
  await putItem(tables.config, {
    PK,
    SK: "INTEGRATION#ring",
    status: "LINKED",
    accountId,
    clientIdentity: identity,
    credentials,
  });
  const actor = (await service.createResidentSession(owner, hid)).actor,
    other = (await service.createResidentSession(member, hid)).actor;
  const pressed = await service.press({
    accountId,
    deviceId: doorId,
    eventId: randomUUID(),
    deliveryId: randomUUID(),
    source: "LIVE",
  });
  const { visit } = await service.command(
    actor,
    pressed.visit.id,
    { type: "claim", expectedVersion: pressed.visit.version },
    randomUUID(),
  );
  const location = `https://api.amazonvision.com/v1/devices/${encodeURIComponent(doorId)}/media/streaming/whep/sessions/fixture-${randomUUID()}`;
  return {
    hid,
    PK,
    owner,
    doorId,
    accountId,
    actor,
    other,
    visit,
    location,
    identity,
  };
}
function deferredProvider(
  f: Awaited<ReturnType<typeof fixture>>,
  failDelete = false,
) {
  let acknowledge!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/configurations"))
      return Response.json({
        data: { attributes: { e2e_encryption: { enabled: false } } },
      });
    if (url.endsWith("/whep/sessions") && init?.method === "POST") {
      acknowledge();
      await response;
      return new Response("v=0\r\ns=fictional-answer\r\n", {
        status: 201,
        headers: { Location: f.location },
      });
    }
    if (url === f.location && init?.method === "DELETE")
      return new Response(null, { status: failDelete ? 503 : 204 });
    throw new Error("Unexpected mocked provider operation");
  });
  vi.stubGlobal("fetch", transport);
  return {
    transport,
    started,
    release,
    setDeleteFailure(value: boolean) {
      failDelete = value;
    },
  };
}
async function current(f: Awaited<ReturnType<typeof fixture>>) {
  return (await service.getVisit(f.actor, f.visit.id)).visit;
}
async function pendingStart(
  f: Awaited<ReturnType<typeof fixture>>,
  transport: ReturnType<typeof deferredProvider>,
) {
  const result = startMedia(f.actor, f.visit.id, offer).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  await transport.started;
  const state = await current(f);
  expect(state.mediaStatus).toBe("CONNECTING");
  expect(state.mediaSessionId).toBeTruthy();
  return { result, mediaId: state.mediaSessionId!, state };
}
function deleteCalls(
  transport: ReturnType<typeof deferredProvider>["transport"],
) {
  return transport.mock.calls.filter(([, init]) => init?.method === "DELETE");
}
beforeAll(async () => {
  expect(tables).toEqual({
    config: "CaptionDoorMediaRaceTestConfig",
    visits: "CaptionDoorMediaRaceTestVisits",
    runtime: "CaptionDoorMediaRaceTestRuntime",
  });
  await ensureTables();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const [name, value] of Object.entries(priorTables)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
describe("delayed WHEP admission with real DynamoDB Local and mocked provider", () => {
  it("admits only current authority and retains a bounded DELETE-only envelope", async () => {
    const f = await fixture(),
      transport = deferredProvider(f),
      start = await pendingStart(f, transport);
    transport.release();
    const result = await start.result;
    expect(result.error).toBeUndefined();
    expect(result.value?.mediaSessionId).toBe(start.mediaId);
    const row = await getItem(
      tables.runtime,
      `MEDIA#${f.hid}#${start.mediaId}`,
      "SESSION",
    );
    expect(row?.cleanupExpiresAt).toBeLessThanOrEqual(row?.providerExpiresAt);
    expect(result.value?.expiresAt).toBeLessThanOrEqual(row?.cleanupExpiresAt);
    const clean = await cipher().decrypt(row!.cleanupCredentials, {
      householdId: f.hid,
      integrationId: "ring",
    });
    expect(clean).toMatchObject({
      purpose: "WHEP_DELETE",
      accessToken: "fictional-race-access",
      mediaSessionId: start.mediaId,
      deviceId: f.doorId,
    });
    expect(clean).not.toHaveProperty("refreshToken");
    await closePersistedMedia(f.hid, start.mediaId);
  });
  it("a handoff during POST rejects the late answer and closes only that provider session", async () => {
    const f = await fixture(),
      transport = deferredProvider(f),
      start = await pendingStart(f, transport);
    const pending = await service.command(
      f.actor,
      f.visit.id,
      {
        type: "handoff",
        targetUserId: f.other.userId,
        expectedVersion: start.state.version,
      },
      randomUUID(),
    );
    await service.command(
      f.other,
      f.visit.id,
      { type: "accept", expectedVersion: pending.visit.version },
      randomUUID(),
    );
    expect(
      (await closePersistedMedia(f.hid, start.mediaId)).alreadyAbsent,
    ).toBe(true);
    transport.release();
    const result = await start.result;
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ code: "MEDIA_STALE" });
    expect(deleteCalls(transport.transport)).toHaveLength(1);
    expect(
      await getItem(
        tables.runtime,
        `MEDIA#${f.hid}#${start.mediaId}`,
        "SESSION",
      ),
    ).toBeUndefined();
    const state = await current(f);
    expect(state.handlerId).toBe(f.other.userId);
    expect(state.mediaSessionId).toBeUndefined();
  });
  it("revocation during POST cannot return SDP or resurrect credentials and uses the prepared access-only DELETE", async () => {
    const f = await fixture(),
      transport = deferredProvider(f),
      start = await pendingStart(f, transport);
    await service.revokeRingAccount(f.accountId);
    expect(
      (await closePersistedMedia(f.hid, start.mediaId)).alreadyAbsent,
    ).toBe(true);
    transport.release();
    const result = await start.result;
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ code: "MEDIA_STALE" });
    const calls = deleteCalls(transport.transport);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(f.location);
    expect(new Headers(calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer fictional-race-access",
    );
    expect(new Headers(calls[0][1]?.headers).get("Hardware_Id")).toBe(
      f.identity.hardwareId,
    );
    const integration = await getItem(tables.config, f.PK, "INTEGRATION#ring");
    expect(integration?.status).toBe("REVOKED");
    expect(integration?.credentials).toBeUndefined();
    expect(
      transport.transport.mock.calls.some(([url]) =>
        String(url).includes("oauth.ring.com"),
      ),
    ).toBe(false);
    expect(
      await getItem(
        tables.runtime,
        `MEDIA#${f.hid}#${start.mediaId}`,
        "SESSION",
      ),
    ).toBeUndefined();
  });
  it("failed DELETE after revocation leaves only bounded cleanup material and a durable retry", async () => {
    const f = await fixture(),
      transport = deferredProvider(f, true),
      start = await pendingStart(f, transport);
    await service.revokeRingAccount(f.accountId);
    const writes = vi.spyOn(db, "send");
    transport.release();
    const result = await start.result;
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ code: "MEDIA_STALE" });
    const row = await getItem(
      tables.runtime,
      `MEDIA#${f.hid}#${start.mediaId}`,
      "SESSION",
    );
    expect(row?.cleanupExpiresAt).toBeGreaterThan(Date.now());
    expect(row?.cleanupExpiresAt).toBeLessThanOrEqual(row?.providerExpiresAt);
    const clean = await cipher().decrypt(row!.cleanupCredentials, {
      householdId: f.hid,
      integrationId: "ring",
    });
    expect(clean).not.toHaveProperty("refreshToken");
    expect(clean).not.toHaveProperty("clientSecret");
    const cleanupJob = writes.mock.calls
      .flatMap(([command]) =>
        command instanceof TransactWriteCommand
          ? command.input.TransactItems || []
          : [],
      )
      .find(
        (item) =>
          item.Put?.Item?.type === "RING_MEDIA_CLOSE" &&
          item.Put.Item.householdId === f.hid &&
          item.Put.Item.mediaSessionId === start.mediaId,
      )?.Put?.Item;
    expect(cleanupJob).toBeTruthy();
    const persistedJob = await getItem(
      tables.runtime,
      cleanupJob!.PK,
      cleanupJob!.SK,
    );
    expect(persistedJob).toMatchObject({
      type: "RING_MEDIA_CLOSE",
      status: "READY",
      householdId: f.hid,
      mediaSessionId: start.mediaId,
    });
    transport.setDeleteFailure(false);
    expect(
      (await closePersistedMedia(f.hid, start.mediaId)).providerCloseConfirmed,
    ).toBe(true);
    expect(
      await getItem(
        tables.runtime,
        `MEDIA#${f.hid}#${start.mediaId}`,
        "SESSION",
      ),
    ).toBeUndefined();
    expect(
      (await getItem(tables.config, f.PK, "INTEGRATION#ring"))?.credentials,
    ).toBeUndefined();
  });
  it("an expired app session during POST cannot receive the provider answer", async () => {
    const f = await fixture(),
      transport = deferredProvider(f),
      start = await pendingStart(f, transport);
    await db.send(
      new UpdateCommand({
        TableName: tables.runtime,
        Key: { PK: `SESSION#${f.actor.sessionId}`, SK: "SESSION" },
        UpdateExpression: "SET expiresAt = :past",
        ExpressionAttributeValues: { ":past": sec() - 1 },
      }),
    );
    transport.release();
    const result = await start.result;
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(deleteCalls(transport.transport)).toHaveLength(1);
    expect(
      await getItem(
        tables.runtime,
        `MEDIA#${f.hid}#${start.mediaId}`,
        "SESSION",
      ),
    ).toBeUndefined();
  });
  it("camera permission withdrawal after fresh reads still fences the admission transaction", async () => {
    const f = await fixture(),
      transport = deferredProvider(f),
      start = await pendingStart(f, transport);
    const send = db.send.bind(db);
    let changed = false;
    vi.spyOn(db, "send").mockImplementation((async (command: any) => {
      if (
        !changed &&
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some(
          (item) => item.Put?.Item?.PK === `MEDIA#${f.hid}#${start.mediaId}`,
        ) &&
        command.input.TransactItems.some((item) => item.ConditionCheck)
      ) {
        changed = true;
        await send(
          new UpdateCommand({
            TableName: tables.config,
            Key: { PK: f.PK, SK: `MEMBER#${f.owner}` },
            UpdateExpression: "SET grants.camera = :no",
            ExpressionAttributeValues: { ":no": false },
          }),
        );
      }
      return send(command);
    }) as typeof db.send);
    transport.release();
    const result = await start.result;
    expect(changed).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ code: "MEDIA_STALE" });
    expect(deleteCalls(transport.transport)).toHaveLength(1);
    expect(
      await getItem(
        tables.runtime,
        `MEDIA#${f.hid}#${start.mediaId}`,
        "SESSION",
      ),
    ).toBeUndefined();
  });
});
