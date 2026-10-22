import { test, expect } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import "../../packages/db/src/repository";
import { resident, consent, freshVisit, origin, view } from "./helpers";
test("raw-body signed webhook deduplicates semantic events and rejects tampering and unknown accounts", async ({
  browser,
  request,
}) => {
  const signingSecret =
    (process.env.RING_MODE || "demo") === "demo"
      ? process.env.LOCAL_SIGNING_SECRET
      : process.env.RING_WEBHOOK_SECRET;
  expect(
    !!signingSecret,
    "setup:local must configure an isolated local signing secret",
  ).toBe(true);
  const alex = await resident(browser, "alex");
  try {
    await consent(alex);
    const initial = await freshVisit(alex);
    const eventId = randomUUID();
    const payload = {
      meta: {
        version: "1.1",
        account_id: "demo-account",
        request_id: randomUUID(),
      },
      data: {
        id: eventId,
        type: "button_press",
        attributes: {
          source: "front-door",
          source_type: "devices",
          timestamp: Date.now(),
        },
      },
    };
    const raw = JSON.stringify(payload);
    const signature = (body: string) =>
      `sha256=${createHmac("sha256", signingSecret!).update(body).digest("hex")}`;
    const send = (body: string, sig = signature(body)) =>
      request.post(`${origin}/api/ring/webhook`, {
        data: body,
        headers: { "Content-Type": "application/json", "X-Signature": sig },
      });
    const before = (await view(alex, initial.id)).visit.version;
    const first = await send(raw);
    expect(first.ok(), await first.text()).toBeTruthy();
    const firstBody = await first.json();
    expect(firstBody.visit.id).toBe(initial.id);
    expect(firstBody.duplicate).toBe(false);
    const replay = await send(raw);
    expect(replay.ok(), await replay.text()).toBeTruthy();
    expect((await replay.json()).duplicate).toBe(true);
    const redelivery = JSON.stringify({
      ...payload,
      meta: { ...payload.meta, request_id: randomUUID() },
    });
    const semantic = await send(redelivery);
    expect(semantic.ok(), await semantic.text()).toBeTruthy();
    expect((await semantic.json()).duplicate).toBe(true);
    expect((await view(alex, initial.id)).visit.version).toBe(before + 1);
    const tampered = await send(raw + " ", signature(raw));
    expect(tampered.status()).toBe(401);
    const badSignature = await send(raw, "sha256=" + "0".repeat(64));
    expect(badSignature.status()).toBe(401);
    const invalidJson = await send("{", "sha256=" + "0".repeat(64));
    expect(invalidJson.status()).toBe(401);
    const unknown = JSON.stringify({
      ...payload,
      meta: {
        ...payload.meta,
        account_id: "unlinked-account",
        request_id: randomUUID(),
      },
    });
    const denied = await send(unknown);
    expect(denied.status()).toBe(403);
    expect((await view(alex, initial.id)).visit.version).toBe(before + 1);
  } finally {
    await alex.context.close();
  }
});
