// TestZeus Playwright fixture. Generated specs import { test, expect } from here and
// use the injected `tz` runtime to read inputs/test data/environment/files and to write
// outputs. The fixture flushes collected outputs on teardown for the Python post step.
//
// Auto-captures ALL browser-initiated network traffic to api_logs.log / soql_logs.log
// so the API and SOQL trace viewers render without requiring explicit tz.api() calls.

import { test as base, expect } from "@playwright/test";
import type { Request, Response } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { TzEmail } from "./tz-email";
import { TzRuntime } from "./tz-runtime";
import { TzSalesforce } from "./tz-salesforce";

// Salesforce REST/SOQL URL patterns — requests matching these go to soql_logs.log
const SF_API_PATTERNS = [
  /\/services\/data\/v\d+\.\d+\//,
  /\/services\/apexrest\//,
  /\/services\/Soap\//,
  /\/composite\//,
];

// URLs to skip logging (static assets, analytics, internal Playwright)
const SKIP_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|css|js)(\?|$)/i,
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /fonts\.googleapis\.com/,
  /cdn\.segment\.com/,
  /sentry\.io/,
  /^data:/,
  /^chrome-extension:/,
  /playwright.*internal/i,
];

function shouldSkip(url: string): boolean {
  return SKIP_PATTERNS.some(p => p.test(url));
}

function isSalesforceApi(url: string): boolean {
  return SF_API_PATTERNS.some(p => p.test(url));
}

type TzWithExtensions = TzRuntime & {
  shot: (stepId: string) => Promise<void>;
  salesforce: TzSalesforce;
  email: TzEmail | null;
};

