import { randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
const previous = vi.hoisted(() => {
  const names = [
    "CAPTIONDOOR_CONFIG_TABLE",
    "CAPTIONDOOR_VISITS_TABLE",
    "CAPTIONDOOR_RUNTIME_TABLE",
    "APP_ORIGIN",
  ];
  const old = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.CAPTIONDOOR_CONFIG_TABLE = "CaptionDoorProviderSmokeTestConfig";
  process.env.CAPTIONDOOR_VISITS_TABLE = "CaptionDoorProviderSmokeTestVisits";
  process.env.CAPTIONDOOR_RUNTIME_TABLE = "CaptionDoorProviderSmokeTestRuntime";
  process.env.APP_ORIGIN = "http://127.0.0.1:3410";
  return old;
});
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  db,
  tables,
  getItem,
  putItem,
  queryPK,
  service,
  hashToken,
} from "@captiondoor/db";
import { presets } from "@captiondoor/domain";
import { ensureTables } from "../../scripts/setup-local";
import { POST, GET } from "../../apps/web/app/api/[...path]/route";
import {
  pressProviderSmoke,
  providerSmokeRuntimeEnabled,
} from "../../apps/web/server/provider-smoke";
const origin = "http://127.0.0.1:3410";
const sec = () => Math.floor(Date.now() / 1000);
async function fixture() {
  const hid = `provider-smoke-${randomUUID()}`,
    owner = `owner-${randomUUID()}`,
    member = `member-${randomUUID()}`,
    doorId = `door-${randomUUID()}`,
    deviceId = `provider-device-${randomUUID()}`,
    accountId = `provider-account-${randomUUID()}`,
    publicDoorId = `public-${randomUUID()}`;
  const PK = `HOUSEHOLD#${hid}`,
    grants = {
      camera: true,
      captions: true,
      visitorText: true,
      membership: true,
    };
  await Promise.all([
    putItem(tables.config, {
      PK,
      SK: "PROFILE",
      id: hid,
      name: "Fictional provider-smoke household",
      settings: {
        retentionHours: 24,
        captionSize: 32,
        consent: { ring: true, transcription: false, sharing: false },
        presets,
      },
    }),
    ...[
      { id: owner, role: "owner" },
      { id: member, role: "member" },
    ].map((user) =>
      putItem(tables.config, {
        PK,
        SK: `MEMBER#${user.id}`,
        userId: user.id,
        name: "Fictional resident",
        role: user.role,
        expiresAt: sec() + 3600,
        grants,
      }),
    ),
    putItem(tables.config, {
      PK,
      SK: `DOOR#${doorId}`,
      id: doorId,
      householdId: hid,
      name: "Fictional selected door",
      publicDoorId,
      ringAccountId: accountId,
      ringDeviceId: deviceId,
    }),
    putItem(tables.config, {
      PK: `RINGACCOUNT#${accountId}`,
      SK: "LOOKUP",
      householdId: hid,
      doorId,
      deviceId,
    }),
    putItem(tables.config, {
      PK: `PUBLICDOOR#${publicDoorId}`,
      SK: "LOOKUP",
      householdId: hid,
      doorId,
    }),
  ]);
  const session = await service.createResidentSession(owner, hid),
    other = await service.createResidentSession(member, hid);
  return {
    hid,
    owner,
    member,
    PK,
    doorId,
    deviceId,
    accountId,
    publicDoorId,
    session,
    other,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function send(
  f: Fixture,
  eventId = randomUUID(),
  overrides: {
    body?: unknown;
    token?: string;
    csrf?: string;
    origin?: string;
    key?: string;
  } = {},
) {
  const response = await POST(
    new Request(`${origin}/api/provider-smoke/press`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: overrides.origin ?? origin,
        Cookie: `cd_session=${overrides.token ?? f.session.token}`,
        "X-CSRF-Token": overrides.csrf ?? f.session.csrf,
        "Idempotency-Key": overrides.key ?? randomUUID(),
      },
      body: JSON.stringify(overrides.body ?? { eventId }),
    }),
    { params: Promise.resolve({ path: ["provider-smoke", "press"] }) },
  );
  return { status: response.status, body: await response.json() };
}
async function noEvent(f: Fixture, eventId: string) {
  expect(
    (await getItem(tables.config, f.PK, `DOOR#${f.doorId}`))?.activeVisitId,
  ).toBeUndefined();
  expect(
    await getItem(
      tables.runtime,
      `SEMANTIC#${f.accountId}#${hashToken(`provider-smoke:${eventId}`)}`,
      "EVENT",
    ),
  ).toBeUndefined();
}
beforeAll(async () => {
  expect(tables).toEqual({
    config: "CaptionDoorProviderSmokeTestConfig",
    visits: "CaptionDoorProviderSmokeTestVisits",
    runtime: "CaptionDoorProviderSmokeTestRuntime",
  });
  await ensureTables();
});
beforeEach(() => {
  for (const [key, value] of Object.entries({
    NODE_ENV: "test",
    CAPTIONDOOR_ENV: "local",
    CAPTIONDOOR_DB_MODE: "local",
    AUTH_MODE: "demo",
    RING_MODE: "playground",
    CAPTIONDOOR_PROVIDER_SMOKE: "1",
    APP_ORIGIN: origin,
    CAPTIONDOOR_CONFIG_TABLE: tables.config,
    CAPTIONDOOR_VISITS_TABLE: tables.visits,
    CAPTIONDOOR_RUNTIME_TABLE: tables.runtime,
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("A provider request is forbidden in this Local bridge test.");
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
describe("honest guarded local Playground event feeder", () => {
  it("creates one durable LOCAL visit from server-selected mapping and deduplicates semantic/delivery retries without provider calls", async () => {
    const f = await fixture(),
      eventId = randomUUID(),
      key = randomUUID();
    const first = await send(f, eventId, { key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      localSimulation: true,
      eventSource: "LOCAL",
      duplicate: false,
      visit: {
        householdId: f.hid,
        doorId: f.doorId,
        status: "UNCLAIMED",
        eventSource: "LOCAL",
        mediaSource: "NONE",
        transcriptSource: "NONE",
        version: 1,
      },
    });
    const second = await send(f, eventId, { key: randomUUID() });
    expect(second.body).toMatchObject({
      duplicate: true,
      visit: { id: first.body.visit.id, version: 1 },
    });
    const delivery = await send(f, randomUUID(), { key });
    expect(delivery.body).toMatchObject({
      duplicate: true,
      visit: { id: first.body.visit.id, version: 1 },
    });
    const events = await queryPK(
      tables.visits,
      `HOUSEHOLD#${f.hid}#VISIT#${first.body.visit.id}`,
      { prefix: "EVENT#" },
    );
    expect(events.items).toHaveLength(1);
    expect(events.items[0].text).toContain("LOCAL simulated");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("health advertises only the nonsecret strict active scope and rejects changed captured table configuration", async () => {
    expect(providerSmokeRuntimeEnabled()).toBe(true);
    const health = await GET(new Request(`${origin}/api/health`), {
      params: Promise.resolve({ path: ["health"] }),
    });
    const info = await health.json();
    expect(info.providerSmoke).toBe(true);
    expect(info.providerSmokeTablePrefix).toBe("CaptionDoorProviderSmokeTest");
    expect(info).not.toHaveProperty("token");
    expect(info).not.toHaveProperty("tables");
    for (const [key, value] of Object.entries({
      CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmokeOtherConfig",
      CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmokeOtherVisits",
      CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmokeOtherRuntime",
    }))
      vi.stubEnv(key, value);
    expect(providerSmokeRuntimeEnabled()).toBe(false);
    const disabledHealth = await GET(new Request(`${origin}/api/health`), {
      params: Promise.resolve({ path: ["health"] }),
    });
    expect(await disabledHealth.json()).toMatchObject({ providerSmoke: false });
    const spy = vi.spyOn(db, "send"),
      f = {} as Fixture;
    const denied = await send(f, randomUUID(), {
      token: "unused",
      csrf: "unused",
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PROVIDER_SMOKE_DISABLED");
    expect(spy).not.toHaveBeenCalled();
  });
  it.each([
    { CAPTIONDOOR_PROVIDER_SMOKE: "0" },
    {
      CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorConfig",
      CAPTIONDOOR_VISITS_TABLE: "CaptionDoorVisits",
      CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorRuntime",
    },
  ])(
    "rejects normal tables or disabled bridge before session/database work: %j",
    async (env) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const spy = vi.spyOn(db, "send");
      const result = await send({} as Fixture, randomUUID(), {
        token: "unused",
        csrf: "unused",
      });
      expect(result.status).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    },
  );
  it("rejects member/guest sessions, forged identity fields, missing idempotency, wrong origin and invalid CSRF", async () => {
    const f = await fixture(),
      eventId = randomUUID(),
      guest = await service.createGuest(f.publicDoorId);
    const cases = [
      { token: f.other.token, csrf: f.other.csrf },
      { token: guest.token, csrf: guest.csrf },
      { body: { eventId, householdId: "forged" } },
      { body: { eventId: "not-a-uuid" } },
      { key: "" },
      { origin: "https://untrusted.example.invalid" },
      { csrf: "wrong" },
    ];
    for (const overrides of cases) {
      const result = await send(f, eventId, overrides);
      expect([400, 403]).toContain(result.status);
    }
    await noEvent(f, eventId);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects withdrawn consent and selected mapping belonging to another household", async () => {
    const f = await fixture(),
      eventId = randomUUID();
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: { PK: f.PK, SK: "PROFILE" },
        UpdateExpression: "SET settings.consent.ring = :no",
        ExpressionAttributeValues: { ":no": false },
      }),
    );
    expect((await send(f, eventId)).body.error.code).toBe("CONSENT_REQUIRED");
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: { PK: f.PK, SK: "PROFILE" },
        UpdateExpression: "SET settings.consent.ring = :yes",
        ExpressionAttributeValues: { ":yes": true },
      }),
    );
    await putItem(tables.config, {
      PK: `RINGACCOUNT#${f.accountId}`,
      SK: "LOOKUP",
      householdId: "different-fictional-household",
      doorId: f.doorId,
      deviceId: f.deviceId,
    });
    expect((await send(f, eventId)).body.error.code).toBe(
      "RING_SELECTION_REQUIRED",
    );
    await noEvent(f, eventId);
  });
  it.each(["consent", "role", "grant", "session"] as const)(
    "atomically fences %s withdrawal between owner checks and event transaction",
    async (kind) => {
      const f = await fixture(),
        eventId = randomUUID(),
        original = db.send.bind(db);
      let changed = false;
      vi.spyOn(db, "send").mockImplementation((async (command: any) => {
        if (
          !changed &&
          command instanceof TransactWriteCommand &&
          command.input.TransactItems?.some(
            (item: any) =>
              item.Put?.TableName === tables.visits &&
              item.Put?.Item.SK === "STATE",
          )
        ) {
          changed = true;
          const key =
            kind === "session"
              ? { PK: `SESSION#${f.session.actor.sessionId}`, SK: "SESSION" }
              : {
                  PK: f.PK,
                  SK: kind === "consent" ? "PROFILE" : `MEMBER#${f.owner}`,
                };
          const expression =
            kind === "consent"
              ? "SET settings.consent.ring = :value"
              : kind === "role"
                ? "SET #role = :value"
                : kind === "grant"
                  ? "SET grants.membership = :value"
                  : "SET expiresAt = :value";
          await original(
            new UpdateCommand({
              TableName: kind === "session" ? tables.runtime : tables.config,
              Key: key,
              UpdateExpression: expression,
              ...(kind === "role"
                ? { ExpressionAttributeNames: { "#role": "role" } }
                : {}),
              ExpressionAttributeValues: {
                ":value":
                  kind === "role" ? "member" : kind === "session" ? 0 : false,
              },
            }),
          );
        }
        return original(command);
      }) as any);
      const result = await send(f, eventId);
      expect(changed).toBe(true);
      expect([401, 403]).toContain(result.status);
      await noEvent(f, eventId);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("requires trusted same-tenant owner even when the internal press method is called directly", async () => {
    const f = await fixture(),
      other = await fixture(),
      eventId = randomUUID();
    await expect(
      service.press({
        accountId: f.accountId,
        deviceId: f.deviceId,
        eventId,
        deliveryId: randomUUID(),
        source: "LOCAL",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.press({
        accountId: f.accountId,
        deviceId: f.deviceId,
        eventId,
        deliveryId: randomUUID(),
        source: "LOCAL",
        localActor: other.session.actor,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await noEvent(f, eventId);
  });
  it("does not relabel a pre-existing PLAYGROUND-provenance fixture visit as a local event", async () => {
    const f = await fixture(),
      visit = (
        await service.press({
          accountId: f.accountId,
          deviceId: f.deviceId,
          eventId: randomUUID(),
          deliveryId: randomUUID(),
          source: "PLAYGROUND",
        })
      ).visit;
    const result = await send(f);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("PROVIDER_SMOKE_ACTIVE_VISIT");
    const stored = await getItem(
      tables.visits,
      `HOUSEHOLD#${f.hid}#VISIT#${visit.id}`,
      "STATE",
    );
    expect(stored?.eventSource).toBe("PLAYGROUND");
    expect(stored?.version).toBe(1);
  });
});
