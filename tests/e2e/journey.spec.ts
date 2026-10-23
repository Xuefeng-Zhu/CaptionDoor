import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resident, origin, consent, freshVisit, view } from "./helpers";
import { mkdir, writeFile } from "node:fs/promises";
test("rendered resident and visitor journey requires explicit claim, association, send, acknowledgement and closure", async ({
  browser,
}) => {
  const evidenceDir =
    process.env.CAPTIONDOOR_EVIDENCE_DIR || "output/playwright";
  const alex = await resident(browser, "alex"),
    sam = await resident(browser, "sam");
  const guestContext = await browser.newContext({ baseURL: origin });
  try {
    await consent(alex);
    const visit = await freshVisit(alex);
    const [residentPage, secondResident, visitorPage] = await Promise.all([
      alex.context.newPage(),
      sam.context.newPage(),
      guestContext.newPage(),
    ]);
    await Promise.all([
      residentPage.goto("/home"),
      secondResident.goto("/home"),
    ]);
    await expect(
      residentPage.getByRole("heading", { name: "Someone rang the doorbell." }),
    ).toBeVisible();
    await residentPage
      .getByRole("button", { name: "I’ll handle this.", exact: true })
      .click();
    await expect(residentPage).toHaveURL(`/visits/${visit.id}`);
    await expect(
      residentPage.getByRole("heading", { name: "You’re handling this." }),
    ).toBeVisible();
    await secondResident.goto(`/visits/${visit.id}`);
    await expect(
      secondResident.getByRole("heading", { name: "Alex is handling this." }),
    ).toBeVisible();
    expect(
      (await view(alex, visit.id)).items.filter((i) => i.kind === "message"),
    ).toHaveLength(0);
    await residentPage.locator(".optional-visitor-text > summary").click();
    await expect(
      residentPage.getByText("No visitor page is associated yet.", {
        exact: true,
      }),
    ).toBeVisible();
    const captionStartedAt = Date.now();
    await residentPage
      .getByRole("button", { name: "Start Demo transcript", exact: true })
      .click();
    await expect(residentPage.locator(".caption-line")).toHaveCount(1);
    await expect(residentPage.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
    await expect(residentPage.locator(".caption-meta")).toContainText(
      "Finalized",
    );
    await expect(residentPage.locator(".fixture-label")).toBeVisible();
    const observedCaptionFinalMs = Date.now() - captionStartedAt;
    await visitorPage.goto("/door/front-demo");
    await expect(
      visitorPage.getByRole("textbox", { name: "Your message", exact: true }),
    ).toBeVisible();
    await visitorPage
      .getByRole("radio", { name: "Delivery", exact: false })
      .check();
    const requestText = `Signature required. Local UI test ${visit.id.slice(-6)}.`;
    await visitorPage
      .getByRole("textbox", { name: "Your message", exact: true })
      .fill(requestText);
    await visitorPage
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      visitorPage.getByText(
        "Your message was accepted. Keep this page open for replies.",
        { exact: true },
      ),
    ).toBeVisible();
    const candidate = residentPage
      .locator(".candidate-thread")
      .filter({ hasText: requestText });
    await expect(candidate).toBeVisible();
    await candidate
      .getByRole("button", { name: "Associate thread", exact: true })
      .click();
    await expect(
      residentPage.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toBeVisible();
    await residentPage
      .getByRole("button", { name: "I’m coming. Please wait.", exact: true })
      .click();
    await expect(
      residentPage.getByRole("textbox", { name: "Your reply", exact: true }),
    ).toHaveValue("I’m coming. Please wait.");
    expect(
      (await view(alex, visit.id)).items.filter(
        (i) => i.direction === "resident",
      ),
    ).toHaveLength(0);
    await guestContext.setOffline(true);
    await expect(
      visitorPage.getByText("You’re offline.", { exact: true }),
    ).toBeVisible();
    const replyStartedAt = Date.now();
    await residentPage
      .getByRole("button", { name: "Send to visitor page", exact: true })
      .click();
    await expect(
      residentPage.getByText("Accepted · awaiting display", { exact: true }),
    ).toBeVisible();
    expect(
      (await view(alex, visit.id)).items.find((i) => i.direction === "resident")
        ?.deliveryStatus,
    ).toBe("ACCEPTED");
    await guestContext.setOffline(false);
    await expect(visitorPage.locator(".guest-reply p")).toHaveText(
      "I’m coming. Please wait.",
    );
    await visitorPage.locator(".guest-reply").scrollIntoViewIfNeeded();
    await expect(
      residentPage.getByText("Displayed on visitor page", { exact: true }),
    ).toBeVisible();
    const observedVisitorReconnectDisplayMs = Date.now() - replyStartedAt;
    const confirmStartedAt = Date.now();
    await visitorPage
      .getByRole("button", { name: "Got it", exact: true })
      .click();
    await expect(
      visitorPage.getByText("You confirmed this reply", { exact: false }),
    ).toBeVisible();
    await expect(
      residentPage.getByText("Confirmed · visitor chose “Got it”", {
        exact: true,
      }),
    ).toBeVisible();
    const observedExplicitConfirmationMs = Date.now() - confirmStartedAt;
    const a11y = await new AxeBuilder({ page: residentPage })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      a11y.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      `${evidenceDir}/journey-observations.json`,
      JSON.stringify(
        {
          visitId: visit.id,
          eventSource: "LOCAL",
          mediaSource: "LOCAL_FIXTURE",
          transcriptSource: "FIXTURE",
          observedCaptionFinalMs,
          observedVisitorReconnectDisplayMs,
          observedExplicitConfirmationMs,
          note: "Single local Chromium observation, includes request/render/reconnect waiting; no latency target or cloud performance claim.",
        },
        null,
        2,
      ),
    );
    await Promise.all([
      residentPage.evaluate(() => window.scrollTo(0, 0)),
      visitorPage.evaluate(() => window.scrollTo(0, 0)),
    ]);
    await residentPage.screenshot({
      path: `${evidenceDir}/visit-desktop.png`,
      fullPage: true,
    });
    await visitorPage.screenshot({
      path: `${evidenceDir}/visitor-desktop.png`,
      fullPage: true,
    });
    await residentPage
      .locator("summary")
      .filter({ hasText: "Close this visit" })
      .click();
    await residentPage
      .getByRole("combobox", { name: "Outcome", exact: true })
      .selectOption("COMPLETED");
    await residentPage
      .getByRole("button", { name: "Close visit", exact: true })
      .click();
    await expect(
      residentPage.getByRole("heading", { name: "This visit is closed." }),
    ).toBeVisible();
    expect((await view(alex, visit.id)).visit.outcome).toBe("COMPLETED");
    await residentPage.reload();
    await expect(
      residentPage.getByRole("heading", { name: "This visit is closed." }),
    ).toBeVisible();
    await expect(residentPage.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
  } finally {
    await Promise.all([
      alex.context.close(),
      sam.context.close(),
      guestContext.close(),
    ]);
  }
});
