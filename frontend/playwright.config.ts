import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // Every test resets the one shared fake server (POST /e2e/reset), so tests can't run side by side.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8799",
    viewport: { width: 1500, height: 1000 },
    // The access cookie the launch link would set; tests/e2e_server.py uses this secret.
    storageState: {
      cookies: [{ name: "spec_tackle_key", value: "e2e", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
      origins: [],
    },
  },
  webServer: {
    command: "uv run python tests/e2e_server.py",
    cwd: "..",
    url: "http://127.0.0.1:8799/static/favicon.svg",
    reuseExistingServer: false,
  },
});
