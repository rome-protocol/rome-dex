import { defineConfig, devices } from "@playwright/test";

// Base URL is overridable (E2E_BASE_URL) so the suite can run against a fresh
// server on an alternate port without clobbering another running instance.
// Default stays :3200.
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3200";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // tests share a live pool — serialize to avoid nonce races
  retries: 1,
  timeout: 60_000,
  reporter: [["line"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    headless: true,
    // Give real on-chain calls up to 120s
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // Wallet-only app — no backend signer key required.
    command: "rm -rf .next && npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