export const test = base.extend<{ tz: TzWithExtensions }>({
  tz: async ({ page, request }, use, testInfo) => {
    const root = process.env.TZ_ROOT || process.cwd();
    const runtime = new TzRuntime(root);
    const sfHelper = new TzSalesforce(request, runtime.trace);
    const emailConfig = runtime.emailConfig;
    const emailHelper = emailConfig ? new TzEmail(request, emailConfig, runtime.trace, root) : null;
    const trace = runtime.trace;

    // --- Auto-capture browser network traffic for API/SOQL trace viewers ---
    const pendingRequests = new Map<Request, { method: string; url: string; startMs: number }>();

    page.on("request", (req: Request) => {
      const url = req.url();
      if (shouldSkip(url)) return;

      const method = req.method();
      const headers = req.headers();
      let body: unknown = null;
      try { body = req.postData() ?? null; } catch { /* no body */ }

      pendingRequests.set(req, { method, url, startMs: Date.now() });

      if (isSalesforceApi(url)) {
        trace.soqlRequest({ method, url, headers, body });
      } else {
        trace.apiRequest(method, url, headers, body);
      }
    });

    page.on("response", async (resp: Response) => {
      const req = resp.request();
      const pending = pendingRequests.get(req);
      if (!pending) return;
      pendingRequests.delete(req);

      const { method, url } = pending;
      const status = resp.status();
      const headers = resp.headers();
      let body: unknown = null;
      try {
        const ct = headers["content-type"] ?? "";
        if (ct.includes("json") || ct.includes("text")) {
          body = await resp.text().catch(() => null);
        }
      } catch { /* best-effort */ }

      if (isSalesforceApi(url)) {
        trace.soqlResponse(method, url, status, headers, body);
      } else {
        trace.apiResponse(status, headers, body);
      }
    });

    // --- Auto-initialize Salesforce flow capture if credentials are available ---
    // Credentials are injected via runtime-context.json + secrets overlay into
    // runtime.environment (keyed by env record name or ID). Scan all env entries
    // for instance_url + session_id fields.
    let sfInstanceUrl: string | undefined;
    let sfAccessToken: string | undefined;

    for (const envData of Object.values(runtime.environment ?? {})) {
      const env = envData as Record<string, unknown> | undefined;
      if (!env) continue;
      const url = (env.instance_url ?? env.sf_instance_url) as string | undefined;
      const token = (env.session_id ?? env.sf_session_id ?? env.access_token ?? env.sf_access_token) as string | undefined;
      if (url && token) {
        sfInstanceUrl = String(url);
        sfAccessToken = String(token);
        break;
      }
    }

    // Also check testdata entries (some orgs store SF creds in test_data)
    if (!sfInstanceUrl || !sfAccessToken) {
      for (const tdData of Object.values(runtime.testdata ?? {})) {
        const td = tdData as Record<string, unknown> | undefined;
        if (!td) continue;
        const url = (td.instance_url ?? td.sf_instance_url) as string | undefined;
        const token = (td.session_id ?? td.sf_session_id ?? td.access_token ?? td.sf_access_token) as string | undefined;
        if (url && token) {
          sfInstanceUrl = String(url);
          sfAccessToken = String(token);
          break;
        }
      }
    }

    let sfAutoInitialized = false;
    if (sfInstanceUrl && sfAccessToken && typeof sfInstanceUrl === "string" && typeof sfAccessToken === "string") {
      try {
        console.log(`[tz-sf] Path1: upfront init with instance_url=${sfInstanceUrl.substring(0, 30)}...`);
        sfHelper.init(sfInstanceUrl, sfAccessToken);
        const ok = await sfHelper.setupTraceFlag();
        if (ok) {
          sfAutoInitialized = true;
          console.log("[tz-sf] Path1: TraceFlag setup SUCCESS");
        } else {
          console.warn("[tz-sf] Path1: setupTraceFlag returned false — will fall back to browser cookie path");
        }
      } catch (e) {
        console.warn(`[tz-sf] Path1: setupTraceFlag threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.log(`[tz-sf] Path1: no upfront creds found (url=${!!sfInstanceUrl}, token=${!!sfAccessToken})`);
    }

    // If creds weren't available upfront (browser-login flow), set up TraceFlag
    // as soon as the browser authenticates to Salesforce (first successful SF page load).
    if (!sfAutoInitialized) {
      let sfSetupInFlight = false;
      let sfSetupAttempts = 0;
      page.on("response", async (resp) => {
        if (sfAutoInitialized || sfSetupInFlight || sfSetupAttempts >= 3) return;
        const url = resp.url();
        if (resp.status() < 200 || resp.status() >= 400) return;
        if (!url.includes(".salesforce.com") && !url.includes(".force.com") && !url.includes(".lightning.force.com")) return;
        try {
          const cookies = await page.context().cookies();
          const sidCookie = cookies.find(c => c.name === "sid");
          if (!sidCookie?.value) return;
          sfSetupInFlight = true;
          sfSetupAttempts++;
          const origin = new URL(url).origin;
          console.log(`[tz-sf] Path2: detected SF response, sid cookie found, attempt ${sfSetupAttempts}`);
          sfHelper.init(origin, sidCookie.value);
          const ok = await sfHelper.setupTraceFlag();
          if (ok) {
            sfAutoInitialized = true;
            console.log("[tz-sf] Path2: TraceFlag setup SUCCESS");
          } else {
            console.warn("[tz-sf] Path2: setupTraceFlag returned false");
            sfSetupInFlight = false;
          }
        } catch (e) {
          console.warn(`[tz-sf] Path2: setupTraceFlag threw: ${e instanceof Error ? e.message : String(e)}`);
          sfSetupInFlight = false;
        }
      });
    }

    const tz = Object.assign(runtime, {
      shot: async (stepId: string) => {
        const screenshotPath = join(root, "results", `${stepId}.png`);
        mkdirSync(dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach(`step-${stepId}`, {
          path: screenshotPath,
          contentType: "image/png",
        });
      },
      salesforce: sfHelper,
      email: emailHelper,
    }) as TzWithExtensions;

    await use(tz);

    // --- Adaptive time-budgeted teardown ---
    // Extend the test timeout to give teardown its own budget (up to 90s extra).
    // This prevents the expensive SF flow collection from being killed by the
    // test timeout when the test itself failed early.
    const TEARDOWN_BUDGET_MS = 90_000;
    const MIN_BUDGET_FOR_FLOWS_MS = 20_000;
    testInfo.setTimeout(testInfo.timeout + TEARDOWN_BUDGET_MS);
    const teardownDeadline = Date.now() + TEARDOWN_BUDGET_MS;

    console.log(`[tz-sf] Teardown: sfAutoInitialized=${sfAutoInitialized}, budget=${TEARDOWN_BUDGET_MS / 1000}s`);
    if (!sfAutoInitialized) {
      try {
        const cookies = await page.context().cookies();
        const sidCookie = cookies.find(c => c.name === "sid");
        console.log(`[tz-sf] Teardown fallback: sid cookie ${sidCookie ? "FOUND" : "NOT FOUND"}`);
        if (sidCookie) {
          const pageUrl = page.url();
          let sfHost: string | undefined;
          if (pageUrl.includes(".salesforce.com") || pageUrl.includes(".force.com")) {
            sfHost = new URL(pageUrl).origin;
          } else if (sidCookie.domain) {
            sfHost = `https://${sidCookie.domain.replace(/^\./, "")}`;
          }
          if (!sfHost) {
            for (const envData of Object.values(runtime.environment ?? {})) {
              const env = envData as Record<string, unknown> | undefined;
              const url = (env?.instance_url ?? env?.sf_instance_url) as string | undefined;
              if (url) { sfHost = String(url); break; }
            }
          }
          if (!sfHost) {
            for (const tdData of Object.values(runtime.testdata ?? {})) {
              const td = tdData as Record<string, unknown> | undefined;
              const url = (td?.instance_url ?? td?.sf_instance_url) as string | undefined;
              if (url) { sfHost = String(url); break; }
            }
          }
          if (sfHost && sidCookie.value) {
            console.log(`[tz-sf] Teardown fallback: late-init with host=${sfHost.substring(0, 30)}`);
            sfHelper.init(sfHost, sidCookie.value);
            sfAutoInitialized = true;
            try {
              await sfHelper.setupTraceFlag();
              console.log("[tz-sf] Teardown fallback: late setupTraceFlag OK");
            } catch {
              console.warn("[tz-sf] Teardown fallback: late setupTraceFlag failed (will still try collectFlows)");
            }
          } else {
            console.warn(`[tz-sf] Teardown fallback: cannot init (host=${!!sfHost}, sid=${!!sidCookie.value})`);
          }
        }
      } catch (e) {
        console.warn(`[tz-sf] Teardown fallback threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (sfAutoInitialized) {
      const remainingBudget = teardownDeadline - Date.now();
      console.log(`[tz-sf] Teardown: remaining budget=${Math.round(remainingBudget / 1000)}s`);

      // Adaptive initial wait: use 10s if budget allows, otherwise proportional (min 2s)
      const initialWait = Math.min(10_000, Math.max(2_000, remainingBudget - MIN_BUDGET_FOR_FLOWS_MS));
      console.log(`[tz-sf] Teardown: adaptive initial wait=${Math.round(initialWait / 1000)}s`);
      await new Promise(r => setTimeout(r, initialWait));

      const budgetAfterWait = teardownDeadline - Date.now();
      if (budgetAfterWait >= MIN_BUDGET_FOR_FLOWS_MS) {
        try {
          console.log(`[tz-sf] Teardown: calling collectFlows() with ${Math.round(budgetAfterWait / 1000)}s budget`);
          await sfHelper.collectFlows(teardownDeadline - 5_000);
          console.log("[tz-sf] Teardown: collectFlows() completed");
        } catch (e) {
          console.warn(`[tz-sf] Teardown: collectFlows threw: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.warn(`[tz-sf] Teardown: skipping collectFlows — insufficient budget (${Math.round(budgetAfterWait / 1000)}s < ${MIN_BUDGET_FOR_FLOWS_MS / 1000}s needed)`);
        runtime.trace.flowMetadata({
          flow_name: "__tz_diagnostic",
          flow_label: `collectFlows skipped — teardown budget exhausted (${Math.round(budgetAfterWait / 1000)}s remaining)`,
          process_type: "diagnostic",
          trigger_type: "none",
          trigger_object: "none",
        });
      }
      try {
        await sfHelper.cleanupTraceFlag();
      } catch { /* best-effort */ }
    } else {
      console.error("[tz-sf] Teardown: FAILED — sfAutoInitialized=false, no SF auth available");
      runtime.trace.flowMetadata({
        flow_name: "__tz_diagnostic",
        flow_label: "sfAutoInitialized=false at teardown — no SF auth available",
        process_type: "diagnostic",
        trigger_type: "none",
        trigger_object: "none",
      });
    }

    // Save storage state on teardown (matches Hercules backup_auth_state)
    try {
      const resultsDir = join(root, "results");
      mkdirSync(resultsDir, { recursive: true });
      const ssPath = join(resultsDir, "storage-state.json");
      await page.context().storageState({ path: ssPath });
    } catch { /* best-effort: fails in headless with no pages */ }

    runtime.flush();
  },
});

export { expect };
