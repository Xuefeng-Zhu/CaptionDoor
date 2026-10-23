import { beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.CAPTIONDOOR_CONFIG_TABLE = "CaptionDoorPersistenceTestConfig";
  process.env.CAPTIONDOOR_VISITS_TABLE = "CaptionDoorPersistenceTestVisits";
  process.env.CAPTIONDOOR_RUNTIME_TABLE = "CaptionDoorPersistenceTestRuntime";
});
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  service,
  db,
  tables,
  getItem,
  queryPK,
  queryIndex,
  putItem,
  makeJob,
  visitPK,
  threadPK,
  householdPK,
  hashToken,
  pad,
  type Row,
} from "@captiondoor/db";
import { presets, type Actor, type Visit } from "@captiondoor/domain";
import { ensureTables } from "../../scripts/setup-local";
import { randomUUID } from "node:crypto";
const sec = () => Math.floor(Date.now() / 1000);
const key = () => randomUUID();
async function fixture() {
  const hid = `test-${key()}`,
    owner = `owner-${key()}`,
    other = `member-${key()}`,
    accountId = `account-${key()}`,
    deviceId = `door-${key()}`,
    publicDoorId = `public-${key()}`;
  const PK = householdPK(hid),
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
      name: "Test household",
      settings: {
        retentionHours: 24,
        captionSize: 32,
        consent: { ring: true, transcription: true, sharing: true },
        presets,
      },
    }),
    ...[
      { id: owner, name: "Owner", role: "owner" },
      { id: other, name: "Member", role: "member" },
    ].map((u) =>
      putItem(tables.config, {
        PK,
        SK: `MEMBER#${u.id}`,
        userId: u.id,
        name: u.name,
        role: u.role,
        expiresAt: sec() + 3600,
        grants,
      }),
    ),
    putItem(tables.config, {
      PK,
      SK: `DOOR#${deviceId}`,
      id: deviceId,
      name: "Test front door",
      publicDoorId,
      householdId: hid,
      ringAccountId: accountId,
    }),
    putItem(tables.config, {
      PK: `RINGACCOUNT#${accountId}`,
      SK: "LOOKUP",
      householdId: hid,
      deviceId,
      doorId: deviceId,
    }),
    putItem(tables.config, {
      PK: `PUBLICDOOR#${publicDoorId}`,
      SK: "LOOKUP",
      householdId: hid,
      doorId: deviceId,
    }),
  ]);
  await Promise.all(
    [owner, other].map((userId) =>
      putItem(tables.config, {
        PK: `USER#${userId}`,
        SK: "LOOKUP",
        userId,
        householdId: hid,
      }),
    ),
  );
  const a = (await service.createResidentSession(owner, hid)).actor,
    b = (await service.createResidentSession(other, hid)).actor;
  const press = () =>
    service.press({
      accountId,
      deviceId,
      eventId: key(),
      deliveryId: key(),
      source: "LOCAL",
    });
  const visit = (await press()).visit;
  return {
    hid,
    owner,
    other,
    accountId,
    deviceId,
    publicDoorId,
    a,
    b,
    visit,
    press,
  };
}
async function claimed(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await service.command(
      f.a,
      f.visit.id,
      { type: "claim", expectedVersion: f.visit.version },
      key(),
    )
  ).visit;
}
async function capture(f: Awaited<ReturnType<typeof fixture>>) {
  let v = await claimed(f);
  v = (
    await service.command(
      f.a,
      v.id,
      {
        type: "media",
        action: "start",
        consent: true,
        expectedVersion: v.version,
      },
      key(),
    )
  ).visit;
  return (
    await service.command(
      f.a,
      v.id,
      { type: "capture", consent: true, expectedVersion: v.version },
      key(),
    )
  ).visit;
}
beforeAll(async () => {
  await ensureTables();
}, 30000);
describe("real DynamoDB Local authoritative persistence", () => {
  it("concurrent claims produce exactly one winner and current-state conflict", async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled([
      service.command(
        f.a,
        f.visit.id,
        { type: "claim", expectedVersion: 1 },
        key(),
      ),
      service.command(
        f.b,
        f.visit.id,
        { type: "claim", expectedVersion: 1 },
        key(),
      ),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    expect(rejected.reason.current.version).toBe(2);
    const persisted = await getItem(
      tables.visits,
      visitPK(f.hid, f.visit.id),
      "STATE",
    );
    expect(persisted?.status).toBe("CLAIMED");
    expect([f.owner, f.other]).toContain(persisted?.handlerId);
  });
  it("duplicate semantic deliveries persist one visit event and concurrent presses share active pointer", async () => {
    const f = await fixture();
    const eventId = key();
    const first = await service.press({
      accountId: f.accountId,
      deviceId: f.deviceId,
      eventId,
      deliveryId: key(),
      source: "LOCAL",
    });
    const duplicate = await service.press({
      accountId: f.accountId,
      deviceId: f.deviceId,
      eventId,
      deliveryId: key(),
      source: "LOCAL",
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.visit.id).toBe(first.visit.id);
    const results = await Promise.all([f.press(), f.press(), f.press()]);
    expect(new Set(results.map((r) => r.visit.id)).size).toBe(1);
    expect(
      (await getItem(tables.config, householdPK(f.hid), `DOOR#${f.deviceId}`))
        ?.activeVisitId,
    ).toBe(first.visit.id);
    const events = await queryPK(
      tables.visits,
      visitPK(f.hid, first.visit.id),
      { prefix: "EVENT#" },
    );
    expect(events.items).toHaveLength(5);
  });
  it("transaction persistence failure never records successful dedup", async () => {
    const f = await fixture(),
      eventId = key(),
      deliveryId = key();
    const original = db.send.bind(db);
    let injected = false;
    const spy = vi.spyOn(db, "send").mockImplementation(((command: any) => {
      if (command instanceof TransactWriteCommand && !injected) {
        injected = true;
        return Promise.reject(
          Object.assign(new Error("Injected storage outage"), {
            name: "InternalServerError",
          }),
        );
      }
      return original(command);
    }) as any);
    try {
      await expect(
        service.press({
          accountId: f.accountId,
          deviceId: f.deviceId,
          eventId,
          deliveryId,
          source: "LOCAL",
        }),
      ).rejects.toMatchObject({ name: "InternalServerError" });
    } finally {
      spy.mockRestore();
    }
    expect(
      await getItem(
        tables.runtime,
        `SEMANTIC#${f.accountId}#${hashToken(eventId)}`,
        "EVENT",
      ),
    ).toBeUndefined();
    const retry = await service.press({
      accountId: f.accountId,
      deviceId: f.deviceId,
      eventId,
      deliveryId,
      source: "LOCAL",
    });
    expect(retry.duplicate).toBe(false);
  });
  it("idempotent command writes one audit/outbox and rejects key reuse for other command", async () => {
    const f = await fixture(),
      idempotencyKey = key();
    const one = await service.command(
      f.a,
      f.visit.id,
      { type: "claim", expectedVersion: 1 },
      idempotencyKey,
    );
    const two = await service.command(
      f.a,
      f.visit.id,
      { type: "claim", expectedVersion: 1 },
      idempotencyKey,
    );
    expect(two).toEqual(one);
    const events = await queryPK(tables.visits, visitPK(f.hid, f.visit.id), {
      prefix: "EVENT#",
    });
    expect(events.items).toHaveLength(2);
    await expect(
      service.command(
        f.a,
        f.visit.id,
        { type: "takeover", expectedVersion: 2 },
        idempotencyKey,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("pending handoff preserves responsibility then acceptance fences audio and stale handler replies", async () => {
    const f = await fixture();
    let v = await capture(f);
    const lease = v.audioLease!;
    v = (
      await service.command(
        f.a,
        v.id,
        { type: "handoff", targetUserId: f.other, expectedVersion: v.version },
        key(),
      )
    ).visit;
    expect(v.handlerId).toBe(f.owner);
    await service.authorizeCapture(f.a, v.id, {
      leaseId: lease.id,
      mediaSessionId: v.mediaSessionId!,
    });
    v = (
      await service.command(
        f.b,
        v.id,
        { type: "accept", expectedVersion: v.version },
        key(),
      )
    ).visit;
    expect(v.handlerId).toBe(f.other);
    expect(v.audioLease).toBeUndefined();
    expect(
      await getItem(tables.runtime, visitPK(f.hid, v.id), "CAPTURE"),
    ).toBeUndefined();
    await expect(
      service.authorizeCapture(f.a, v.id, {
        leaseId: lease.id,
        mediaSessionId: "old",
      }),
    ).rejects.toMatchObject({ code: "NOT_HANDLER" });
    await expect(
      service.command(
        f.a,
        v.id,
        {
          type: "reply",
          text: "Stale",
          threadId: "guessed",
          expectedVersion: v.version,
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: "NOT_HANDLER" });
  });
  it("cancelled pending handoff leaves original handler and claim never sends a reply", async () => {
    const f = await fixture();
    let v = await claimed(f);
    v = (
      await service.command(
        f.a,
        v.id,
        { type: "handoff", targetUserId: f.other, expectedVersion: v.version },
        key(),
      )
    ).visit;
    v = (
      await service.command(
        f.a,
        v.id,
        { type: "cancel", expectedVersion: v.version },
        key(),
      )
    ).visit;
    expect(v.handlerId).toBe(f.owner);
    expect(v.pendingHandoff).toBeUndefined();
    expect(
      (await service.getVisit(f.a, v.id)).items.filter(
        (i) => i.kind === "message",
      ),
    ).toHaveLength(0);
  });
  it("cross-tenant reads/writes/capture and guessed IDs deny", async () => {
    const f = await fixture(),
      alien = await fixture();
    await expect(service.getVisit(alien.a, f.visit.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.command(
        alien.a,
        f.visit.id,
        { type: "claim", expectedVersion: 1 },
        key(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.getVisit(f.a, key())).rejects.toMatchObject({
      status: 404,
    });
    const guest = await service.createGuest(f.publicDoorId);
    await expect(
      service.getVisit(guest.actor, f.visit.id),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("guest browsers remain isolated and cannot access captions or associate by timing", async () => {
    const f = await fixture();
    const one = await service.createGuest(f.publicDoorId),
      two = await service.createGuest(f.publicDoorId);
    await service.guestMessage(
      one.actor,
      { category: "Delivery", text: "Only first visitor" },
      key(),
    );
    expect((await service.guestView(two.actor)).messages).toHaveLength(0);
    expect((await service.guestView(one.actor)).thread.associated).toBe(false);
    const v = await claimed(f);
    await service.command(
      f.a,
      v.id,
      {
        type: "associate",
        threadId: one.thread.id,
        expectedVersion: v.version,
      },
      key(),
    );
    const view = await service.guestView(one.actor);
    expect(view.thread.associated).toBe(true);
    expect(JSON.stringify(view)).not.toContain("Test household");
    expect(Object.keys(view)).not.toContain("captions");
    await expect(
      service.delivery(two.actor, key(), "DISPLAYED"),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("accepted/displayed/explicitly confirmed are distinct monotonic states; unavailable media preserves text", async () => {
    const f = await fixture();
    const guest = await service.createGuest(f.publicDoorId);
    let v = await claimed(f);
    v = (
      await service.command(
        f.a,
        v.id,
        {
          type: "associate",
          threadId: guest.thread.id,
          expectedVersion: v.version,
        },
        key(),
      )
    ).visit;
    v = (
      await service.command(
        f.a,
        v.id,
        { type: "media", action: "unavailable", expectedVersion: v.version },
        key(),
      )
    ).visit;
    expect(v.mediaStatus).toBe("UNAVAILABLE");
    v = (
      await service.command(
        f.a,
        v.id,
        {
          type: "reply",
          threadId: guest.thread.id,
          text: "Please wait.",
          expectedVersion: v.version,
        },
        key(),
      )
    ).visit;
    let message = (await service.guestView(guest.actor)).messages.find(
      (m) => m.direction === "resident",
    )!;
    expect(message.deliveryStatus).toBe("ACCEPTED");
    await expect(
      service.delivery(guest.actor, message.id, "CONFIRMED"),
    ).rejects.toMatchObject({ code: "NOT_DISPLAYED" });
    message = (await service.delivery(guest.actor, message.id, "DISPLAYED"))
      .message;
    expect(message.deliveryStatus).toBe("DISPLAYED");
    message = (await service.delivery(guest.actor, message.id, "CONFIRMED"))
      .message;
    expect(message.deliveryStatus).toBe("CONFIRMED");
    expect(
      (await service.delivery(guest.actor, message.id, "DISPLAYED")).message
        .deliveryStatus,
    ).toBe("CONFIRMED");
  });
  it("expired membership/session/grant are rejected before DynamoDB TTL cleanup", async () => {
    const f = await fixture();
    const row = await getItem(
      tables.config,
      householdPK(f.hid),
      `MEMBER#${f.owner}`,
    );
    await putItem(tables.config, { ...row!, expiresAt: sec() - 1 });
    expect(await getItem(tables.config, row!.PK, row!.SK)).toBeDefined();
    await expect(service.getVisit(f.a, f.visit.id)).rejects.toMatchObject({
      status: 403,
    });
    const second = await fixture();
    const session = await getItem(
      tables.runtime,
      `SESSION#${second.a.sessionId}`,
      "SESSION",
    );
    await putItem(tables.runtime, { ...session!, expiresAt: sec() - 1 });
    await expect(service.bootstrap(second.a)).rejects.toMatchObject({
      status: 401,
    });
    const third = await fixture();
    const member = await getItem(
      tables.config,
      householdPK(third.hid),
      `MEMBER#${third.owner}`,
    );
    await putItem(tables.config, {
      ...member!,
      grants: { ...member!.grants, captions: false },
    });
    await expect(
      service.command(
        third.a,
        third.visit.id,
        { type: "capture", consent: true, expectedVersion: 1 },
        key(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("partials replace in realtime only and final result persists once without rewriting words", async () => {
    const f = await fixture();
    const v = await capture(f),
      lease = v.audioLease!,
      base = {
        mediaSessionId: v.mediaSessionId!,
        resultId: key(),
        startTime: 0,
        endTime: 1.5,
        source: "FIXTURE" as const,
      };
    expect(
      await service.persistCaption(
        f.a,
        v.id,
        { ...base, text: "Do leave it.", isPartial: true },
        lease.id,
      ),
    ).toBeNull();
    expect(
      (
        await queryPK(tables.visits, visitPK(f.hid, v.id), {
          prefix: "CAPTION#",
        })
      ).items,
    ).toHaveLength(0);
    const final = await service.persistCaption(
      f.a,
      v.id,
      { ...base, text: "Do not leave it.", isPartial: false },
      lease.id,
    );
    await service.persistCaption(
      f.a,
      v.id,
      { ...base, text: "Do not leave it.", isPartial: false },
      lease.id,
    );
    const persisted = await queryPK(tables.visits, visitPK(f.hid, v.id), {
      prefix: "CAPTION#",
    });
    expect(persisted.items).toHaveLength(1);
    expect(final?.text).toBe("Do not leave it.");
  });
  it("socket capture release preserves handler responsibility; media expiry rejects capture", async () => {
    const f = await fixture();
    const v = await capture(f);
    await service.releaseCapture(f.a, v.id, v.audioLease!.id, "SOCKET_CLOSED");
    const after = (await service.getVisit(f.a, v.id)).visit;
    expect(after.handlerId).toBe(f.owner);
    expect(after.status).toBe("CLAIMED");
    expect(after.mediaStatus).toBe("INTERRUPTED");
    expect(after.audioLease).toBeUndefined();
    await service.expireMedia(f.hid, v.id, after.mediaSessionId!);
    expect((await service.getVisit(f.a, v.id)).visit.mediaStatus).toBe("ENDED");
  });
  it("worker restart retains claim and expired conditional job leases recover", async () => {
    const f = await fixture();
    const v = await claimed(f);
    const job = makeJob("NOTIFY", f.hid, { visitId: v.id });
    await putItem(tables.runtime, job);
    const first = await service.claimJob(job, "worker-before", 1000);
    expect(first?.status).toBe("LEASED");
    expect(await service.claimJob(job, "worker-too-early", 1000)).toBeNull();
    await putItem(tables.runtime, { ...first!, leaseUntil: Date.now() - 1 });
    const afterRestart = await service.claimJob(job, "worker-after", 1000);
    expect(afterRestart?.attempts).toBe(2);
    await service.completeJob(afterRestart!, "worker-after");
    expect((await getItem(tables.runtime, job.PK, job.SK))?.status).toBe(
      "DONE",
    );
    expect((await service.getVisit(f.a, v.id)).visit.handlerId).toBe(f.owner);
  });
  it("crashed final-attempt job becomes DEAD and loses due index keys", async () => {
    const f = await fixture();
    const job = makeJob("NOTIFY", f.hid, { visitId: f.visit.id });
    await putItem(tables.runtime, {
      ...job,
      status: "LEASED",
      attempts: 5,
      leaseOwner: "crashed-worker",
      leaseUntil: Date.now() - 1,
    });
    expect(await service.claimJob(job, "recovery")).toBeNull();
    const after = await getItem(tables.runtime, job.PK, job.SK);
    expect(after?.status).toBe("DEAD");
    expect(after?.category).toBe("MAX_ATTEMPTS");
    expect(after?.duePk).toBeUndefined();
  });
  it("job failure retries bounded then dead letters without transcript content", async () => {
    const f = await fixture();
    const job = makeJob("NOTIFY", f.hid, { visitId: f.visit.id });
    await putItem(tables.runtime, job);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const current = await getItem(tables.runtime, job.PK, job.SK);
      await putItem(tables.runtime, {
        ...current!,
        nextAttemptAt: Date.now() - 1,
        dueSk: `${pad(Date.now() - 1)}#${job.id}`,
      });
      const leased = await service.claimJob(job, "worker");
      expect(leased?.attempts).toBe(attempt);
      await service.failJob(leased!, "worker", "TRANSIENT");
    }
    const dead = await getItem(tables.runtime, job.PK, job.SK);
    expect(dead?.status).toBe("DEAD");
    expect(dead?.duePk).toBeUndefined();
    expect(dead?.text).toBeUndefined();
  });
  it("closed visit explicit deletion denies immediately and physically removes content copies", async () => {
    const f = await fixture();
    const guest = await service.createGuest(f.publicDoorId);
    await service.guestMessage(
      guest.actor,
      { category: "Other", text: "Erase this content" },
      key(),
    );
    let v = await claimed(f);
    v = (
      await service.command(
        f.a,
        v.id,
        {
          type: "associate",
          threadId: guest.thread.id,
          expectedVersion: v.version,
        },
        key(),
      )
    ).visit;
    v = (
      await service.command(
        f.a,
        v.id,
        { type: "close", outcome: "COMPLETED", expectedVersion: v.version },
        key(),
      )
    ).visit;
    v = (
      await service.command(
        f.a,
        v.id,
        { type: "delete", expectedVersion: v.version },
        key(),
      )
    ).visit;
    expect(v.deleted).toBe(true);
    await expect(service.getVisit(f.a, v.id)).rejects.toMatchObject({
      status: 404,
    });
    const job = makeJob("DELETE_VISIT", f.hid, { visitId: v.id });
    await service.executeDeleteJob(job);
    expect(
      (await queryPK(tables.visits, visitPK(f.hid, v.id))).items,
    ).toHaveLength(0);
    expect(
      (await queryPK(tables.visits, threadPK(f.hid, guest.thread.id))).items,
    ).toHaveLength(0);
    await expect(service.guestView(guest.actor)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("deletion requires explicit closure and preserves the active handler, capture and door pointer", async () => {
    const f = await fixture();
    const v = await capture(f);
    const before = await getItem(tables.visits, visitPK(f.hid, v.id), "STATE");
    await expect(
      service.command(
        f.a,
        v.id,
        { type: "delete", expectedVersion: v.version },
        key(),
      ),
    ).rejects.toMatchObject({ code: "CLOSE_REQUIRED", status: 409 });
    expect(await getItem(tables.visits, visitPK(f.hid, v.id), "STATE")).toEqual(
      before,
    );
    expect(
      (await getItem(tables.config, householdPK(f.hid), `DOOR#${f.deviceId}`))
        ?.activeVisitId,
    ).toBe(v.id);
    expect(
      await getItem(tables.runtime, visitPK(f.hid, v.id), "CAPTURE"),
    ).toBeDefined();
  });
  it("queued visit deletion immediately rejects guest reads, replayed/new writes and acknowledgements before physical removal", async () => {
    const f = await fixture();
    const guest = await service.createGuest(f.publicDoorId);
    const messageKey = key();
    const input = {
      category: "Other" as const,
      text: "Private pending deletion",
    };
    await service.guestMessage(guest.actor, input, messageKey);
    let v = await claimed(f);
    v = (
      await service.command(
        f.a,
        v.id,
        {
          type: "associate",
          threadId: guest.thread.id,
          expectedVersion: v.version,
        },
        key(),
      )
    ).visit;
    await service.command(
      f.a,
      v.id,
      {
        type: "reply",
        threadId: guest.thread.id,
        text: "Private reply",
        expectedVersion: v.version,
      },
      key(),
    );
    v = (await service.getVisit(f.a, v.id)).visit;
    const reply = (await service.guestView(guest.actor)).messages.find(
      (m) => m.direction === "resident",
    )!;
    v = (
      await service.command(
        f.a,
        v.id,
        { type: "close", outcome: "COMPLETED", expectedVersion: v.version },
        key(),
      )
    ).visit;
    expect((await service.guestView(guest.actor)).messages.length).toBe(2);
    expect(
      (await service.bootstrap(f.a)).threads.some(
        (t) => t.id === guest.thread.id,
      ),
    ).toBe(true);
    await service.command(
      f.a,
      v.id,
      { type: "delete", expectedVersion: v.version },
      key(),
    );
    // Worker deliberately not run: copies and guest session physically remain, while access must already end.
    expect(
      (
        await queryPK(tables.visits, threadPK(f.hid, guest.thread.id), {
          prefix: "MESSAGE#",
        })
      ).items,
    ).toHaveLength(2);
    expect(
      await getItem(
        tables.runtime,
        `SESSION#${guest.actor.sessionId}`,
        "SESSION",
      ),
    ).toBeDefined();
    await expect(service.guestView(guest.actor)).rejects.toMatchObject({
      status: 403,
      code: "EXPIRED",
    });
    await expect(
      service.guestMessage(guest.actor, input, messageKey),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.guestMessage(
        guest.actor,
        { category: "Other", text: "New content" },
        key(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.delivery(guest.actor, reply.id, "DISPLAYED"),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await service.bootstrap(f.a)).threads.some(
        (t) => t.id === guest.thread.id,
      ),
    ).toBe(false);
    await service.executeDeleteJob(
      makeJob("DELETE_VISIT", f.hid, { visitId: v.id }),
    );
    expect(
      (await queryPK(tables.visits, threadPK(f.hid, guest.thread.id))).items,
    ).toHaveLength(0);
    expect(
      await getItem(
        tables.runtime,
        `SESSION#${guest.actor.sessionId}`,
        "SESSION",
      ),
    ).toBeUndefined();
  });
  it("associated guest content expires with its parent before DynamoDB TTL removes either record", async () => {
    const f = await fixture();
    const guest = await service.createGuest(f.publicDoorId);
    let v = await claimed(f);
    v = (
      await service.command(
        f.a,
        v.id,
        {
          type: "associate",
          threadId: guest.thread.id,
          expectedVersion: v.version,
        },
        key(),
      )
    ).visit;
    const row = (await getItem(tables.visits, visitPK(f.hid, v.id), "STATE"))!;
    await putItem(tables.visits, { ...row, expiresAt: sec() - 1 });
    expect(
      (await getItem(tables.visits, threadPK(f.hid, guest.thread.id), "STATE"))!
        .expiresAt,
    ).toBeGreaterThan(sec());
    await expect(service.guestView(guest.actor)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await service.bootstrap(f.a)).threads.some(
        (t) => t.id === guest.thread.id,
      ),
    ).toBe(false);
  });
  it("guest message transaction cannot commit after associated-visit deletion wins the race", async () => {
    const f = await fixture();
    const guest = await service.createGuest(f.publicDoorId);
    let v = await claimed(f);
    v = (
      await service.command(
        f.a,
        v.id,
        {
          type: "associate",
          threadId: guest.thread.id,
          expectedVersion: v.version,
        },
        key(),
      )
    ).visit;
    v = (
      await service.command(
        f.a,
        v.id,
        { type: "close", outcome: "COMPLETED", expectedVersion: v.version },
        key(),
      )
    ).visit;
    const original = db.send.bind(db);
    let injected = false;
    const spy = vi.spyOn(db, "send").mockImplementation((async (
      command: any,
    ) => {
      if (
        !injected &&
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some(
          (item: any) =>
            item.Update?.Key?.PK === threadPK(f.hid, guest.thread.id),
        )
      ) {
        injected = true;
        await service.command(
          f.a,
          v.id,
          { type: "delete", expectedVersion: v.version },
          key(),
        );
      }
      return original(command);
    }) as any);
    try {
      await expect(
        service.guestMessage(
          guest.actor,
          { category: "Other", text: "Must not persist after deletion" },
          key(),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(injected).toBe(true);
      expect(
        (
          await queryPK(tables.visits, threadPK(f.hid, guest.thread.id), {
            prefix: "MESSAGE#",
          })
        ).items,
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
  it("sharing withdrawal removes saved conversation content from nonhandler reads", async () => {
    const f = await fixture();
    let v = await capture(f);
    const guest = await service.createGuest(f.publicDoorId);
    await service.guestMessage(
      guest.actor,
      { category: "Delivery", text: "Private visitor message" },
      key(),
    );
    v = (
      await service.command(
        f.a,
        v.id,
        {
          type: "associate",
          threadId: guest.thread.id,
          expectedVersion: v.version,
        },
        key(),
      )
    ).visit;
    await service.persistCaption(
      f.a,
      v.id,
      {
        mediaSessionId: v.mediaSessionId!,
        resultId: key(),
        text: "Private final caption",
        startTime: 0,
        endTime: 1,
        source: "FIXTURE",
        isPartial: false,
      },
      v.audioLease!.id,
    );
    expect(
      (await service.getVisit(f.b, v.id)).items.some(
        (i) => i.kind === "caption",
      ),
    ).toBe(true);
    const settings = (await service.bootstrap(f.a)).settings;
    await service.settings(f.a, {
      ...settings,
      consent: { ...settings.consent, sharing: false },
    });
    const other = await service.getVisit(f.b, v.id);
    expect(other.access).toEqual({
      captions: false,
      visitorText: false,
      camera: false,
    });
    expect((await service.getVisit(f.a, v.id)).access).toEqual({
      captions: true,
      visitorText: true,
      camera: true,
    });
    expect(
      other.items.some((i) => i.kind === "caption" || i.kind === "message"),
    ).toBe(false);
    expect(other.threads[0].lastMessage).toBeUndefined();
    expect(
      (await service.bootstrap(f.b)).threads.find(
        (t) => t.id === guest.thread.id,
      )?.lastMessage,
    ).toBeUndefined();
    expect(
      (await service.getVisit(f.a, v.id)).items.some(
        (i) => i.text === "Private final caption",
      ),
    ).toBe(true);
    expect((await service.guestView(guest.actor)).messages[0].text).toBe(
      "Private visitor message",
    );
  });
  it("guest history pagination is bounded and scoped to its authenticated thread", async () => {
    const f = await fixture(),
      guest = await service.createGuest(f.publicDoorId);
    for (let i = 0; i < 37; i++)
      await putItem(tables.visits, {
        PK: threadPK(f.hid, guest.thread.id),
        SK: `MESSAGE#${pad(Date.now() + i)}#${i}`,
        id: `page-${i}`,
        kind: "message",
        direction: "visitor",
        text: `Message ${i}`,
        createdAt: Date.now() + i,
        expiresAt: sec() + 3600,
      });
    const first = await service.guestView(guest.actor);
    expect(first.messages).toHaveLength(30);
    expect(first.nextCursor).toBeDefined();
    const second = await service.guestView(guest.actor, first.nextCursor);
    expect(second.messages).toHaveLength(7);
    expect(
      new Set([...first.messages, ...second.messages].map((m) => m.id)).size,
    ).toBe(37);
  });
  it("offline webhook is idempotent and leaves Ring consent/account mapping active", async () => {
    const f = await fixture();
    const v = await capture(f),
      eventId = key(),
      deliveryId = key();
    expect(
      (
        await service.ringDeviceOffline(
          f.accountId,
          f.deviceId,
          eventId,
          deliveryId,
        )
      ).duplicate,
    ).toBe(false);
    expect(
      (await service.ringDeviceOffline(f.accountId, f.deviceId, eventId, key()))
        .duplicate,
    ).toBe(true);
    expect((await service.getVisit(f.a, v.id)).visit.mediaStatus).toBe(
      "UNAVAILABLE",
    );
    expect(
      await getItem(tables.runtime, visitPK(f.hid, v.id), "CAPTURE"),
    ).toBeUndefined();
    expect(
      (await getItem(tables.config, `RINGACCOUNT#${f.accountId}`, "LOOKUP"))
        ?.revoked,
    ).toBeUndefined();
    expect((await service.bootstrap(f.a)).settings.consent.ring).toBe(true);
  });
  it("content access expiry applies before TTL removes stored content", async () => {
    const f = await fixture();
    const row = await getItem(
      tables.visits,
      visitPK(f.hid, f.visit.id),
      "STATE",
    );
    await putItem(tables.visits, { ...row!, expiresAt: sec() - 1 });
    expect(await getItem(tables.visits, row!.PK, "STATE")).toBeDefined();
    await expect(service.getVisit(f.a, f.visit.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("history pagination is scoped and contains each separate audit event once", async () => {
    const f = await fixture();
    for (let i = 0; i < 36; i++)
      await putItem(tables.visits, {
        PK: visitPK(f.hid, f.visit.id),
        SK: `EVENT#${pad(i + 10)}#${i}`,
        id: `extra-${i}`,
        kind: "event",
        text: `Event ${i}`,
        createdAt: Date.now() + i,
        expiresAt: sec() + 3600,
      });
    const legacy = await getItem(
      tables.visits,
      visitPK(f.hid, f.visit.id),
      "STATE",
    );
    delete legacy!.historyVersion;
    await putItem(tables.visits, legacy!);
    let view = await service.getVisit(f.a, f.visit.id);
    const ids = view.items.map((i) => i.id);
    expect(view.nextCursor).toBeDefined();
    while (view.nextCursor) {
      view = await service.getVisit(f.a, f.visit.id, view.nextCursor);
      ids.push(...view.items.map((i) => i.id));
    }
    expect(ids).toHaveLength(37);
    expect(new Set(ids).size).toBe(37);
  });
  it("invitation acceptance consumes one code for a verified subject and is idempotent for that subject", async () => {
    const f = await fixture();
    await service.revoke(f.a, f.other);
    const invitation = await service.invite(f.a, { name: "Invited member" });
    const previous = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "oidc";
    try {
      const subject = `verified-${key()}`;
      const accepted = await service.acceptInvite(
        subject,
        invitation.inviteCode,
      );
      expect(accepted.actor.householdId).toBe(f.hid);
      expect(accepted.user.name).toBe("Invited member");
      const replay = await service.acceptInvite(subject, invitation.inviteCode);
      expect(replay.user.id).toBe(subject);
      await expect(
        service.acceptInvite(`another-${key()}`, invitation.inviteCode),
      ).rejects.toMatchObject({ code: "INVITE_USED" });
      expect((await service.bootstrap(f.a)).members).toHaveLength(2);
    } finally {
      process.env.AUTH_MODE = previous;
    }
  });
  it("expired invitation and cross-household verified identity are rejected", async () => {
    const f = await fixture(),
      alien = await fixture();
    await service.revoke(f.a, f.other);
    const invitation = await service.invite(f.a, { name: "Invited" });
    const previous = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "oidc";
    try {
      await expect(
        service.acceptInvite(alien.owner, invitation.inviteCode),
      ).rejects.toMatchObject({ code: "HOUSEHOLD_CONFLICT" });
      const row = await getItem(
        tables.runtime,
        `INVITE#${hashToken(invitation.inviteCode)}`,
        "INVITE",
      );
      await putItem(tables.runtime, { ...row!, expiresAt: sec() - 1 });
      await expect(
        service.acceptInvite(`new-${key()}`, invitation.inviteCode),
      ).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    } finally {
      process.env.AUTH_MODE = previous;
    }
  });
  it("concurrent invitation acceptance cannot exceed the two-member household limit", async () => {
    const f = await fixture();
    await service.revoke(f.a, f.other);
    const one = await service.invite(f.a, { name: "One" }),
      two = await service.invite(f.a, { name: "Two" });
    const previous = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "oidc";
    try {
      const outcomes = await Promise.allSettled([
        service.acceptInvite(`new-${key()}`, one.inviteCode),
        service.acceptInvite(`new-${key()}`, two.inviteCode),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const loser = outcomes.find(
        (o) => o.status === "rejected",
      ) as PromiseRejectedResult;
      expect(loser.reason.code).toBe("HOUSEHOLD_FULL");
      expect((await service.bootstrap(f.a)).members).toHaveLength(2);
    } finally {
      process.env.AUTH_MODE = previous;
    }
  });
  it("demo auth cannot accept invitation identities", async () => {
    const f = await fixture();
    const invitation = await service.invite(f.a, { name: "Existing member" });
    await expect(
      service.acceptInvite(f.other, invitation.inviteCode),
    ).rejects.toMatchObject({ code: "OIDC_REQUIRED" });
  });
  it("atomic member revocation rolls back all media fences on persistence failure then succeeds", async () => {
    const f = await fixture();
    let v = (
      await service.command(
        f.b,
        f.visit.id,
        { type: "claim", expectedVersion: 1 },
        key(),
      )
    ).visit;
    v = (
      await service.command(
        f.b,
        v.id,
        {
          type: "media",
          action: "start",
          consent: true,
          expectedVersion: v.version,
        },
        key(),
      )
    ).visit;
    v = (
      await service.command(
        f.b,
        v.id,
        { type: "capture", consent: true, expectedVersion: v.version },
        key(),
      )
    ).visit;
    const original = db.send.bind(db);
    const spy = vi.spyOn(db, "send").mockImplementation(((command: any) =>
      command instanceof TransactWriteCommand
        ? Promise.reject(
            Object.assign(new Error("Injected"), {
              name: "InternalServerError",
            }),
          )
        : original(command)) as any);
    try {
      await expect(service.revoke(f.a, f.other)).rejects.toMatchObject({
        name: "InternalServerError",
      });
    } finally {
      spy.mockRestore();
    }
    expect(
      (await getItem(tables.config, householdPK(f.hid), `MEMBER#${f.other}`))
        ?.revoked,
    ).toBeUndefined();
    expect(
      (await getItem(tables.visits, visitPK(f.hid, v.id), "STATE"))?.audioLease
        .id,
    ).toBe(v.audioLease!.id);
    await service.revoke(f.a, f.other);
    const state = await getItem(tables.visits, visitPK(f.hid, v.id), "STATE");
    expect(state?.audioLease).toBeUndefined();
    expect(state?.handlerId).toBe(f.other);
    expect(
      await getItem(tables.runtime, visitPK(f.hid, v.id), "CAPTURE"),
    ).toBeUndefined();
    await expect(
      service.authenticate(
        (await service.createResidentSession(f.owner, f.hid)).token,
      ),
    ).resolves.toMatchObject({ userId: f.owner });
  });
  it("atomic Ring revocation and unlink preserve consent on failed transaction and remove credentials on success", async () => {
    const f = await fixture();
    const v = await capture(f);
    await putItem(tables.config, {
      PK: householdPK(f.hid),
      SK: "INTEGRATION#ring",
      status: "LINKED",
      credentials: { ciphertext: "encrypted-fixture" },
    });
    const original = db.send.bind(db);
    const spy = vi.spyOn(db, "send").mockImplementation(((command: any) =>
      command instanceof TransactWriteCommand
        ? Promise.reject(
            Object.assign(new Error("Injected"), {
              name: "InternalServerError",
            }),
          )
        : original(command)) as any);
    try {
      await expect(
        service.revokeRingAccount(f.accountId, f.deviceId),
      ).rejects.toMatchObject({ name: "InternalServerError" });
      await expect(service.unlink(f.a)).rejects.toMatchObject({
        name: "InternalServerError",
      });
    } finally {
      spy.mockRestore();
    }
    expect((await service.bootstrap(f.a)).settings.consent.ring).toBe(true);
    expect(
      (await getItem(tables.config, `RINGACCOUNT#${f.accountId}`, "LOOKUP"))
        ?.revoked,
    ).toBeUndefined();
    expect(
      (await getItem(tables.visits, visitPK(f.hid, v.id), "STATE"))?.audioLease
        .id,
    ).toBe(v.audioLease!.id);
    await service.unlink(f.a);
    expect(
      (await getItem(tables.config, householdPK(f.hid), "INTEGRATION#ring"))
        ?.credentials,
    ).toBeUndefined();
    expect((await service.bootstrap(f.a)).settings.consent.ring).toBe(false);
    expect(
      (await getItem(tables.visits, visitPK(f.hid, v.id), "STATE"))?.audioLease,
    ).toBeUndefined();
  });
  it("acceptance atomically consumes verified pending identity and refuses expired proof before membership write", async () => {
    const f = await fixture();
    await service.revoke(f.a, f.other);
    const invitation = await service.invite(f.a, { name: "Verified member" }),
      subject = `verified-${key()}`,
      proof = { PK: `PENDING_IDENTITY#${key()}`, SK: "IDENTITY" };
    await putItem(tables.runtime, {
      ...proof,
      subject,
      expiresAt: sec() + 600,
    });
    const previous = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "oidc";
    try {
      const session = await service.acceptInvite(
        subject,
        invitation.inviteCode,
        proof,
      );
      expect(await getItem(tables.runtime, proof.PK, proof.SK)).toBeUndefined();
      await expect(service.authenticate(session.token)).resolves.toMatchObject({
        userId: subject,
      });
      const other = await fixture();
      await service.revoke(other.a, other.other);
      const next = await service.invite(other.a, { name: "Expired" }),
        expiredSubject = `verified-${key()}`,
        expired = { PK: `PENDING_IDENTITY#${key()}`, SK: "IDENTITY" };
      await putItem(tables.runtime, {
        ...expired,
        subject: expiredSubject,
        expiresAt: sec() - 1,
      });
      await expect(
        service.acceptInvite(expiredSubject, next.inviteCode, expired),
      ).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
      expect(
        await getItem(
          tables.config,
          householdPK(other.hid),
          `MEMBER#${expiredSubject}`,
        ),
      ).toBeUndefined();
    } finally {
      process.env.AUTH_MODE = previous;
    }
  });
  it("strong chronological reconnect starts with latest mixed captions/events and older pages do not lose results", async () => {
    const f = await fixture();
    let v = await capture(f);
    const leaseId = v.audioLease!.id,
      mediaSessionId = v.mediaSessionId!;
    for (let index = 0; index < 40; index++) {
      await service.persistCaption(
        f.a,
        v.id,
        {
          mediaSessionId,
          resultId: `result-${String(index).padStart(3, "0")}`,
          text: `Caption ${index}`,
          startTime: index * 0.1,
          endTime: (index + 1) * 0.1,
          source: "FIXTURE",
          isPartial: false,
        },
        leaseId,
      );
      if (index % 10 === 0) {
        v = (
          await service.command(
            f.a,
            v.id,
            {
              type: "handoff",
              targetUserId: f.other,
              expectedVersion: v.version,
            },
            key(),
          )
        ).visit;
        v = (
          await service.command(
            f.a,
            v.id,
            { type: "cancel", expectedVersion: v.version },
            key(),
          )
        ).visit;
      }
    }
    let page = await service.getVisit(f.a, v.id);
    expect(page.items).toHaveLength(30);
    expect(page.items.some((i) => i.text === "Caption 39")).toBe(true);
    expect(page.items.some((i) => i.text === "Caption 0")).toBe(false);
    const reconnect = await service.getVisit(f.a, v.id);
    expect(reconnect.items.map((i) => i.id)).toEqual(
      page.items.map((i) => i.id),
    );
    const all = [...page.items];
    while (page.nextCursor) {
      const boundary = page.items[0].createdAt;
      page = await service.getVisit(f.a, v.id, page.nextCursor);
      expect(page.items.at(-1)!.createdAt).toBeLessThanOrEqual(boundary);
      all.push(...page.items);
    }
    expect(all.filter((i) => i.kind === "caption")).toHaveLength(40);
    expect(all.filter((i) => i.kind === "event")).toHaveLength(12);
    expect(new Set(all.map((i) => i.id)).size).toBe(52);
  });
  it("rejects poisoned household GSI entries using strong base-row ownership and canonical keys", async () => {
    const owner = await fixture(),
      alien = await fixture(),
      guest = await service.createGuest(alien.publicDoorId);
    await service.guestMessage(
      guest.actor,
      { category: "Delivery", text: "Private message in another household" },
      key(),
    );
    const alienVisit = await getItem(
      tables.visits,
      visitPK(alien.hid, alien.visit.id),
      "STATE",
    );
    const alienThread = await getItem(
      tables.visits,
      threadPK(alien.hid, guest.thread.id),
      "STATE",
    );
    const poisonedVisit = {
      ...alienVisit!,
      gsi1pk: `HOUSEHOLD#${owner.hid}#VISITS`,
      gsi1sk: `${Date.now() + 60000}#${alien.visit.id}`,
    };
    const poisonedThread = {
      ...alienThread!,
      gsi1pk: `HOUSEHOLD#${owner.hid}#THREADS`,
      gsi1sk: `${Date.now() + 60000}#${guest.thread.id}`,
    };
    await Promise.all([
      putItem(tables.visits, poisonedVisit),
      putItem(tables.visits, poisonedThread),
    ]);
    await expect
      .poll(
        async () => {
          const [visits, threads] = await Promise.all([
            queryIndex(
              tables.visits,
              "household-time",
              "gsi1pk",
              poisonedVisit.gsi1pk,
            ),
            queryIndex(
              tables.visits,
              "household-time",
              "gsi1pk",
              poisonedThread.gsi1pk,
            ),
          ]);
          return (
            visits.some((row) => row.PK === poisonedVisit.PK) &&
            threads.some((row) => row.PK === poisonedThread.PK)
          );
        },
        { timeout: 5000 },
      )
      .toBe(true);
    let boot = await service.bootstrap(owner.a);
    expect(boot.visits.some((visit) => visit.id === owner.visit.id)).toBe(true);
    expect(boot.visits.some((visit) => visit.id === alien.visit.id)).toBe(
      false,
    );
    expect(boot.threads.some((thread) => thread.id === guest.thread.id)).toBe(
      false,
    );
    expect(JSON.stringify(boot)).not.toContain(
      "Private message in another household",
    );
    // A forged household field must not override the canonical base partition.
    await Promise.all([
      putItem(tables.visits, { ...poisonedVisit, householdId: owner.hid }),
      putItem(tables.visits, { ...poisonedThread, householdId: owner.hid }),
    ]);
    boot = await service.bootstrap(owner.a);
    expect(boot.visits.some((visit) => visit.id === alien.visit.id)).toBe(
      false,
    );
    expect(boot.threads.some((thread) => thread.id === guest.thread.id)).toBe(
      false,
    );
    expect(JSON.stringify(boot)).not.toContain(
      "Private message in another household",
    );
  });
  it("reports fresh individual content grants explicitly even when visit access remains200", async () => {
    const f = await fixture();
    const v = await capture(f);
    const row = await getItem(
      tables.config,
      householdPK(f.hid),
      `MEMBER#${f.owner}`,
    );
    await putItem(tables.config, {
      ...row!,
      grants: {
        ...row!.grants,
        captions: false,
        camera: false,
        visitorText: true,
      },
    });
    let view = await service.getVisit(f.a, v.id);
    expect(view.access).toEqual({
      captions: false,
      camera: false,
      visitorText: true,
    });
    expect(view.visit.mediaSessionId).toBeUndefined();
    await putItem(tables.config, {
      ...row!,
      grants: {
        ...row!.grants,
        captions: true,
        camera: true,
        visitorText: false,
      },
    });
    view = await service.getVisit(f.a, v.id);
    expect(view.access).toEqual({
      captions: true,
      camera: true,
      visitorText: false,
    });
    expect(view.threads).toHaveLength(0);
  });
});
