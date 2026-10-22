import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, getItem, tables } from "../../packages/db/src/repository";
import {
  resident,
  guest,
  bootstrap,
  consent,
  freshVisit,
  command,
  view,
  mutate,
  type Resident,
} from "./helpers";

async function prepareSharedVisit(
  browser: Browser,
  scenario: "sharing" | "caption-grant",
) {
  const alex = await resident(browser, "alex");
  const sam = await resident(browser, "sam");
  const visitor = await guest(browser);
  try {
    await consent(alex);
    const visit = await freshVisit(alex);
    const claimed = await command(alex, visit.id, {
      type: "claim",
      expectedVersion: visit.version,
    });
    expect(claimed.ok(), await claimed.text()).toBeTruthy();
    const privateText = `Private delivery request ${visit.id.slice(-8)}.`;
    const sent = await mutate(
      visitor.context.request,
      "/api/guest/messages",
      {
        category: "Delivery",
        text: privateText,
      },
      visitor.csrf,
    );
    expect(sent.ok(), await sent.text()).toBeTruthy();
    const current = (await view(alex, visit.id)).visit;
    const associated = await command(alex, visit.id, {
      type: "associate",
      expectedVersion: current.version,
      threadId: visitor.threadId,
    });
    expect(associated.ok(), await associated.text()).toBeTruthy();
    const captions = await mutate(
      alex.context.request,
      "/api/demo/captions",
      {
        visitId: visit.id,
        consent: true,
      },
      alex.csrf,
    );
    expect(captions.ok(), await captions.text()).toBeTruthy();
    const queued = (await captions.json()) as { jobId: string };
    await expect
      .poll(
        async () =>
          (await view(alex, visit.id)).items
            .filter((item) => item.kind === "caption" && !item.isPartial)
            .map((item) => item.text),
        {
          message: `Final local fixture missing for visit ${visit.id}, job ${queued.jobId}.`,
        },
      )
      .toEqual(["Do not leave it."]);
    const page = await sam.context.newPage();
    await page.goto(`/visits/${visit.id}`);
    await expect(
      page.getByRole("heading", { name: "Alex is handling this." }),
    ).toBeVisible();
    await expect(page.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
    await expect(page.getByText(privateText, { exact: true })).toBeVisible();
    await page.locator(".events-panel summary").click();
    await expect(page.locator(".events-panel li").first()).toBeVisible();
    await mkdir("output/playwright", { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `output/playwright/privacy-${scenario}-before.png`,
      fullPage: true,
    });
    return { alex, sam, visitor, visitId: visit.id, privateText, page };
  } catch (error) {
    await Promise.all([
      alex.context.close(),
      sam.context.close(),
      visitor.context.close(),
    ]);
    throw error;
  }
}

async function expectHandlerRetainsContent(
  alex: Resident,
  visitId: string,
  privateText: string,
) {
  const retained = await view(alex, visitId);
  expect(
    retained.items.some(
      (item) => item.kind === "caption" && item.text === "Do not leave it.",
    ),
  ).toBe(true);
  expect(
    retained.items.some(
      (item) => item.kind === "message" && item.text === privateText,
    ),
  ).toBe(true);
  const handlerPage = await alex.context.newPage();
  try {
    await handlerPage.goto(`/visits/${visitId}`);
    await expect(handlerPage.locator(".caption-line p")).toHaveText(
      "Do not leave it.",
    );
    await expect(
      handlerPage.getByText(privateText, { exact: true }),
    ).toBeVisible();
  } finally {
    await handlerPage.close();
  }
}

async function closeVisit(alex: Resident, visitId: string) {
  const latest = (await view(alex, visitId)).visit;
  if (latest.status !== "CLOSED") {
    const closed = await command(alex, visitId, {
      type: "close",
      expectedVersion: latest.version,
      outcome: "NO_RESPONSE_RECORDED",
    });
    expect(closed.ok(), await closed.text()).toBeTruthy();
  }
}

function observeNavigations(page: Page) {
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  return () => navigations;
}

test("withdrawing household sharing purges already-rendered captions and visitor text without closing the visit", async ({
  browser,
}) => {
  const fixture = await prepareSharedVisit(browser, "sharing");
  const { alex, sam, visitor, visitId, privateText, page } = fixture;
  const navigations = observeNavigations(page);
  try {
    const settings = (await bootstrap(alex)).settings;
    const changed = await mutate(
      alex.context.request,
      "/api/settings",
      {
        ...settings,
        consent: { ...settings.consent, sharing: false },
      },
      alex.csrf,
    );
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const denied = await view(sam, visitId); // Deliberately still HTTP200 for state/system access.
    expect(denied.access).toMatchObject({
      captions: false,
      visitorText: false,
    });
    expect(
      denied.items.some((item) => ["caption", "message"].includes(item.kind)),
    ).toBe(false);
    await expect(page.locator(".caption-line")).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Caption access is unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(privateText, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Visitor text access is unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Alex is handling this." }),
    ).toBeVisible();
    await expect(page.locator(".events-panel li").first()).toBeVisible();
    expect(navigations()).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "output/playwright/privacy-sharing-after.png",
      fullPage: true,
    });
    await expectHandlerRetainsContent(alex, visitId, privateText);
  } finally {
    try {
      await consent(alex);
      await closeVisit(alex, visitId);
    } finally {
      await Promise.all([
        alex.context.close(),
        sam.context.close(),
        visitor.context.close(),
      ]);
    }
  }
});

test("withdrawing the caption grant purges a mounted caption while retaining separately-authorized visitor text", async ({
  browser,
}) => {
  const fixture = await prepareSharedVisit(browser, "caption-grant");
  const { alex, sam, visitor, visitId, privateText, page } = fixture;
  const householdId = (await bootstrap(alex)).household.id;
  const memberKey = {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `MEMBER#${sam.userId}`,
  };
  const before = await getItem(tables.config, memberKey.PK, memberKey.SK);
  expect(before).toBeTruthy();
  const originalGrant = before!.grants.captions as boolean;
  const navigations = observeNavigations(page);
  try {
    await db.send(
      new UpdateCommand({
        TableName: tables.config,
        Key: memberKey,
        UpdateExpression: "SET grants.captions = :allowed",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":allowed": false },
      }),
    );
    const denied = await view(sam, visitId);
    expect(denied.access).toMatchObject({ captions: false, visitorText: true });
    expect(denied.items.some((item) => item.kind === "caption")).toBe(false);
    expect(
      denied.items.some(
        (item) => item.kind === "message" && item.text === privateText,
      ),
    ).toBe(true);
    await expect(page.locator(".caption-line")).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Caption access is unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(privateText, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Alex is handling this." }),
    ).toBeVisible();
    await expect(page.locator(".events-panel li").first()).toBeVisible();
    expect(navigations()).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "output/playwright/privacy-caption-grant-after.png",
      fullPage: true,
    });
    await expectHandlerRetainsContent(alex, visitId, privateText);
  } finally {
    try {
      // Restore only the changed permission; never replace the membership record.
      await db.send(
        new UpdateCommand({
          TableName: tables.config,
          Key: memberKey,
          UpdateExpression: "SET grants.captions = :allowed",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":allowed": originalGrant },
        }),
      );
      await consent(alex);
      await closeVisit(alex, visitId);
    } finally {
      await Promise.all([
        alex.context.close(),
        sam.context.close(),
        visitor.context.close(),
      ]);
    }
  }
});
