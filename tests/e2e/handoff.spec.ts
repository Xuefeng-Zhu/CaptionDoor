import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import {
  command,
  consent,
  freshVisit,
  guest,
  mutate,
  resident,
  view,
} from "./helpers";

// All event/media/transcript inputs here are explicitly LOCAL demo fixtures.
// The real HTTP, sockets and DynamoDB paths are exercised, never Ring/AWS providers.
test("rendered handoff retains responsibility until acceptance and fences the old handler before explicit web reply, acknowledgement and closure", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const alex = await resident(browser, "alex"),
    sam = await resident(browser, "sam"),
    visitor = await guest(browser),
    otherVisitor = await guest(browser);
  const evidenceDir =
    process.env.CAPTIONDOOR_EVIDENCE_DIR || "output/playwright";
  let ownVisitId: string | undefined;
  try {
    await consent(alex);
    const visit = await freshVisit(alex);
    ownVisitId = visit.id;
    const [alexPage, samPage, guestPage, otherPage] = await Promise.all([
      alex.context.newPage(),
      sam.context.newPage(),
      visitor.context.newPage(),
      otherVisitor.context.newPage(),
    ]);
    await alexPage.setViewportSize({ width: 320, height: 900 });
    await samPage.setViewportSize({ width: 320, height: 900 });
    await Promise.all([
      alexPage.goto("/home"),
      guestPage.goto("/door/front-demo"),
      otherPage.goto("/door/front-demo"),
    ]);
    await alexPage
      .getByRole("button", { name: "I’ll handle this.", exact: true })
      .click();
    await expect(alexPage).toHaveURL(`/visits/${visit.id}`);
    await samPage.goto(`/visits/${visit.id}`);
    await expect(
      samPage.getByRole("heading", {
        name: "Alex is handling this.",
        exact: true,
      }),
    ).toBeVisible();

    const requestText = `Fictional delivery handoff ${visit.id.slice(-6)}.`,
      isolatedText = `Separate fictional visitor ${visit.id.slice(-6)}.`;
    await guestPage
      .getByRole("textbox", { name: "Your message", exact: true })
      .fill(requestText);
    await guestPage
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await otherPage
      .getByRole("textbox", { name: "Your message", exact: true })
      .fill(isolatedText);
    await otherPage
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      guestPage.getByText(requestText, { exact: true }),
    ).toBeVisible();
    await expect(
      otherPage.getByText(isolatedText, { exact: true }),
    ).toBeVisible();
    await alexPage.locator(".optional-visitor-text > summary").click();
    const candidate = alexPage
      .locator(".candidate-thread")
      .filter({ hasText: requestText });
    await expect(candidate).toBeVisible();
    await candidate
      .getByRole("button", { name: "Associate thread", exact: true })
      .click();
    await alexPage.locator(".optional-visitor-text > summary").click();

    await alexPage
      .getByRole("button", { name: "Start Demo transcript", exact: true })
      .click();
    await expect(alexPage.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
    await expect(alexPage.locator(".fixture-label")).toContainText(
      "Demo transcript",
    );
    const captured = (await view(alex, visit.id)).visit;
    expect(captured.audioLease?.holderId).toBe(alex.userId);
    expect(captured.mediaSource).toBe("LOCAL_FIXTURE");
    expect(captured.transcriptSource).toBe("FIXTURE");
    expect(captured.mediaSessionId).toBeTruthy();
    const leaseId = captured.audioLease!.id;

    await alexPage
      .locator("summary")
      .filter({ hasText: "Hand over responsibility" })
      .click();
    await alexPage
      .getByRole("combobox", { name: "Household member", exact: true })
      .selectOption(sam.userId);
    await alexPage
      .getByRole("button", { name: "Request handoff", exact: true })
      .click();
    await expect(
      samPage.getByRole("button", { name: "Accept handoff", exact: true }),
    ).toBeVisible();
    await expect(alexPage.locator(".mobile-handoff")).toContainText(
      "Alex remains responsible until acceptance.",
    );
    let pending = (await view(alex, visit.id)).visit;
    expect(pending.handlerId).toBe(alex.userId);
    expect(pending.pendingHandoff?.targetUserId).toBe(sam.userId);
    expect(pending.audioLease?.id).toBe(leaseId);
    expect(
      (await view(alex, visit.id)).items.some(
        (item) => item.direction === "resident",
      ),
    ).toBe(false);
    await mkdir(evidenceDir, { recursive: true });
    await alexPage.screenshot({
      path: `${evidenceDir}/handoff-pending-320.png`,
      fullPage: true,
    });

    await alexPage
      .getByRole("button", { name: "Cancel handoff", exact: true })
      .click();
    await expect(
      samPage.getByRole("button", { name: "Accept handoff", exact: true }),
    ).toHaveCount(0);
    pending = (await view(alex, visit.id)).visit;
    expect(pending.pendingHandoff).toBeUndefined();
    expect(pending.handlerId).toBe(alex.userId);
    expect(pending.audioLease?.id).toBe(leaseId);
    await alexPage
      .getByRole("button", { name: "Request handoff", exact: true })
      .click();
    await samPage
      .getByRole("button", { name: "Accept handoff", exact: true })
      .click();
    await expect(
      samPage.getByRole("heading", {
        name: "You’re handling this.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      alexPage.getByRole("heading", {
        name: "Sam is handling this.",
        exact: true,
      }),
    ).toBeVisible();
    let accepted = (await view(sam, visit.id)).visit;
    expect(accepted.handlerId).toBe(sam.userId);
    expect(accepted.pendingHandoff).toBeUndefined();
    expect(accepted.audioLease).toBeUndefined();
    expect(accepted.mediaSessionId).toBeUndefined();
    expect(accepted.mediaStatus).toBe("ENDED");
    await expect(
      alexPage.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toHaveCount(0);
    await expect(
      alexPage.getByRole("button", {
        name: "Start Demo transcript",
        exact: true,
      }),
    ).toHaveCount(0);

    for (const input of [
      {
        type: "reply",
        threadId: visitor.threadId,
        text: "Stale handler must not send.",
      },
      { type: "capture", consent: true },
    ]) {
      const denied = await command(alex, visit.id, {
        ...input,
        expectedVersion: accepted.version,
      });
      expect(denied.status()).toBe(403);
      expect((await denied.json()).error.code).toBe("NOT_HANDLER");
    }
    const deniedFixture = await mutate(
      alex.context.request,
      "/api/demo/captions",
      { visitId: visit.id, consent: true },
      alex.csrf,
    );
    expect(deniedFixture.status()).toBe(403);
    expect((await deniedFixture.json()).error.code).toBe("HANDLER_REQUIRED");
    expect(
      (await view(sam, visit.id)).items.some(
        (item) => item.direction === "resident",
      ),
    ).toBe(false);

    await samPage.locator(".optional-visitor-text > summary").click();
    const replyText = "I’m coming to the door. Please wait.";
    await samPage
      .getByRole("textbox", { name: "Your reply", exact: true })
      .fill(replyText);
    expect(
      (await view(sam, visit.id)).items.some(
        (item) => item.direction === "resident",
      ),
    ).toBe(false);
    await visitor.context.setOffline(true);
    await expect(
      guestPage.getByText("You’re offline.", { exact: true }),
    ).toBeVisible();
    await samPage
      .getByRole("button", { name: "Send to visitor page", exact: true })
      .click();
    await expect(
      samPage.getByText("Accepted · awaiting display", { exact: true }),
    ).toBeVisible();
    expect(
      (await view(sam, visit.id)).items.find(
        (item) => item.direction === "resident",
      )?.deliveryStatus,
    ).toBe("ACCEPTED");
    await visitor.context.setOffline(false);
    await expect(guestPage.locator(".guest-reply p")).toHaveText(replyText);
    await guestPage.locator(".guest-reply").scrollIntoViewIfNeeded();
    await expect(
      samPage.getByText("Displayed on visitor page", { exact: true }),
    ).toBeVisible();
    await expect(
      samPage.getByText("Confirmed · visitor chose “Got it”", { exact: true }),
    ).toHaveCount(0);
    await guestPage
      .getByRole("button", { name: "Got it", exact: true })
      .click();
    await expect(
      samPage.getByText("Confirmed · visitor chose “Got it”", { exact: true }),
    ).toBeVisible();
    await expect(
      guestPage.getByText("Do not leave it.", { exact: true }),
    ).toHaveCount(0);
    await expect(otherPage.getByText(replyText, { exact: true })).toHaveCount(
      0,
    );
    await expect(otherPage.getByText(requestText, { exact: true })).toHaveCount(
      0,
    );
    const isolated = await (
      await otherVisitor.context.request.get("/api/guest")
    ).json();
    expect(isolated.thread.id).toBe(otherVisitor.threadId);
    expect(
      isolated.messages.some(
        (item: { text: string; kind: string }) =>
          item.text === replyText ||
          item.text === requestText ||
          item.kind === "caption",
      ),
    ).toBe(false);
    expect(Object.keys(isolated.thread).sort()).toEqual([
      "associated",
      "category",
      "expiresAt",
      "id",
    ]);
    expect(
      (await visitor.context.request.get(`/api/visits/${visit.id}`)).status(),
    ).toBe(401);
    await samPage.locator(".messages-card").screenshot({
      path: `${evidenceDir}/handoff-confirmed-conversation-320.png`,
    });
    await samPage.locator(".optional-visitor-text > summary").click();
    await samPage.evaluate(() => window.scrollTo(0, 0));
    await samPage.screenshot({
      path: `${evidenceDir}/handoff-accepted-320.png`,
      fullPage: true,
    });

    await samPage
      .locator("summary")
      .filter({ hasText: "Close this visit" })
      .click();
    await samPage
      .getByRole("combobox", { name: "Outcome", exact: true })
      .selectOption("COMPLETED");
    await samPage
      .getByRole("button", { name: "Close visit", exact: true })
      .click();
    await expect(
      samPage.getByRole("heading", {
        name: "This visit is closed.",
        exact: true,
      }),
    ).toBeVisible();
    accepted = (await view(sam, visit.id)).visit;
    expect(accepted.status).toBe("CLOSED");
    expect(accepted.outcome).toBe("COMPLETED");
    expect(accepted.handlerId).toBe(sam.userId);
    await samPage.reload();
    await expect(
      samPage.getByRole("heading", {
        name: "This visit is closed.",
        exact: true,
      }),
    ).toBeVisible();
    await samPage.screenshot({
      path: `${evidenceDir}/handoff-closed-320.png`,
      fullPage: true,
    });
  } finally {
    try {
      if (ownVisitId) {
        const state = (await view(alex, ownVisitId)).visit;
        const handler = state.handlerId === sam.userId ? sam : alex;
        if (state.status === "CLAIMED") {
          const result = await command(handler, ownVisitId, {
            type: "close",
            expectedVersion: state.version,
            outcome: "NO_RESPONSE_RECORDED",
          });
          expect(result.ok()).toBe(true);
        }
      }
    } finally {
      await Promise.all([
        alex.context.close(),
        sam.context.close(),
        visitor.context.close(),
        otherVisitor.context.close(),
      ]);
    }
  }
});
