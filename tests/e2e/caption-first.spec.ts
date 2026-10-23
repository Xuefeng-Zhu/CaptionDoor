import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import type { ConversationItem, Visit } from "@captiondoor/domain";
import {
  command,
  consent,
  freshVisit,
  mutate,
  resident,
  view,
  type Resident,
} from "./helpers";

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

async function keyboardActivate(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
}

async function closeInBrowser(
  page: Page,
  outcome: "COMPLETED" | "NO_RESPONSE_RECORDED",
) {
  const summary = page
    .locator("summary")
    .filter({ hasText: "Close this visit" });
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await page
    .getByRole("combobox", { name: "Outcome", exact: true })
    .selectOption(outcome);
  await keyboardActivate(page, "Close visit");
  await expect(
    page.getByRole("heading", { name: "This visit is closed.", exact: true }),
  ).toBeVisible();
}

// Only the fictional visit created by this test is closed on a failed assertion.
// No guest session, local content deletion, or unrelated-tenant cleanup is needed.
async function closeOwnVisit(who: Resident, visitId: string | undefined) {
  if (!visitId) return;
  const current = (await view(who, visitId)).visit;
  if (current.status === "CLOSED") return;
  let owned = current;
  if (current.status === "UNCLAIMED") {
    const claimed = await command(who, visitId, {
      type: "claim",
      expectedVersion: current.version,
    });
    expect(claimed.ok(), await claimed.text()).toBeTruthy();
    owned = (await claimed.json()).visit as Visit;
  }
  const closed = await command(who, visitId, {
    type: "close",
    expectedVersion: owned.version,
    outcome: "NO_RESPONSE_RECORDED",
  });
  expect(closed.ok(), await closed.text()).toBeTruthy();
}

