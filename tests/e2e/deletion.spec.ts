import { test, expect } from "@playwright/test";
import {
  resident,
  guest,
  consent,
  freshVisit,
  command,
  view,
  mutate,
} from "./helpers";

test("explicit deletion purges the mounted guest and stale successful history cannot restore it", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex"),
    visitor = await guest(browser);
  let release: (() => void) | undefined;
  try {
    await consent(alex);
    let visit = await freshVisit(alex);
    visit = (
      await (
        await command(alex, visit.id, {
          type: "claim",
          expectedVersion: visit.version,
        })
      ).json()
    ).visit;
    const text = `Fictional deletion request ${visit.id.slice(-6)}.`;
    expect(
      (
        await mutate(
          visitor.context.request,
          "/api/guest/messages",
          { category: "Other", text },
          visitor.csrf,
        )
      ).ok(),
    ).toBe(true);
    visit = (
      await (
        await command(alex, visit.id, {
          type: "associate",
          threadId: visitor.threadId,
          expectedVersion: visit.version,
        })
      ).json()
    ).visit;
    visit = (
      await (
        await command(alex, visit.id, {
          type: "close",
          outcome: "NO_RESPONSE_RECORDED",
          expectedVersion: visit.version,
        })
      ).json()
    ).visit;
    const guestPage = await visitor.context.newPage(),
      owner = await alex.context.newPage();
    await guestPage.goto("/door/front-demo");
    await expect(guestPage.getByText(text, { exact: true })).toBeVisible();
    await owner.goto(`/visits/${visit.id}`);
    await expect(
      owner.getByRole("heading", {
        name: "This visit is closed.",
        exact: true,
      }),
    ).toBeVisible();
    let held = false;
    let captured!: () => void;
    const capturedResponse = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await guestPage.route("**/api/guest?**", async (route) => {
      if (held) {
        await route.continue();
        return;
      }
      held = true;
      try {
        const response = await route.fetch();
        captured();
        await released;
        await route.fulfill({ response });
      } catch {
        throw Error(
          "Local delayed history transport failed; request credentials redacted.",
        );
      }
    });
    await guestPage.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await capturedResponse;
    await owner
      .locator("summary")
      .filter({ hasText: "Delete retained conversation" })
      .click();
    await owner
      .getByRole("button", { name: "Request content deletion", exact: true })
      .click();
    await expect(owner).toHaveURL("/home");
    await expect(guestPage.getByText(text, { exact: true })).toHaveCount(0);
    await expect(guestPage.locator(".guest-compose")).toHaveCount(0);
    const denied = await visitor.context.request.get("/api/guest");
    expect([401, 403]).toContain(denied.status());
    const response = guestPage.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/guest" && r.status() === 200,
    );
    release!();
    await (await response).finished();
    await guestPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(guestPage.getByText(text, { exact: true })).toHaveCount(0);
    await expect(guestPage.locator(".guest-compose")).toHaveCount(0);
  } finally {
    release?.();
    await Promise.all([alex.context.close(), visitor.context.close()]);
  }
});

test("normal local app cannot activate the Playground provider-smoke bridge", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex");
  try {
    const health = await (await alex.context.request.get("/api/health")).json();
    expect(health.providerSmoke).toBe(false);
    expect(health.providerSmokeTablePrefix).toBeUndefined();
    const attempt = await mutate(
      alex.context.request,
      "/api/provider-smoke/press",
      { eventId: crypto.randomUUID() },
      alex.csrf,
    );
    expect(attempt.status()).toBe(403);
    expect((await attempt.json()).error.code).toBe("PROVIDER_SMOKE_DISABLED");
  } finally {
    await alex.context.close();
  }
});
