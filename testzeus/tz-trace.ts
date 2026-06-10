// TestZeus trace logger — producer side for SDET trace-viewer parity.
//
// The Hercules manual run writes NDJSON trace logs (api_logs.log, sql_logs.log,
// soql_logs.log, agent_logs.log) that the UIX API/SQL/SOQL/Agent trace viewers parse. The
// viewers discover these by attachment NAME, so the SDET run must emit byte-compatible NDJSON
// under results/<name>.log; the Python post step uploads each under the same name.
//
// This class writes those exact line shapes. A generated spec uses `tz.api(request)` to get an
// auto-logging APIRequestContext (covers API + Salesforce REST/SOQL), and `tz.trace.sql*` /
// `tz.trace.agentInteraction` to log DB/agent activity around its own driver calls. We only LOG
// here — we never invent results; the actual request/query is the generated test's own logic.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type Json = unknown;

const SENSITIVE_HEADER_NAMES = new Set(["authorization", "x-api-key", "cookie", "set-cookie"]);

function collectSecretValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.length >= 4) out.push(value);
    return out;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectSecretValues(nested, out);
    }
  }
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
}

function redactBody(body: Json, secretValues: readonly string[]): Json {
  if (body == null) return body;
  if (typeof body === "string") {
    let redacted = body;
    for (const secret of secretValues) {
      if (secret.length >= 4) redacted = redactBodyString(redacted, secret);
    }
    return redacted;
  }
  if (typeof body === "object") {
    if (Array.isArray(body)) {
      return body.map(item => redactBody(item, secretValues));
    }
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(body as Record<string, Json>)) {
      out[key] = redactBody(value, secretValues);
    }
    return out;
  }
  return body;
}

function redactBodyString(text: string, secret: string): string {
  if (!text.includes(secret)) return text;
  return text.split(secret).join("[REDACTED]");
}

// Hercules api/soql timestamps are local "%Y-%m-%d %H:%M:%S"; sql timestamps are ISO + "Z".
function localTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ApiResponseLike {
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
}

export interface SoqlRequestInit {
  method?: string;
  url?: string;
  toolName?: string;
  query?: string;
  objectName?: string;
  apiVersion?: string;
  apexCode?: string;
  headers?: Record<string, string>;
  body?: Json;
}

// --- Flow (flow_run_logs.log) — the UIX flow viewer parses NDJSON discriminated on `type`. ---
// Mirrors src/features/test-runs/utils/flow-trace-utils.ts in testzeus-hercules-uix. A generated
// spec that verifies a Salesforce (or analogous) process flow emits one metadata + one definition
// line per flow, one execution line per interview, optional coverage lines, and a final summary.
export interface FlowElementInput {
  element_name: string;
  element_type: string;
  timestamp?: string;
  status: "success" | "error" | "fault";
  details?: string;
  human_label?: string;
}

export interface FlowMetadataInput {
  flow_name: string;
  flow_label: string;
  process_type?: string;
  trigger_type?: string;
  trigger_object?: string;
  active_version_id?: string;
}

export interface FlowExecutionInput {
  run_index: number;
  flow_name: string;
  flow_label: string;
  process_type?: string;
  trigger_type?: string;
  trigger_object?: string;
  interview_id?: string;
  status: "completed" | "error" | "fault";
  start_time?: string;
  end_time?: string;
  duration_ms?: number;
  elements?: FlowElementInput[];
  errors?: string[];
  mermaid_diagram?: string;
  variable_assignments?: string[];
}

export interface FlowGraphNodeInput {
  name: string;
  element_type: string;
  label: string;
  connector_target?: string;
  fault_connector_target?: string;
  extra_connectors?: Array<{ target: string; label: string }>;
}

export interface FlowDefinitionInput {
  flow_name: string;
  flow_label: string;
  process_type?: string;
  trigger_type?: string;
  active_version_id?: string;
  nodes: FlowGraphNodeInput[];
  edges: Array<{ source: string; target: string; label?: string }>;
}

export interface FlowCoverageInput {
  flow_name: string;
  flow_label: string;
  total_elements: number;
  executed_elements: number;
  coverage_pct: number;
  executed_element_names?: string[];
  not_executed_element_names?: string[];
  errored_element_names?: string[];
  coverage_mermaid?: string;
}

export interface FlowSummaryInput {
  total_flows_detected: number;
  total_flows_executed: number;
  total_errors: number;
  time_window_minutes?: number;
}

export class TzTrace {
  private readonly resultsDir: string;
  private readonly secretValues: readonly string[];