test("caption-first visit needs no visitor page: explicit start, scoped revisions, media expiry and recorded closure", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const alex = await resident(browser, "alex");
  const sam = await resident(browser, "sam");
  let visitId: string | undefined;
  try {
    await consent(alex);
    const visit = await freshVisit(alex);
    visitId = visit.id;
    const page = await alex.context.newPage();
    const other = await sam.context.newPage();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });

    let visitorRequests = 0;
    let captionStartRequests = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/guest/") || path.startsWith("/door/"))
        visitorRequests++;
      if (path === "/api/demo/captions") captionStartRequests++;
    });
    const received: ConversationItem[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        try {
          const message = JSON.parse(String(payload));
          // Keep only this synthetic caption's public fields; never socket URLs,
          // request headers, cookies, or authentication frames in evidence.
          if (
            message.type === "caption" &&
            message.caption?.source === "FIXTURE"
          )
            received.push(message.caption as ConversationItem);
        } catch {}
      });
    });

    await Promise.all([page.goto("/home"), other.goto("/home")]);
    await expect(
      page.getByRole("heading", {
        name: "Someone rang the doorbell.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      other.getByRole("heading", {
        name: "Someone rang the doorbell.",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await view(alex, visit.id)).items.filter(
        (item) => item.kind === "caption",
      ),
    ).toEqual([]);
    expect(captionStartRequests).toBe(0);

    await keyboardActivate(page, "I’ll handle this.");
    await expect(page).toHaveURL(`/visits/${visit.id}`);
    await expect(
      page.getByRole("heading", { name: "You’re handling this.", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".connection")).toHaveText("Connected");
    await other.goto(`/visits/${visit.id}`);
    await expect(
      other.getByRole("heading", {
        name: "Alex is handling this.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      other.getByRole("button", { name: "Start Demo transcript", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".caption-line")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start Demo transcript", exact: true }),
    ).toBeVisible();
    expect(
      await page
        .getByRole("button", { name: "Start Demo transcript", exact: true })
        .evaluate((node) => node.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(48);
    await expect(
      page.locator("summary").filter({ hasText: "Visitor text (optional)" }),
    ).toBeVisible();
    const optionalText = page.locator("details").filter({
      has: page
        .locator("summary")
        .filter({ hasText: "Visitor text (optional)" }),
    });
    await expect(optionalText).not.toHaveAttribute("open", "");
    await expect(
      page.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toBeHidden();

    const denied = await mutate(
      sam.context.request,
      "/api/demo/captions",
      { visitId: visit.id, consent: true },
      sam.csrf,
    );
    expect(denied.status()).toBe(403);
    const beforeStart = await view(alex, visit.id);
    expect(beforeStart.visit).toMatchObject({
      status: "CLAIMED",
      handlerId: alex.userId,
      mediaStatus: "IDLE",
      transcriptSource: "NONE",
    });
    expect(
      beforeStart.items.filter((item) =>
        ["caption", "message"].includes(item.kind),
      ),
    ).toEqual([]);
    expect(beforeStart.threads).toEqual([]);
    expect(received).toEqual([]);
    expect(captionStartRequests).toBe(0);

    await Promise.all([
      keyboardActivate(page, "Start Demo transcript"),
      expect(page.locator(".caption-line.partial .caption-meta")).toContainText(
        "Updating…",
      ),
    ]);
    await expect(page.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
    await expect(page.locator(".caption-meta")).toHaveText(
      "Finalized · Demo transcript",
    );
    await expect(page.locator(".fixture-label")).toContainText(
      "Demo transcript",
    );
    await expect(page.locator(".caption-line")).toHaveCount(1);
    await expect
      .poll(() => received.map((item) => item.text))
      .toEqual(["Do", "Do not", "Do not leave it."]);
    expect(received.map((item) => item.isPartial)).toEqual([true, true, false]);
    expect(
      new Set(received.map((item) => `${item.mediaSessionId}:${item.resultId}`))
        .size,
    ).toBe(1);
    expect(captionStartRequests).toBe(1);
    const started = await view(alex, visit.id);
    expect(started.visit).toMatchObject({
      eventSource: "LOCAL",
      mediaSource: "LOCAL_FIXTURE",
      transcriptSource: "FIXTURE",
      mediaStatus: "LIVE",
    });
    expect(
      started.items.filter((item) => item.kind === "caption"),
    ).toMatchObject([
      { text: "Do not leave it.", source: "FIXTURE", isPartial: false },
    ]);
    expect(started.items.filter((item) => item.kind === "message")).toEqual([]);
    expect(started.threads).toEqual([]);
    await expect(other.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
    // Partials remain readable without announcing every revision to a screen reader.
    await expect(page.locator(".caption-scroll")).not.toHaveAttribute(
      "aria-live",
      /assertive|polite/,
    );
    const size = page.getByRole("combobox", {
      name: "Caption text size",
      exact: true,
    });
    await size.focus();
    await expect(size).toBeFocused();
    await size.selectOption("36");
    expect(
      await page
        .locator(".caption-line p")
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
    ).toBe(36);
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
    await noOverflow(page);
    await axe(page);
    const evidenceDir =
      process.env.CAPTIONDOOR_EVIDENCE_DIR || "output/playwright";
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: `${evidenceDir}/caption-first-320.png`,
      fullPage: true,
    });
    // Browser layout zoom tests 320 CSS-pixel reflow; this is not a native Mac zoom check.
    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await noOverflow(page);
    await expect(page.locator(".caption-line p")).toBeVisible();
    await page.screenshot({
      path: `${evidenceDir}/caption-first-200percent.png`,
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    await page.setViewportSize({ width: 320, height: 800 });

    // Wait for the real local durable media-expiry job, rather than treating a
    // manual stop or browser disconnect as evidence that media naturally expired.
    await expect
      .poll(async () => (await view(alex, visit.id)).visit.mediaStatus, {
        timeout: 45_000,
      })
      .toBe("ENDED");
    const ended = await view(alex, visit.id);
    expect(ended.visit.mediaExpiresAt).toBeLessThanOrEqual(Date.now());
    expect(ended.visit.audioLease).toBeUndefined();
    expect(ended.visit.mediaSessionId).toBeUndefined();
    expect(ended.visit).toMatchObject({
      status: "CLAIMED",
      handlerId: alex.userId,
    });
    await expect(page.getByText("Media ended.", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start Demo transcript", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Handle the visit in person, then record an outcome.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
    await expect(
      page.getByRole("heading", { name: "You’re handling this.", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `${evidenceDir}/caption-first-media-ended-320.png`,
      fullPage: true,
    });

    await closeInBrowser(page, "COMPLETED");
    await expect(
      other.getByRole("heading", {
        name: "This visit is closed.",
        exact: true,
      }),
    ).toBeVisible();
    const closed = await view(alex, visit.id);
    expect(closed.visit).toMatchObject({
      status: "CLOSED",
      outcome: "COMPLETED",
    });
    expect(closed.items.filter((item) => item.kind === "message")).toEqual([]);
    expect(closed.threads).toEqual([]);
    expect(visitorRequests).toBe(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "This visit is closed.", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
    await expect(
      page.getByRole("button", { name: "Start Demo transcript", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `${evidenceDir}/caption-first-closed-320.png`,
      fullPage: true,
    });
  } finally {
    try {
      await closeOwnVisit(alex, visitId);
    } finally {
      await Promise.all([alex.context.close(), sam.context.close()]);
    }
  }
});

test("unavailable incoming audio never fabricates captions or requires a visitor phone before closure", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex");
  let visitId: string | undefined;
  try {
    await consent(alex);
    const visit = await freshVisit(alex);
    visitId = visit.id;
    const claim = await command(alex, visit.id, {
      type: "claim",
      expectedVersion: visit.version,
    });
    expect(claim.ok(), await claim.text()).toBeTruthy();
    const current = (await view(alex, visit.id)).visit;
    const unavailable = await command(alex, visit.id, {
      type: "media",
      action: "unavailable",
      expectedVersion: current.version,
    });
    expect(unavailable.ok(), await unavailable.text()).toBeTruthy();
    const page = await alex.context.newPage();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/visits/${visit.id}`);
    await expect(
      page.getByText("Incoming audio unavailable.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Handle the visit in person, then record an outcome.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".caption-line")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start Demo transcript", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "You’re handling this.", exact: true }),
    ).toBeVisible();
    const missing = await view(alex, visit.id);
    expect(missing.visit).toMatchObject({
      mediaStatus: "UNAVAILABLE",
      transcriptSource: "NONE",
      status: "CLAIMED",
    });
    expect(
      missing.items.filter((item) =>
        ["caption", "message"].includes(item.kind),
      ),
    ).toEqual([]);
    expect(missing.threads).toEqual([]);
    await noOverflow(page);
    await axe(page);
    const evidenceDir =
      process.env.CAPTIONDOOR_EVIDENCE_DIR || "output/playwright";
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: `${evidenceDir}/caption-first-no-audio-320.png`,
      fullPage: true,
    });
    await closeInBrowser(page, "NO_RESPONSE_RECORDED");
    expect((await view(alex, visit.id)).visit).toMatchObject({
      status: "CLOSED",
      outcome: "NO_RESPONSE_RECORDED",
    });
    await expect(
      page.getByText("No response recorded", { exact: true }),
    ).toBeVisible();
  } finally {
    try {
      await closeOwnVisit(alex, visitId);
    } finally {
      await alex.context.close();
    }
  }
});
