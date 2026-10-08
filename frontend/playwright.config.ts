import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // Every test resets the one shared fake server (POST /e2e/reset), so tests can't run side by side.
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8799", viewport: { width: 1500, height: 1000 } },
  webServer: {
    command: "uv run python tests/e2e_server.py",
    cwd: "..",
    url: "http://127.0.0.1:8799/api/session",
    reuseExistingServer: false,
  },
});
