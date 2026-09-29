import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "./tests/patchctl",
  testMatch: "localization-review.spec.ts",
  outputDir: "./.patchctl-results/localization",
  reporter: "list",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3112", browserName: "chromium" },
  webServer: {
    command: "pnpm --filter @corely/app dev --hostname 127.0.0.1 --port 3112",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: "http://127.0.0.1:3112/login",
    timeout: 120000,
    reuseExistingServer: false,
    env: { PATCHCTL_LEGACY_SERVER_CONTENT: "0" },
  },
});
