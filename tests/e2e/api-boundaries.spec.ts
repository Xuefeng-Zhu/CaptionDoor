import { test, expect } from "@playwright/test";
import {
  resident,
  guest,
  origin,
  consent,
  freshVisit,
  command,
  view,
  mutate,
  mutationHeaders,
} from "./helpers";
import type { GuestView } from "@captiondoor/domain";
test.describe.configure({ mode: "serial" });
test("real HTTP claim race has one winner, conflict carries current state, tenant and CSRF boundaries deny", async ({
  browser,
  request,
}) => {
  const health = await request.get(`${origin}/api/health`);
  expect(health.ok(), await health.text()).toBeTruthy();
  const alex = await resident(browser, "alex"),
    sam = await resident(browser, "sam"),
    jordan = await resident(browser, "jordan");
  try {
    await consent(alex);
    const visit = await freshVisit(alex);
    const results = await Promise.all([
      command(alex, visit.id, {
        type: "claim",
        expectedVersion: visit.version,
      }),
      command(sam, visit.id, { type: "claim", expectedVersion: visit.version }),
    ]);
    expect(results.map((r) => r.status()).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status() === 409)!;
    const failure = await loser.json();
    expect(failure.error.current).toBeTruthy();
    const current = (await view(alex, visit.id)).visit;
    expect(current.status).toBe("CLAIMED");
    expect(["alex", "sam"]).toContain(current.handlerId);
    expect(
      (await view(alex, visit.id)).items.filter((i) => i.kind === "message"),
    ).toHaveLength(0);
    const deniedRead = await jordan.context.request.get(
      `/api/visits/${visit.id}`,
    );
    expect([403, 404]).toContain(deniedRead.status());
    const deniedWrite = await command(jordan, visit.id, {
      type: "close",
      expectedVersion: current.version,
      outcome: "DISMISSED",
    });
    expect([403, 404]).toContain(deniedWrite.status());
    const noCsrf = await alex.context.request.post("/api/settings", {
      data: {},
      headers: { Origin: origin },
    });
    expect(noCsrf.status()).toBe(403);
    const alienOrigin = await alex.context.request.post("/api/settings", {
      data: {},
      headers: {
        ...mutationHeaders(alex.csrf),
        Origin: "https://unrelated.invalid",
      },
    });
    expect(alienOrigin.status()).toBe(403);
    const guessed = await alex.context.request.get(
      "/api/visits/00000000-0000-4000-8000-000000000000",
    );
    expect([403, 404]).toContain(guessed.status());
  } finally {
    await Promise.all([
      alex.context.close(),
      sam.context.close(),
      jordan.context.close(),
    ]);
  }
});
test("private visitor threads require explicit association and acknowledgements remain distinct", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex"),
    one = await guest(browser),
    two = await guest(browser);
  try {
    await consent(alex);
    const v = await freshVisit(alex);
    let claimed = await command(alex, v.id, {
      type: "claim",
      expectedVersion: v.version,
    });
    expect(claimed.ok(), await claimed.text()).toBeTruthy();
    const first = await mutate(
      one.context.request,
      "/api/guest/messages",
      { category: "Delivery", text: "Signature required for this package." },
      one.csrf,
    );
    expect(first.ok(), await first.text()).toBeTruthy();
    const second = await mutate(
      two.context.request,
      "/api/guest/messages",
      { category: "Other", text: "This is a separate visitor." },
      two.csrf,
    );
    expect(second.ok(), await second.text()).toBeTruthy();
    const guestOne = (await (
      await one.context.request.get("/api/guest")
    ).json()) as GuestView;
    const guestTwo = (await (
      await two.context.request.get("/api/guest")
    ).json()) as GuestView;
    expect(guestOne.thread.id).not.toBe(guestTwo.thread.id);
    expect(
      guestOne.messages.some((i) => i.text === "This is a separate visitor."),
    ).toBe(false);
    expect(
      guestTwo.messages.some(
        (i) => i.text === "Signature required for this package.",
      ),
    ).toBe(false);
    expect(guestOne.thread.associated).toBe(false);
    expect(JSON.stringify(guestOne)).not.toMatch(
      /householdId|handlerName|captions|audioLease/,
    );
    const residentEndpoint = await one.context.request.get(
      `/api/visits/${v.id}`,
    );
    expect([401, 403]).toContain(residentEndpoint.status());
    let state = (await view(alex, v.id)).visit;
    const premature = await command(alex, v.id, {
      type: "reply",
      expectedVersion: state.version,
      threadId: one.threadId,
      text: "Please wait.",
    });
    expect([400, 403, 409]).toContain(premature.status());
    state = (await view(alex, v.id)).visit;
    const association = await command(alex, v.id, {
      type: "associate",
      expectedVersion: state.version,
      threadId: one.threadId,
    });
    expect(association.ok(), await association.text()).toBeTruthy();
    state = (await view(alex, v.id)).visit;
    const reply = await command(alex, v.id, {
      type: "reply",
      expectedVersion: state.version,
      threadId: one.threadId,
      text: "I’m coming. Please wait.",
    });
    expect(reply.ok(), await reply.text()).toBeTruthy();
    const accepted = (await view(alex, v.id)).items.find(
      (i) =>
        i.direction === "resident" && i.text === "I’m coming. Please wait.",
    )!;
    expect(accepted).toBeTruthy();
    expect(accepted.deliveryStatus).toBe("ACCEPTED");
    const otherConfirm = await mutate(
      two.context.request,
      `/api/guest/messages/${accepted.id}/confirm`,
      {},
      two.csrf,
    );
    expect([403, 404]).toContain(otherConfirm.status());
    const display = await mutate(
      one.context.request,
      `/api/guest/messages/${accepted.id}/display`,
      {},
      one.csrf,
    );
    expect(display.ok(), await display.text()).toBeTruthy();
    expect(
      (await view(alex, v.id)).items.find((i) => i.id === accepted.id)
        ?.deliveryStatus,
    ).toBe("DISPLAYED");
    const confirm = await mutate(
      one.context.request,
      `/api/guest/messages/${accepted.id}/confirm`,
      {},
      one.csrf,
    );
    expect(confirm.ok(), await confirm.text()).toBeTruthy();
    expect(
      (await view(alex, v.id)).items.find((i) => i.id === accepted.id)
        ?.deliveryStatus,
    ).toBe("CONFIRMED");
    const noCaptions = await (
      await one.context.request.get("/api/guest")
    ).json();
    expect(
      noCaptions.messages.every((i: { kind: string }) => i.kind === "message"),
    ).toBe(true);
  } finally {
    await Promise.all([
      alex.context.close(),
      one.context.close(),
      two.context.close(),
    ]);
  }
});