  constructor(resultsDir: string, secretValues: readonly string[] = []) {
    this.resultsDir = resultsDir;
    this.secretValues = secretValues;
    mkdirSync(resultsDir, { recursive: true });
  }

  private redactPayload(
    headers: Record<string, string> = {},
    body?: Json,
  ): { headers: Record<string, string>; body: Json | null } {
    return {
      headers: redactHeaders(headers),
      body: body === undefined ? null : redactBody(body, this.secretValues),
    };
  }

  private append(fileName: string, obj: Record<string, Json>): void {
    try {
      appendFileSync(join(this.resultsDir, fileName), `${JSON.stringify(obj)}\n`, "utf8");
    } catch {
      // Tracing must never break the test run.
    }
  }

  private redactUrl(url: string): string {
    let redacted = url;
    for (const secret of this.secretValues) {
      if (secret.length >= 4 && redacted.includes(secret)) {
        redacted = redacted.split(secret).join("[REDACTED]");
      }
    }
    return redacted;
  }

  // --- API (api_logs.log) ----------------------------------------------------------------
  apiRequest(method: string, url: string, headers: Record<string, string> = {}, body?: Json): void {
    const redacted = this.redactPayload(headers, body);
    this.append("api_logs.log", {
      request_data: {
        timestamp: localTimestamp(),
        method,
        url: this.redactUrl(url),
        headers: redacted.headers,
        body: redacted.body,
      },
    });
  }

  apiResponse(status: number, headers: Record<string, string> = {}, body?: Json): void {
    const redacted = this.redactPayload(headers, body);
    this.append("api_logs.log", {
      response_data: {
        timestamp: localTimestamp(),
        status_code: status,
        headers: redacted.headers,
        body: redacted.body,
      },
    });
  }

  // --- SOQL (soql_logs.log) — API-shaped with Salesforce request metadata ----------------
  soqlRequest(init: SoqlRequestInit): void {
    const redacted = this.redactPayload(init.headers ?? {}, init.body ?? null);
    this.append("soql_logs.log", {
      request_data: {
        timestamp: localTimestamp(),
        method: init.method ?? "GET",
        url: this.redactUrl(init.url ?? ""),
        tool_name: init.toolName ?? "",
        query: init.query ?? "",
        object_name: init.objectName ?? "",
        api_version: init.apiVersion ?? "",
        apex_code: init.apexCode ?? "",
        headers: redacted.headers,
        body: redacted.body,
      },
    });
  }

  soqlResponse(method: string, url: string, status: number, headers: Record<string, string> = {}, body?: Json): void {
    const redacted = this.redactPayload(headers, body);
    this.append("soql_logs.log", {
      response_data: {
        timestamp: localTimestamp(),
        method,
        url: this.redactUrl(url),
        status_code: status,
        headers: redacted.headers,
        body: redacted.body,
      },
    });
  }

  // --- SQL (sql_logs.log) — event-per-line, grouped by execution_id ----------------------
  sqlStart(query: string, opts: { schemaName?: string; params?: Json } = {}): string {
    const executionId = genId();
    this.append("sql_logs.log", {
      event: "sql_query_start",
      execution_id: executionId,
      timestamp: isoTimestamp(),
      query,
      schema_name: opts.schemaName ?? "",
      params: opts.params ?? [],
    });
    return executionId;
  }

  sqlResult(executionId: string, result: { rowCount?: number; rows?: Json }): void {
    this.append("sql_logs.log", {
      event: "sql_query_result",
      execution_id: executionId,
      timestamp: isoTimestamp(),
      duration_ms: 0,
      row_count: result.rowCount ?? (Array.isArray(result.rows) ? result.rows.length : 0),
      rows: result.rows ?? [],
    });
  }

