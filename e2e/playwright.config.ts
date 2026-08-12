import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Builds the SPA, then starts a test-only server that serves the built
    // SPA and the API on 5173 with an in-memory seeded database. Passkey
    // ceremonies use a CDP virtual authenticator with RP ID "localhost".
    command:
      "bun run --cwd ../frontend build && bun run ../backend/src/e2eServer.ts",
    url: "http://localhost:5173",
    // Always start a fresh server: the in-memory database must be re-seeded
    // for every run, so a leftover server on 5173 must not be reused.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
