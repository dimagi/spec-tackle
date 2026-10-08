/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = "http://127.0.0.1:8765";

export default defineConfig({
  base: "/static/dist/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../src/spec_tackle/static/dist",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": backend, "/auth": backend, "/raw": backend, "/static/favicon.svg": backend },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