  sqlError(executionId: string, error: unknown): void {
    this.append("sql_logs.log", {
      event: "sql_query_error",
      execution_id: executionId,
      timestamp: isoTimestamp(),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // --- Agent (agent_logs.log) ------------------------------------------------------------
  agentInteraction(interaction: Record<string, Json>): void {
    this.append("agent_logs.log", { agent_interaction: { timestamp: localTimestamp(), ...interaction } });
  }

  // --- Flow (flow_run_logs.log) ----------------------------------------------------------
  flowMetadata(meta: FlowMetadataInput): void {
    this.append("flow_run_logs.log", {
      type: "flow_metadata",
      flow_name: meta.flow_name,
      flow_label: meta.flow_label,
      process_type: meta.process_type ?? "",
      trigger_type: meta.trigger_type ?? "",
      trigger_object: meta.trigger_object ?? "",
      active_version_id: meta.active_version_id ?? "",
    });
  }

  flowDefinition(def: FlowDefinitionInput): void {
    this.append("flow_run_logs.log", {
      type: "flow_definition",
      flow_name: def.flow_name,
      flow_label: def.flow_label,
      process_type: def.process_type ?? "",
      trigger_type: def.trigger_type ?? "",
      active_version_id: def.active_version_id ?? "",
      nodes: def.nodes,
      edges: def.edges,
    });
  }

  flowExecution(run: FlowExecutionInput): void {
    this.append("flow_run_logs.log", {
      type: "flow_execution",
      run_index: run.run_index,
      flow_name: run.flow_name,
      flow_label: run.flow_label,
      process_type: run.process_type ?? "",
      trigger_type: run.trigger_type ?? "",
      trigger_object: run.trigger_object ?? "",
      interview_id: run.interview_id ?? genId(),
      status: run.status,
      start_time: run.start_time ?? localTimestamp(),
      end_time: run.end_time ?? localTimestamp(),
      duration_ms: run.duration_ms ?? 0,
      elements: (run.elements ?? []).map(el => ({
        element_name: el.element_name,
        element_type: el.element_type,
        timestamp: el.timestamp ?? localTimestamp(),
        status: el.status,
        details: el.details ?? "",
        human_label: el.human_label ?? el.element_name,
      })),
      errors: run.errors ?? [],
      mermaid_diagram: run.mermaid_diagram ?? "",
      variable_assignments: run.variable_assignments ?? [],
    });
  }

  flowCoverage(cov: FlowCoverageInput): void {
    this.append("flow_run_logs.log", {
      type: "flow_coverage",
      flow_name: cov.flow_name,
      flow_label: cov.flow_label,
      total_elements: cov.total_elements,
      executed_elements: cov.executed_elements,
      coverage_pct: cov.coverage_pct,
      executed_element_names: cov.executed_element_names ?? [],
      not_executed_element_names: cov.not_executed_element_names ?? [],
      errored_element_names: cov.errored_element_names ?? [],
      coverage_mermaid: cov.coverage_mermaid ?? "",
    });
  }

  flowSummary(summary: FlowSummaryInput): void {
    this.append("flow_run_logs.log", {
      type: "flow_analysis_summary",
      total_flows_detected: summary.total_flows_detected,
      total_flows_executed: summary.total_flows_executed,
      total_errors: summary.total_errors,
      analysis_timestamp: localTimestamp(),
      time_window_minutes: summary.time_window_minutes ?? 0,
      auto_collected: false,
    });
  }

  // --- Auto-logging APIRequestContext proxy ----------------------------------------------
  // Wraps a Playwright APIRequestContext so every get/post/put/patch/delete/fetch logs a
  // request_data + response_data pair to `fileName` (api_logs.log by default; pass
  // soql_logs.log for Salesforce REST). The real request is delegated untouched.
  wrap<T extends object>(context: T, fileName: "api_logs.log" | "soql_logs.log" = "api_logs.log"): T {
    const verbs = new Set(["get", "post", "put", "patch", "delete", "head", "fetch"]);
    const trace = this;
    return new Proxy(context, {
      get(target, prop, receiver) {
        const orig = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && verbs.has(prop) && typeof orig === "function") {
          return async (...args: unknown[]) => {
            const url = String(args[0] ?? "");
            const options = (args[1] ?? {}) as Record<string, Json>;
            const method = prop === "fetch" ? String(options.method ?? "GET") : prop.toUpperCase();
            const headers = (options.headers as Record<string, string>) ?? {};
            const body = options.data ?? options.form ?? options.multipart ?? options.body ?? null;
            if (fileName === "soql_logs.log") {
              trace.soqlRequest({ method, url, headers, body });
            } else {
              trace.apiRequest(method, url, headers, body);
            }
            const res = (await (orig as (...a: unknown[]) => Promise<ApiResponseLike>).apply(target, args));
            let respBody: Json = null;
            try {
              respBody = await res.text();
            } catch {
              respBody = null;
            }
            const respHeaders = typeof res.headers === "function" ? res.headers() : {};
            if (fileName === "soql_logs.log") {
              trace.soqlResponse(method, url, res.status(), respHeaders, respBody);
            } else {
              trace.apiResponse(res.status(), respHeaders, respBody);
            }
            return res;
          };
        }
        return orig;
      },
    }) as T;
  }
}
