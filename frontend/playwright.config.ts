import { defineConfig, devices } from "@playwright/test";

// Minimal Playwright config for Arkon E2E. The dev stack is expected to be
// already running on http://localhost:3000 (Next.js dev) and the API at
// http://localhost:5055 — we do NOT start them here so tests can be invoked
// against either the dev or the Docker-built portal.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
