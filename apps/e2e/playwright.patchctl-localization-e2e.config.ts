import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "./tests/patchctl",
  testMatch: "localization-e2e.spec.ts",
  outputDir: "./.patchctl-results/localization-e2e",
  reporter: "list",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 20000 },
  use: { baseURL: "http://127.0.0.1:3113", browserName: "chromium" },
  webServer: {
    command: "node scripts/patchctl-demo-server.mjs",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: "http://127.0.0.1:3113/login",
    timeout: 120000,
    reuseExistingServer: false,
    env: { PATCHCTL_DEMO_PORT: "3113", PATCHCTL_LEGACY_SERVER_CONTENT: "0" },
  },
});
