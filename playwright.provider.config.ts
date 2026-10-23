import { defineConfig, devices } from "@playwright/test";

// Playwright otherwise captures a DOM/ARIA error snapshot, which could contain real captions.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
const runId = process.env.CAPTIONDOOR_SMOKE_RUN_ID || "blocked";
const safeRunId = /^[0-9a-f-]{36}$/.test(runId) ? runId : "blocked";
export default defineConfig({
  testDir: "./tests/provider",
  testMatch: "playground.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 100_000,
  expect: { timeout: 4000 },
  outputDir: `output/provider-smoke/${safeRunId}/test-artifacts`,
  reporter: [["./tests/provider/sanitized-reporter.ts"]],
  use: {
    baseURL: "http://127.0.0.1:3410",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
