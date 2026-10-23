import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
const previous = vi.hoisted(() => {
  const values = {
    CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmoke20261022Config",
    CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmoke20261022Visits",
    CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmoke20261022Runtime",
    APP_ORIGIN: "http://127.0.0.1:3410",
  };
  const prior = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  return prior;
});
import {
  DeleteCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  db,
  tables,
  getItem,
  putItem,
  queryPK,
  service,
  visitPK,
} from "@captiondoor/db";
import { presets, rootSmokeConfig } from "@captiondoor/domain";
import { ensureTables } from "../../scripts/setup-local";
const scopePK = `PROVIDER_SMOKE#${rootSmokeConfig.scope}`,
  ledgerKey = { PK: scopePK, SK: "BUDGET" };
const sec = () => Math.floor(Date.now() / 1000);
const caseHouseholds = new Set<string>();
async function fixture() {
  const hid = `root-smoke-test-${randomUUID()}`,
    userId = `resident-${randomUUID()}`,
    visitId = randomUUID(),
    leaseId = randomUUID(),
    mediaSessionId = randomUUID(),
    PK = `HOUSEHOLD#${hid}`;
  caseHouseholds.add(hid);
  await putItem(tables.config, {
    PK,
    SK: "PROFILE",
    id: hid,
    settings: {
      retentionHours: 24,
      captionSize: 32,
      presets,
      consent: { ring: true, transcription: true, sharing: false },
    },
  });
  await putItem(tables.config, {
    PK,
    SK: `MEMBER#${userId}`,
    userId,
    name: "Fictional smoke resident",
    role: "owner",
    expiresAt: sec() + 3600,
    grants: {
      camera: true,
      captions: true,
      visitorText: true,
      membership: true,
    },
  });
  const session = await service.createResidentSession(userId, hid),
    pk = visitPK(hid, visitId);
  const audioLease = {
    id: leaseId,
    holderId: userId,
    epoch: 1,
    expiresAt: sec() + 60,
  };
  await putItem(tables.visits, {
    PK: pk,
    SK: "STATE",
    id: visitId,
    householdId: hid,
    doorId: "fictional-door",
    doorName: "Fictional door",
    status: "CLAIMED",
    version: 2,
    handlerId: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: sec() + 3600,
    mediaStatus: "LIVE",
    mediaSessionId,
    mediaExpiresAt: Date.now() + 60000,
    audioLease,
    eventSource: "LOCAL",
    mediaSource: "RING",
    transcriptSource: "AWS",
  });
  await putItem(tables.runtime, {
    PK: pk,
    SK: "CAPTURE",
    ...audioLease,
    mediaSessionId,
    householdId: hid,
    visitId,
    sessionId: session.actor.sessionId,
  });
  return {
    hid,
    userId,
    visitId,
    pk,
    PK,
    session,
    fence: { leaseId, mediaSessionId },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const reserve = (f: Fixture) =>
  service.reserveRootSmokeAttempt(f.session.actor, f.visitId, f.fence);
async function noBudget() {
  expect(await getItem(tables.runtime, scopePK, "BUDGET")).toBeUndefined();
}
beforeAll(async () => {
  expect(tables.runtime).toBe("CaptionDoorProviderSmoke20261022Runtime");
  await ensureTables();
  if (await getItem(tables.runtime, scopePK, "BUDGET"))
    throw new Error(
      "Existing fixed-scope budget found; this test refuses to reset or change it.",
    );
});
beforeEach(() => {
  caseHouseholds.clear();
  for (const [name, value] of Object.entries({
    NODE_ENV: "test",
    CAPTIONDOOR_ENV: "local",
    CAPTIONDOOR_DB_MODE: "local",
    AUTH_MODE: "demo",
    RING_MODE: "playground",
    CAPTIONDOOR_PROVIDER_SMOKE: "1",
    APP_ORIGIN: "http://127.0.0.1:3410",
    DYNAMODB_ENDPOINT: "http://127.0.0.1:8410",
    CAPTIONDOOR_CONFIG_TABLE: tables.config,
    CAPTIONDOOR_VISITS_TABLE: tables.visits,
    CAPTIONDOOR_RUNTIME_TABLE: tables.runtime,
    CAPTIONDOOR_ROOT_SMOKE: "1",
    CAPTIONDOOR_ROOT_SMOKE_APPROVAL: rootSmokeConfig.scope,
    CAPTIONDOOR_SMOKE_APPROVAL: "captions",
    TRANSCRIBE_MODE: "aws",
    TRANSCRIBE_AWS_ACCOUNT_ID: rootSmokeConfig.accountId,
    TRANSCRIBE_AWS_REGION: rootSmokeConfig.region,
  }))
    vi.stubEnv(name, value);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error(
        "Provider request forbidden in root ledger integration test.",
      );
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Delete only this case's random fictional household records, never a prior real/test budget.
  const budget = await getItem(tables.runtime, scopePK, "BUDGET");
  if (budget && caseHouseholds.has(budget.householdId))
    await db.send(
      new DeleteCommand({
        TableName: tables.runtime,
        Key: ledgerKey,
        ConditionExpression: "householdId = :hid",
        ExpressionAttributeValues: { ":hid": budget.householdId },
      }),
    );
  const attempts = await queryPK(tables.runtime, scopePK, {
    prefix: "ATTEMPT#",
    limit: 100,
  });
  for (const row of attempts.items)
    if (caseHouseholds.has(row.householdId))
      await db.send(
        new DeleteCommand({
          TableName: tables.runtime,
          Key: { PK: row.PK, SK: row.SK },
          ConditionExpression: "householdId = :hid",
          ExpressionAttributeValues: { ":hid": row.householdId },
        }),
      );
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
describe("durable conservative local root smoke reservations", () => {
  it("reads zero budget without creating or binding a record, then reserves one bounded content-free attempt", async () => {
    const f = await fixture();
    expect(await service.getRootSmokeBudget(f.session.actor)).toMatchObject({
      reservedSeconds: 0,
      attempts: 0,
      remainingSeconds: 90,
      maxMicrousd: 10000000,
      conservativeReservation: true,
    });
    await noBudget();
    const receipt = await reserve(f);
    expect(receipt).toMatchObject({
      scope: rootSmokeConfig.scope,
      accountId: rootSmokeConfig.accountId,
      region: "us-east-1",
      householdId: f.hid,
      maxSeconds: 30,
      reservedSeconds: 30,
      cumulativeReservedSeconds: 30,
      cumulativeEstimatedMicrousd: 12000,
    });
    expect(receipt.expiresAt).toBeGreaterThan(receipt.issuedAt);
    expect(receipt.expiresAt).toBeLessThanOrEqual(receipt.issuedAt + 30000);
    const row = await getItem(tables.runtime, scopePK, "BUDGET"),
      attempt = await getItem(
        tables.runtime,
        scopePK,
        `ATTEMPT#${receipt.attemptId}`,
      );
    expect(row).not.toHaveProperty("expiresAt");
    expect(attempt).not.toHaveProperty("expiresAt");
    expect(attempt?.deadlineAt).toBe(receipt.expiresAt);
    const fields = [...Object.keys(row!), ...Object.keys(attempt!)];
    for (const field of [
      "csrf",
      "token",
      "secret",
      "caption",
      "text",
      "audioChunk",
      "credentials",
    ])
      expect(fields).not.toContain(field);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("atomically limits concurrent attempts to three and retains exhaustion after module restart", async () => {
    const f = await fixture(),
      results = await Promise.allSettled(
        Array.from({ length: 4 }, () => reserve(f)),
      );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const budget = await service.getRootSmokeBudget(f.session.actor);
    expect(budget).toMatchObject({
      attempts: 3,
      reservedSeconds: 90,
      reservedMicrousd: 36000,
      remainingSeconds: 0,
    });
    vi.resetModules();
    const restarted = await import("../../packages/db/src/root-smoke");
    expect(await restarted.getRootSmokeBudget(f.session.actor)).toEqual(budget);
    await expect(
      restarted.reserveRootSmokeAttempt(f.session.actor, f.visitId, f.fence),
    ).rejects.toMatchObject({ code: "ROOT_SMOKE_BUDGET_EXHAUSTED" });
  });
  it("keeps an uncertain attempt consumed instead of refunding or reopening the fixed scope", async () => {
    const f = await fixture(),
      original = db.send.bind(db);
    let committed = false;
    vi.spyOn(db, "send").mockImplementation((async (command: any) => {
      const result = await original(command);
      if (!committed && command instanceof TransactWriteCommand) {
        committed = true;
        throw Error(
          "Synthetic lost response after committed Local transaction.",
        );
      }
      return result;
    }) as any);
    await expect(reserve(f)).rejects.toThrow(/Synthetic lost response/);
    vi.restoreAllMocks();
    expect(await service.getRootSmokeBudget(f.session.actor)).toMatchObject({
      reservedSeconds: 30,
      attempts: 1,
    });
    expect((await reserve(f)).cumulativeReservedSeconds).toBe(60);
  });
  it("binds the first reservation to its household and denies cross-tenant reads and writes", async () => {
    const first = await fixture(),
      other = await fixture();
    await reserve(first);
    await expect(
      service.getRootSmokeBudget(other.session.actor),
    ).rejects.toMatchObject({ code: "ROOT_SMOKE_SCOPE_MISMATCH" });
    await expect(reserve(other)).rejects.toMatchObject({
      code: "ROOT_SMOKE_SCOPE_MISMATCH",
    });
    expect(
      (await service.getRootSmokeBudget(first.session.actor)).reservedSeconds,
    ).toBe(30);
  });
  it("refuses corrupt ledger counters rather than repairing or resetting them", async () => {
    const f = await fixture();
    await reserve(f);
    const row = await getItem(tables.runtime, scopePK, "BUDGET");
    await putItem(tables.runtime, { ...row!, reservedSeconds: 31 });
    await expect(
      service.getRootSmokeBudget(f.session.actor),
    ).rejects.toMatchObject({ code: "ROOT_SMOKE_LEDGER_INVALID" });
    await expect(reserve(f)).rejects.toMatchObject({
      code: "ROOT_SMOKE_LEDGER_INVALID",
    });
    expect(
      (await queryPK(tables.runtime, scopePK, { prefix: "ATTEMPT#" })).items,
    ).toHaveLength(1);
  });
  it("caps permit expiry to the already-authorized media/lease deadline", async () => {
    const f = await fixture(),
      deadline = Date.now() + 7000;
    const row = await getItem(tables.visits, f.pk, "STATE");
    await putItem(tables.visits, { ...row!, mediaExpiresAt: deadline });
    expect((await reserve(f)).expiresAt).toBe(deadline);
    expect(
      (await service.getRootSmokeBudget(f.session.actor)).reservedSeconds,
    ).toBe(30);
  });
  it.each(["consent", "camera", "session", "handler", "capture"] as const)(
    "fences %s changes between initial capture check and transaction without consuming budget",
    async (kind) => {
      const f = await fixture(),
        original = db.send.bind(db);
      let changed = false;
      vi.spyOn(db, "send").mockImplementation((async (command: any) => {
        if (!changed && command instanceof TransactWriteCommand) {
          changed = true;
          const TableName =
            kind === "session" || kind === "capture"
              ? tables.runtime
              : kind === "handler"
                ? tables.visits
                : tables.config;
          const Key =
            kind === "session"
              ? { PK: `SESSION#${f.session.actor.sessionId}`, SK: "SESSION" }
              : kind === "capture"
                ? { PK: f.pk, SK: "CAPTURE" }
                : kind === "handler"
                  ? { PK: f.pk, SK: "STATE" }
                  : {
                      PK: f.PK,
                      SK: kind === "consent" ? "PROFILE" : `MEMBER#${f.userId}`,
                    };
          await original(
            new UpdateCommand({
              TableName,
              Key,
              UpdateExpression:
                kind === "consent"
                  ? "SET settings.consent.transcription = :v"
                  : kind === "camera"
                    ? "SET grants.camera = :v"
                    : kind === "handler"
                      ? "SET handlerId = :v"
                      : "SET expiresAt = :v",
              ExpressionAttributeValues: {
                ":v":
                  kind === "consent" || kind === "camera"
                    ? false
                    : kind === "handler"
                      ? "different-handler"
                      : 0,
              },
            }),
          );
        }
        return original(command);
      }) as any);
      await expect(reserve(f)).rejects.toBeInstanceOf(Error);
      expect(changed).toBe(true);
      await noBudget();
    },
  );
  it("refuses runtime policy changes before accessing or reserving budget", async () => {
    const f = await fixture();
    vi.stubEnv("CAPTIONDOOR_ROOT_SMOKE", "0");
    await expect(reserve(f)).rejects.toMatchObject({
      code: "ROOT_SMOKE_DISABLED",
    });
    await noBudget();
  });
});
