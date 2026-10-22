import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resident, origin } from "./helpers";
import { mkdir } from "node:fs/promises";
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
    result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
}
test("public screens support 320px, keyboard focus, large primary targets and reduced motion", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 320, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { name: "Make it your door." }),
    ).toBeVisible();
    await noOverflow(page);
    await axe(page);
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("link", { name: "Skip to content", exact: true }),
    ).toBeVisible();
    const targets = await page.locator(".button.primary").evaluateAll((nodes) =>
      nodes
        .map((n) => n.getBoundingClientRect())
        .filter((r) => r.width > 0)
        .map((r) => r.height),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const height of targets) expect(height).toBeGreaterThanOrEqual(48);
    await mkdir("output/playwright", { recursive: true });
    await page.screenshot({
      path: "output/playwright/onboarding-320.png",
      fullPage: true,
    });
    await page.goto("/door/front-demo");
    await expect(
      page.getByRole("textbox", { name: "Your message", exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await axe(page);
    await page
      .getByRole("textbox", { name: "Your message", exact: true })
      .focus();
    await expect(
      page.getByRole("textbox", { name: "Your message", exact: true }),
    ).toBeFocused();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "output/playwright/visitor-320.png",
      fullPage: true,
    });
    // 640 physical pixels at 200% layout zoom gives the 320 CSS-pixel reflow target.
    // This is a browser layout check, not a WCAG certification.
    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await noOverflow(page);
    await expect(
      page.getByRole("textbox", { name: "Your message", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "output/playwright/visitor-200percent.png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});
test("resident home, settings and local demo pass automated accessibility checks", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex");
  const page = await alex.context.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const route of ["/home", "/settings", "/demo"]) {
      await page.goto(route);
      await expect(page.locator("main h1")).toBeVisible();
      await axe(page);
      await noOverflow(page);
    }
    await page.goto("/home");
    await mkdir("output/playwright", { recursive: true });
    await page.screenshot({
      path: "output/playwright/home-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await noOverflow(page);
    await axe(page);
    await page.screenshot({
      path: "output/playwright/home-320.png",
      fullPage: true,
    });
  } finally {
    await alex.context.close();
  }
});
