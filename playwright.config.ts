import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: `${process.env.CAPTIONDOOR_EVIDENCE_DIR || "output/playwright"}/test-artifacts`,
  reporter: [
    ["./tests/e2e/redacting-reporter.ts"],
    ["list"],
    [
      "html",
      {
        outputFolder: `${process.env.CAPTIONDOOR_EVIDENCE_DIR || "output/playwright"}/report`,
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3410",
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
