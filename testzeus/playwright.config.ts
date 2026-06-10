import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The TestZeus GKE runner writes runtime-context.json next to this config (Phase 4):
//   { baseURL, browser, headed, timeoutMs, retries, storageStatePath, ... }
// Locally it is optional; sensible defaults apply.
const here = dirname(fileURLToPath(import.meta.url));
const ctxPath = resolve(here, "runtime-context.json");
const ctx = existsSync(ctxPath)
  ? JSON.parse(readFileSync(ctxPath, "utf8"))
  : {};

const storageState =
  ctx.storageStatePath && existsSync(resolve(here, ctx.storageStatePath))
    ? resolve(here, ctx.storageStatePath)
    : undefined;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: ctx.retries ?? 0,
  timeout: ctx.timeoutMs ?? 14_400_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [
    ["./tz-progress-reporter.ts"],
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "results/report.json" }],
  ],
  use: {
    baseURL: ctx.baseURL ?? process.env.BASE_URL,
    headless: ctx.headed ? false : true,
    actionTimeout: 15_000,
    storageState,
    trace: "on",
    video: "on",
    screenshot: "on",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
