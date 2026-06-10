// TestZeus Salesforce helpers — TraceFlag management, Flow auto-collection, and user switching.
//
// Mirrors the Hercules Python implementation (salesforce_trace_manager.py + salesforce_flow_tools.py
// + salesforce_auth_tools.py) so SDET runs produce identical Flow viewer artifacts.
//
// Usage in a generated spec:
//   import { test, expect } from "../../testzeus.fixture";
//   test.beforeAll(async ({ tz }) => { await tz.salesforce.setupTraceFlag(); });
//   test.afterAll(async ({ tz }) => { await tz.salesforce.collectFlows(); });

import type { APIRequestContext, Page, BrowserContext } from "@playwright/test";
import type { TzTrace } from "./tz-trace";

const SF_API_VERSION = "v61.0";
const TRACE_DURATION_HOURS = 1;
const LOG_POLL_INTERVAL_MS = 12_000;
const LOG_POLL_MAX_ATTEMPTS = 6;

interface SalesforceAuth {
  instanceUrl: string;
  accessToken: string;
}

interface TraceFlagState {
  debugLevelId?: string;
  traceFlagId?: string;
  autoProcessTraceFlagId?: string;
  setupTimestamp?: string;
}

interface FlowElementExecution {
  element_name: string;
  element_type: string;
  timestamp: string;
  status: "success" | "error" | "fault";
  details?: string;
  human_label?: string;
}

interface FlowExecution {
  flowName: string;
  flowLabel: string;
  processType: string;
  triggerType: string;
  triggerObject: string;
  interviewId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: "completed" | "error" | "fault";
  elements: FlowElementExecution[];
  errors: string[];
}

interface FlowNode {
  name: string;
  element_type: string;
  label: string;
  connector_target?: string;
  fault_connector_target?: string;
}

// Regex matching Salesforce FLOW_* debug log events (same pattern as Hercules)
const FLOW_EVENT_RE = new RegExp(
  "^([\\d:.]+)\\s+\\(\\d+\\)\\|" +
  "(FLOW_CREATE_INTERVIEW_BEGIN|FLOW_CREATE_INTERVIEW_END" +
  "|FLOW_START_INTERVIEWS_BEGIN|FLOW_START_INTERVIEWS_END" +
  "|FLOW_START_INTERVIEW_BEGIN|FLOW_START_INTERVIEW_END" +
  "|FLOW_START_INTERVIEW_LIMIT_USAGE" +
  "|FLOW_ELEMENT_BEGIN|FLOW_ELEMENT_END" +
  "|FLOW_ELEMENT_DEFERRED" +
  "|FLOW_ELEMENT_ERROR|FLOW_ELEMENT_FAULT" +
  "|FLOW_ASSIGNMENT_DETAIL|FLOW_ACTIONCALL_DETAIL" +
  "|FLOW_SUBFLOW_DETAIL|FLOW_LOOP_DETAIL" +
  "|FLOW_RULE_DETAIL|FLOW_VALUE_ASSIGNMENT" +
  "|FLOW_BULK_ELEMENT_BEGIN|FLOW_BULK_ELEMENT_END" +
  "|FLOW_BULK_ELEMENT_DETAIL|FLOW_BULK_ELEMENT_LIMIT_USAGE" +
  "|FLOW_INTERVIEW_FINISHED_LIMIT_USAGE|FLOW_INTERVIEW_FINISHED)" +
  "\\|?(.*)",
  "gm"
);

function isoNow(): string {
  return new Date().toISOString();
}

function sfExpiration(): string {
  const d = new Date(Date.now() + TRACE_DURATION_HOURS * 3600 * 1000);
  return d.toISOString().replace(/\.\d+Z$/, ".000+0000");
}

function sfNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, ".000+0000");
}

export class TzSalesforce {
  private auth: SalesforceAuth | null = null;
  private state: TraceFlagState = {};
  private request: APIRequestContext;
  private trace: TzTrace;

  constructor(request: APIRequestContext, trace: TzTrace) {
    this.request = request;
    this.trace = trace;
  }

  /**
   * Initialize with Salesforce credentials. Call before setupTraceFlag.
   * instanceUrl: e.g. "https://mydomain.my.salesforce.com"
   * accessToken: OAuth bearer token or session ID
   */
  init(instanceUrl: string, accessToken: string): void {
    this.auth = { instanceUrl: instanceUrl.replace(/\/$/, ""), accessToken };
  }

  private headers(): Record<string, string> {
    if (!this.auth) throw new Error("TzSalesforce not initialized — call tz.salesforce.init() first");
    return {
      Authorization: `Bearer ${this.auth.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  private toolingUrl(path: string): string {
    return `${this.auth!.instanceUrl}/services/data/${SF_API_VERSION}/tooling${path}`;
  }

  private dataUrl(path: string): string {
    return `${this.auth!.instanceUrl}/services/data/${SF_API_VERSION}${path}`;
  }

  // ---------- TraceFlag Management ----------

  async setupTraceFlag(): Promise<boolean> {
    if (!this.auth) {
      console.warn("[tz-sf-trace] setupTraceFlag: no auth");
      return false;
    }
    if (this.state.traceFlagId) return true;

    try {
      const userId = await this.getCurrentUserId();
      if (!userId) {
        console.warn("[tz-sf-trace] setupTraceFlag: getCurrentUserId returned null");
        return false;
      }
      console.log(`[tz-sf-trace] setupTraceFlag: userId=${userId.substring(0, 10)}...`);

      const debugLevelId = await this.createDebugLevel();
      if (!debugLevelId) {
        console.warn("[tz-sf-trace] setupTraceFlag: createDebugLevel failed");
        return false;
      }
      this.state.debugLevelId = debugLevelId;
      console.log(`[tz-sf-trace] setupTraceFlag: debugLevelId=${debugLevelId}`);

      const traceFlagId = await this.createTraceFlag(userId, debugLevelId);
      if (!traceFlagId) {
        console.warn("[tz-sf-trace] setupTraceFlag: createTraceFlag failed");
        await this.deleteResource("DebugLevel", debugLevelId);
        this.state.debugLevelId = undefined;
        return false;
      }
      this.state.traceFlagId = traceFlagId;
      console.log(`[tz-sf-trace] setupTraceFlag: traceFlagId=${traceFlagId}`);

      const autoId = await this.createAutomatedProcessTraceFlag(debugLevelId);
      if (autoId) this.state.autoProcessTraceFlagId = autoId;

      this.state.setupTimestamp = isoNow();
      console.log(`[tz-sf-trace] setupTraceFlag: SUCCESS at ${this.state.setupTimestamp}`);
      return true;
    } catch (e) {
      console.error(`[tz-sf-trace] setupTraceFlag threw: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async cleanupTraceFlag(): Promise<void> {
    if (!this.auth) return;
    try {
      if (this.state.autoProcessTraceFlagId) {
        await this.deleteResource("TraceFlag", this.state.autoProcessTraceFlagId);
      }
      if (this.state.traceFlagId) {
        await this.deleteResource("TraceFlag", this.state.traceFlagId);
      }
      if (this.state.debugLevelId) {
        await this.deleteResource("DebugLevel", this.state.debugLevelId);
      }
    } catch {
      // best-effort cleanup
    } finally {
      this.state = {};
    }
  }

  private async getCurrentUserId(): Promise<string | null> {
    // Try OAuth userinfo first (works with OAuth access tokens)
    try {
      const resp = await this.request.get(
        `${this.auth!.instanceUrl}/services/oauth2/userinfo`,
        { headers: { Authorization: `Bearer ${this.auth!.accessToken}` } }
      );
      if (resp.ok()) {
        const data = await resp.json();
        if (data.user_id) return data.user_id;
      } else {
        console.warn(`[tz-sf-trace] userinfo returned ${resp.status()}`);
      }
    } catch (e) {
      console.warn(`[tz-sf-trace] userinfo threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Fallback: use Chatter API (works with session IDs from sid cookie)
    try {
      const resp = await this.request.get(
        this.dataUrl("/chatter/users/me"),
        { headers: this.headers() }
      );
      if (resp.ok()) {
        const data = await resp.json();
        if (data.id) {
          console.log(`[tz-sf-trace] getUserId via chatter/users/me: ${data.id.substring(0, 10)}...`);
          return data.id;
        }
      } else {
        console.warn(`[tz-sf-trace] chatter/users/me returned ${resp.status()}`);
      }
    } catch (e) {
      console.warn(`[tz-sf-trace] chatter/users/me threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Last resort: SOQL query for the running user
    try {
      const q = encodeURIComponent("SELECT Id FROM User WHERE Id = UserInfo.getUserId()");
      const resp = await this.request.get(
        this.dataUrl(`/query?q=${q}`),
        { headers: this.headers() }
      );
      if (resp.ok()) {
        const data = await resp.json();
        const records = data.records ?? [];
        if (records.length > 0 && records[0].Id) {
          console.log(`[tz-sf-trace] getUserId via SOQL: ${records[0].Id.substring(0, 10)}...`);
          return records[0].Id;
        }
      }
    } catch { /* best-effort */ }

    return null;
  }

  private async createDebugLevel(): Promise<string | null> {
    const devName = `TestZeus_FlowTrace_${Date.now()}`;
    try {
      const resp = await this.request.post(
        this.toolingUrl("/sobjects/DebugLevel"),
        {
          headers: this.headers(),
          data: {
            DeveloperName: devName,
            MasterLabel: "TestZeus Flow Trace",
            Workflow: "FINER",
            ApexCode: "ERROR",
            ApexProfiling: "NONE",
            Callout: "NONE",
            Database: "NONE",
            System: "NONE",
            Validation: "NONE",
            Visualforce: "NONE",
            Wave: "NONE",
            Nba: "NONE",
          },
        }
      );
      if (resp.ok()) {
        const data = await resp.json();
        return data.id ?? null;
      }
    } catch { /* fallback below */ }

    return this.findExistingDebugLevel();
  }

  private async findExistingDebugLevel(): Promise<string | null> {
    try {
      const q = encodeURIComponent(
        "SELECT Id, Workflow FROM DebugLevel " +
        "WHERE DeveloperName LIKE 'TestZeus_FlowTrace_%' ORDER BY CreatedDate DESC LIMIT 1"
      );
      const resp = await this.request.get(
        this.toolingUrl(`/query?q=${q}`),
        { headers: this.headers() }
      );
      if (resp.ok()) {
        const records = (await resp.json()).records ?? [];
        if (records.length > 0) {
          const rec = records[0];
          if (rec.Workflow !== "FINER") {
            await this.request.patch(
              this.toolingUrl(`/sobjects/DebugLevel/${rec.Id}`),
              { headers: this.headers(), data: { Workflow: "FINER" } }
            );
          }
          return rec.Id;
        }
      }
    } catch { /* give up */ }
    return null;
  }

  private async createTraceFlag(tracedEntityId: string, debugLevelId: string): Promise<string | null> {
    try {
      const resp = await this.request.post(
        this.toolingUrl("/sobjects/TraceFlag"),
        {
          headers: this.headers(),
          data: {
            LogType: "USER_DEBUG",
            TracedEntityId: tracedEntityId,
            StartDate: sfNow(),
            ExpirationDate: sfExpiration(),
            DebugLevelId: debugLevelId,
          },
        }
      );
      if (resp.ok()) {
        const data = await resp.json();
        return data.id ?? null;
      }
    } catch { /* fallback below */ }
    return this.findExistingTraceFlag(tracedEntityId, debugLevelId);
  }

  private async findExistingTraceFlag(tracedEntityId: string, debugLevelId: string): Promise<string | null> {
    try {
      const q = encodeURIComponent(
        `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${tracedEntityId}' ` +
        "AND LogType = 'USER_DEBUG' ORDER BY ExpirationDate DESC LIMIT 1"
      );
      const resp = await this.request.get(
        this.toolingUrl(`/query?q=${q}`),
        { headers: this.headers() }
      );
      if (resp.ok()) {
        const records = (await resp.json()).records ?? [];
        if (records.length > 0) {
          const existingId = records[0].Id;
          await this.request.patch(
            this.toolingUrl(`/sobjects/TraceFlag/${existingId}`),
            {
              headers: this.headers(),
              data: { ExpirationDate: sfExpiration(), DebugLevelId: debugLevelId },
            }
          );
          return existingId;
        }
      }
    } catch { /* give up */ }
    return null;
  }

  private async createAutomatedProcessTraceFlag(debugLevelId: string): Promise<string | null> {
    try {
      const q = encodeURIComponent(
        "SELECT Id FROM User WHERE Name = 'Automated Process' AND IsActive = true LIMIT 1"
      );
      const resp = await this.request.get(
        this.dataUrl(`/query?q=${q}`),
        { headers: this.headers() }
      );
      if (resp.ok()) {
        const records = (await resp.json()).records ?? [];
        if (records.length > 0) {
          return this.createTraceFlag(records[0].Id, debugLevelId);
        }
      }
    } catch { /* best-effort */ }
    return null;
  }

  private async deleteResource(sobject: string, recordId: string): Promise<void> {
    try {
      await this.request.delete(
        this.toolingUrl(`/sobjects/${sobject}/${recordId}`),
        { headers: this.headers() }
      );
    } catch { /* best-effort cleanup */ }
  }

  // ---------- Flow Auto-Collection ----------

  /**
   * Collect all Flow executions that occurred since setupTraceFlag was called.
   * Fetches debug logs, parses FLOW_* events, queries static Flow definitions,
   * and emits tz.trace.flow*() calls for the Flow viewer.
   *
   * @param deadlineMs - Absolute monotonic deadline (Date.now() based). If provided,
   *   polling stops early when the deadline approaches, preventing test timeout kills.
   */
  async collectFlows(deadlineMs?: number): Promise<void> {
    if (!this.auth) {
      this.trace.flowMetadata({
        flow_name: "__tz_diagnostic",
        flow_label: "TzSalesforce not initialized — no auth credentials available",
        process_type: "diagnostic",
        trigger_type: "none",
        trigger_object: "none",
      });
      return;
    }
    // If setupTraceFlag wasn't called, use a timestamp from 10 minutes ago as fallback
    if (!this.state.setupTimestamp) {
      this.state.setupTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    }

    this.trace.flowMetadata({
      flow_name: "__tz_diagnostic",
      flow_label: `collectFlows: auth=${!!this.auth} traceFlagId=${this.state.traceFlagId ?? "none"} setupTs=${this.state.setupTimestamp}`,
      process_type: "diagnostic",
      trigger_type: "none",
      trigger_object: "none",
    });

    try {
      const logs = await this.fetchDebugLogs(deadlineMs);

      this.trace.flowMetadata({
        flow_name: "__tz_diagnostic",
        flow_label: `fetchDebugLogs returned ${logs.length} log(s)`,
        process_type: "diagnostic",
        trigger_type: "none",
        trigger_object: "none",
      });

      const executions = this.parseFlowEvents(logs);

      if (executions.length === 0) {
        this.trace.flowMetadata({
          flow_name: "__tz_diagnostic",
          flow_label: `No flow executions parsed from ${logs.length} logs`,
          process_type: "diagnostic",
          trigger_type: "none",
          trigger_object: "none",
        });
        return;
      }

      const uniqueFlows = new Map<string, FlowExecution>();
      for (const exec of executions) {
        if (!uniqueFlows.has(exec.flowName)) uniqueFlows.set(exec.flowName, exec);
      }

      for (const [flowName, sample] of uniqueFlows) {
        this.trace.flowMetadata({
          flow_name: flowName,
          flow_label: sample.flowLabel,
          process_type: sample.processType,
          trigger_type: sample.triggerType,
          trigger_object: sample.triggerObject,
        });

        const definition = await this.fetchFlowDefinition(flowName);
        if (definition) {
          this.trace.flowDefinition({
            flow_name: flowName,
            flow_label: sample.flowLabel,
            process_type: sample.processType,
            trigger_type: sample.triggerType,
            nodes: definition.nodes,
            edges: definition.edges,
          });
        }
      }

      let runIndex = 0;
      const allExecutedElements = new Map<string, Set<string>>();

      for (const exec of executions) {
        this.trace.flowExecution({
          run_index: runIndex++,
          flow_name: exec.flowName,
          flow_label: exec.flowLabel,
          process_type: exec.processType,
          trigger_type: exec.triggerType,
          trigger_object: exec.triggerObject,
          interview_id: exec.interviewId,
          status: exec.status,
          start_time: exec.startTime,
          end_time: exec.endTime,
          duration_ms: exec.durationMs,
          elements: exec.elements,
          errors: exec.errors,
        });

        if (!allExecutedElements.has(exec.flowName)) {
          allExecutedElements.set(exec.flowName, new Set());
        }
        const s = allExecutedElements.get(exec.flowName)!;
        for (const el of exec.elements) s.add(el.element_name);
      }

      // Emit coverage for each unique flow
      for (const [flowName, sample] of uniqueFlows) {
        const executedSet = allExecutedElements.get(flowName) ?? new Set();
        const definition = await this.fetchFlowDefinition(flowName);
        const totalElements = definition?.nodes.length ?? executedSet.size;
        const executedCount = executedSet.size;
        const coveragePct = totalElements > 0 ? Math.round((executedCount / totalElements) * 100) : 0;

        this.trace.flowCoverage({
          flow_name: flowName,
          flow_label: sample.flowLabel,
          total_elements: totalElements,
          executed_elements: executedCount,
          coverage_pct: coveragePct,
          executed_element_names: [...executedSet],
        });
      }

      this.trace.flowSummary({
        total_flows_detected: uniqueFlows.size,
        total_flows_executed: executions.length,
        total_errors: executions.filter(e => e.status !== "completed").length,
      });
    } catch (err) {
      this.trace.flowMetadata({
        flow_name: "__tz_diagnostic_error",
        flow_label: `collectFlows error: ${err instanceof Error ? err.message : String(err)}`,
        process_type: "diagnostic",
        trigger_type: "none",
        trigger_object: "none",
      });
    }
  }

  private pastDeadline(deadlineMs?: number): boolean {
    return deadlineMs != null && Date.now() >= deadlineMs;
  }

  private remainingMs(deadlineMs?: number): number {
    if (deadlineMs == null) return Infinity;
    return Math.max(0, deadlineMs - Date.now());
  }

  private async sleepWithDeadline(ms: number, deadlineMs?: number): Promise<boolean> {
    const actual = Math.min(ms, this.remainingMs(deadlineMs));
    if (actual <= 0) return false;
    await new Promise(r => setTimeout(r, actual));
    return !this.pastDeadline(deadlineMs);
  }

  private async fetchDebugLogs(deadlineMs?: number): Promise<string[]> {
    const since = this.state.setupTimestamp ?? isoNow();
    const logs: string[] = [];

    if (this.pastDeadline(deadlineMs)) return logs;

    // Initial wait: Salesforce needs time to finalize debug logs after the last DML.
    // Adaptive: use full 5s if budget allows, otherwise use whatever remains (min 1s).
    const initialWait = Math.min(5_000, Math.max(1_000, this.remainingMs(deadlineMs) - 5_000));
    await new Promise(r => setTimeout(r, initialWait));

    if (this.pastDeadline(deadlineMs)) return logs;

    for (let attempt = 0; attempt < LOG_POLL_MAX_ATTEMPTS; attempt++) {
      if (this.pastDeadline(deadlineMs)) break;

      try {
        const q = encodeURIComponent(
          `SELECT Id, LogLength FROM ApexLog WHERE StartTime >= ${since} ` +
          "AND LogLength > 0 ORDER BY StartTime DESC LIMIT 50"
        );
        const resp = await this.request.get(
          this.toolingUrl(`/query?q=${q}`),
          { headers: this.headers(), timeout: Math.min(15_000, this.remainingMs(deadlineMs)) }
        );
        if (!resp.ok()) break;

        const records: Array<{ Id: string; LogLength: number }> = (await resp.json()).records ?? [];

        this.trace.flowMetadata({
          flow_name: "__tz_diagnostic",
          flow_label: `fetchDebugLogs attempt ${attempt + 1}/${LOG_POLL_MAX_ATTEMPTS}: ${records.length} ApexLog record(s) (budget=${Math.round(this.remainingMs(deadlineMs) / 1000)}s)`,
          process_type: "diagnostic",
          trigger_type: "none",
          trigger_object: "none",
        });

        if (records.length === 0 && attempt < LOG_POLL_MAX_ATTEMPTS - 1) {
          const canContinue = await this.sleepWithDeadline(LOG_POLL_INTERVAL_MS, deadlineMs);
          if (!canContinue) break;
          continue;
        }

        const MAX_LOG_BYTES = 20_000_000;
        for (const rec of records) {
          if (this.pastDeadline(deadlineMs)) break;
          if (rec.LogLength > MAX_LOG_BYTES) continue;
          try {
            const bodyResp = await this.request.get(
              this.toolingUrl(`/sobjects/ApexLog/${rec.Id}/Body`),
              { headers: { Authorization: `Bearer ${this.auth!.accessToken}` }, timeout: Math.min(30_000, this.remainingMs(deadlineMs)) }
            );
            if (bodyResp.ok()) {
              const text = await bodyResp.text();
              if (text.includes("FLOW_")) {
                logs.push(text);
              }
            }
          } catch { /* skip individual log download failures */ }
        }

        if (logs.length > 0) break;

        if (attempt < LOG_POLL_MAX_ATTEMPTS - 1) {
          const canContinue = await this.sleepWithDeadline(LOG_POLL_INTERVAL_MS, deadlineMs);
          if (!canContinue) break;
        }
      } catch {
        if (attempt < LOG_POLL_MAX_ATTEMPTS - 1) {
          const canContinue = await this.sleepWithDeadline(LOG_POLL_INTERVAL_MS, deadlineMs);
          if (!canContinue) break;
        } else {
          break;
        }
      }
    }

    this.trace.flowMetadata({
      flow_name: "__tz_diagnostic",
      flow_label: `fetchDebugLogs final: ${logs.length} log(s) with FLOW_* events (deadline=${this.pastDeadline(deadlineMs) ? "hit" : "ok"})`,
      process_type: "diagnostic",
      trigger_type: "none",
      trigger_object: "none",
    });

    if (this.pastDeadline(deadlineMs)) return logs;

    // Also try FlowInterview query for paused/active flows
    try {
      const q = encodeURIComponent(
        `SELECT Id, InterviewLabel, CurrentElement, InterviewStatus, CreatedDate ` +
        `FROM FlowInterview WHERE CreatedDate >= ${since} ORDER BY CreatedDate DESC LIMIT 100`
      );
      const resp = await this.request.get(
        this.dataUrl(`/query?q=${q}`),
        { headers: this.headers(), timeout: Math.min(10_000, this.remainingMs(deadlineMs)) }
      );
      if (resp.ok()) {
        const interviews = (await resp.json()).records ?? [];
        for (const interview of interviews) {
          logs.push(
            `00:00:00.0 (0)|FLOW_CREATE_INTERVIEW_BEGIN|${interview.InterviewLabel ?? "Unknown"}|` +
            `${interview.Id}\n` +
            `00:00:00.1 (0)|FLOW_INTERVIEW_FINISHED|${interview.InterviewLabel ?? "Unknown"}`
          );
        }
      }
    } catch { /* best-effort */ }

    return logs;
  }

  private parseFlowEvents(logBodies: string[]): FlowExecution[] {
    const executions: FlowExecution[] = [];

    for (const body of logBodies) {
      let currentFlow: Partial<FlowExecution> | null = null;
      let elements: FlowElementExecution[] = [];

      const lines = body.split("\n");
      for (const line of lines) {
        FLOW_EVENT_RE.lastIndex = 0;
        const match = FLOW_EVENT_RE.exec(line);
        if (!match) continue;

        const [, timestamp, eventType, detail] = match;

        switch (eventType) {
          case "FLOW_CREATE_INTERVIEW_BEGIN": {
            const parts = (detail ?? "").split("|");
            currentFlow = {
              flowName: parts[0] ?? "Unknown",
              flowLabel: parts[0] ?? "Unknown",
              processType: "",
              triggerType: "",
              triggerObject: "",
              interviewId: parts[1] ?? `interview-${Date.now()}`,
              startTime: timestamp ?? isoNow(),
              status: "completed",
              elements: [],
              errors: [],
            };
            elements = [];
            break;
          }
          case "FLOW_ELEMENT_BEGIN": {
            const parts = (detail ?? "").split("|");
            elements.push({
              element_name: parts[0] ?? "unknown",
              element_type: parts[1] ?? "unknown",
              timestamp: timestamp ?? isoNow(),
              status: "success",
            });
            break;
          }
          case "FLOW_ELEMENT_ERROR":
          case "FLOW_ELEMENT_FAULT": {
            if (elements.length > 0) {
              elements[elements.length - 1].status = eventType === "FLOW_ELEMENT_ERROR" ? "error" : "fault";
              elements[elements.length - 1].details = detail ?? "";
            }
            if (currentFlow) {
              currentFlow.errors = [...(currentFlow.errors ?? []), detail ?? ""];
              currentFlow.status = "error";
            }
            break;
          }
          case "FLOW_INTERVIEW_FINISHED":
          case "FLOW_START_INTERVIEW_END": {
            if (currentFlow) {
              currentFlow.endTime = timestamp ?? isoNow();
              currentFlow.elements = elements;
              const start = this.parseTimestamp(currentFlow.startTime ?? "");
              const end = this.parseTimestamp(currentFlow.endTime);
              currentFlow.durationMs = end - start;
              executions.push(currentFlow as FlowExecution);
              currentFlow = null;
              elements = [];
            }
            break;
          }
        }
      }

      // Handle case where interview didn't get a FINISHED event
      if (currentFlow) {
        currentFlow.endTime = isoNow();
        currentFlow.elements = elements;
        currentFlow.durationMs = 0;
        executions.push(currentFlow as FlowExecution);
      }
    }

    return executions;
  }

  private parseTimestamp(ts: string): number {
    if (!ts) return Date.now();
    // Debug log timestamps are HH:MM:SS.mmm format (relative to log start)
    const parts = ts.split(/[:.]/);
    if (parts.length >= 4) {
      return (
        parseInt(parts[0], 10) * 3600000 +
        parseInt(parts[1], 10) * 60000 +
        parseInt(parts[2], 10) * 1000 +
        parseInt(parts[3] ?? "0", 10)
      );
    }
    return 0;
  }

  private async fetchFlowDefinition(flowName: string): Promise<{ nodes: FlowNode[]; edges: Array<{ source: string; target: string; label?: string }> } | null> {
    try {
      const q = encodeURIComponent(
        `SELECT ActiveVersionId, ApiName, Label, ProcessType, TriggerType ` +
        `FROM FlowDefinitionView WHERE ApiName = '${flowName}' LIMIT 1`
      );
      const resp = await this.request.get(
        this.toolingUrl(`/query?q=${q}`),
        { headers: this.headers() }
      );
      if (!resp.ok()) return null;
      const records = (await resp.json()).records ?? [];
      if (records.length === 0) return null;

      const activeVersionId = records[0].ActiveVersionId;
      if (!activeVersionId) return null;

      const metaResp = await this.request.get(
        this.toolingUrl(`/sobjects/Flow/${activeVersionId}`),
        { headers: this.headers() }
      );
      if (!metaResp.ok()) return null;

      const flowMeta = await metaResp.json();
      const metadata = flowMeta.Metadata ?? flowMeta;
      return this.extractFlowGraph(metadata);
    } catch {
      return null;
    }
  }

  private extractFlowGraph(metadata: Record<string, unknown>): { nodes: FlowNode[]; edges: Array<{ source: string; target: string; label?: string }> } {
    const nodes: FlowNode[] = [];
    const edges: Array<{ source: string; target: string; label?: string }> = [];

    const elementTypes = [
      "actionCalls", "assignments", "decisions", "loops", "recordCreates",
      "recordUpdates", "recordDeletes", "recordLookups", "subflows",
      "screens", "waits", "collectionProcessors",
    ];

    for (const elementType of elementTypes) {
      const elements = metadata[elementType];
      if (!Array.isArray(elements)) continue;

      for (const el of elements) {
        const name = el.name ?? el.apiName ?? "";
        const label = el.label ?? name;
        let connectorTarget: string | undefined;

        if (el.connector?.targetReference) {
          connectorTarget = el.connector.targetReference as string;
          edges.push({ source: name, target: connectorTarget });
        }

        let faultTarget: string | undefined;
        if (el.faultConnector?.targetReference) {
          faultTarget = el.faultConnector.targetReference as string;
          edges.push({ source: name, target: faultTarget, label: "fault" });
        }

        nodes.push({
          name,
          element_type: elementType.replace(/s$/, ""),
          label,
          connector_target: connectorTarget,
          fault_connector_target: faultTarget,
        });
      }
    }

    // Start element
    const start = metadata.start as Record<string, unknown> | undefined;
    if (start?.connector) {
      const startTarget = (start.connector as Record<string, string>)?.targetReference;
      if (startTarget) {
        nodes.unshift({ name: "START", element_type: "start", label: "Start" });
        edges.push({ source: "START", target: startTarget });
      }
    }

    return { nodes, edges };
  }

  // ---------- App readiness / navigation ----------

  // Broad app-shell candidate set covering Salesforce surface variants. We never
  // rely on a single class because the shell differs across org types:
  //   - Lightning Experience (Sales/Service Cloud): .oneGlobalNav, .slds-global-header
  //   - Lightning Console: .oneConsoleNav, .navexConsoleTabContainer
  //   - Experience Cloud / Communities: .desktop.container, .forceCommunityGlobalNav
  //   - Web-component nav: one-appnav, one-app-nav-bar
  //   - Generic ARIA banner as a last structural signal: [role="banner"]
  private static readonly APP_SHELL_SELECTORS: readonly string[] = [
    ".oneGlobalNav",
    ".slds-global-header",
    ".desktop.container",
    ".oneConsoleNav",
    ".navexConsoleTabContainer",
    ".forceCommunityGlobalNav",
    "one-appnav",
    "one-app-nav-bar",
    "header.slds-global-header__item",
    '[role="banner"]',
  ];

  // Generic interactive landmarks — present on custom Lightning apps and Experience
  // Cloud pages that may not render any of the standard shell classes above.
  private static readonly LANDMARK_SELECTOR = 'main, [role="main"], [role="navigation"]';

  /**
   * Wait until a Salesforce surface is interactive. Resilient by design:
   * races the app-shell selectors AND generic ARIA landmarks, and falls back to
   * a bounded network-settle if neither structural signal appears. This NEVER
   * hard-fails on a missing shell selector — the next step's own assertion will
   * surface a meaningful error if the page is genuinely broken, instead of an
   * opaque "app shell not visible" timeout.
   *
   * @param page    Playwright Page
   * @param opts.timeout Total readiness budget in ms (default 60s — SF Lightning
   *   cold starts on dev orgs take 40-60s to render the shell visible).
   * @returns true once the readiness sequence has completed (always resolves).
   */
  async waitForAppReady(page: Page, opts: { timeout?: number } = {}): Promise<boolean> {
    const timeout = opts.timeout ?? 60_000;
    const start = Date.now();
    const deadline = start + timeout;
    const remaining = (): number => Math.max(1_000, deadline - Date.now());

    // 1. Ensure the document has at least parsed (cheap; may already be done).
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 30_000) });
    } catch { /* domcontentloaded may have already fired — continue */ }

    // 2. Race structural readiness signals. First to become visible wins.
    const shellSelector = TzSalesforce.APP_SHELL_SELECTORS.join(", ");
    const signals: Promise<string>[] = [
      page.locator(shellSelector).first()
        .waitFor({ state: "visible", timeout: remaining() })
        .then(() => "app-shell"),
      page.locator(TzSalesforce.LANDMARK_SELECTOR).first()
        .waitFor({ state: "visible", timeout: remaining() })
        .then(() => "landmark"),
    ];

    try {
      const winner = await Promise.any(signals);
      console.log(`[tz-sf] waitForAppReady: ready via ${winner} in ${Date.now() - start}ms`);
    } catch {
      // No structural signal fired within budget. Fall back to a bounded network
      // settle so we don't proceed mid-flight, but do NOT throw — let the caller's
      // next assertion produce a meaningful, locator-specific error.
      console.warn(
        `[tz-sf] waitForAppReady: no app-shell/landmark within ${Date.now() - start}ms — falling back to network settle`
      );
      try {
        await page.waitForLoadState("networkidle", { timeout: Math.min(remaining(), 15_000) });
      } catch { /* SF heartbeat traffic can prevent networkidle — ignore */ }
    }

    // 3. Best-effort dismissal of common first-load overlays (welcome modal, cookie
    //    banner, guidance bubble) that would otherwise intercept the next click.
    await this.dismissOverlays(page);
    return true;
  }

  /**
   * Navigate to a Salesforce URL and wait until the app is interactive. Single
   * goto with `domcontentloaded` (NEVER "load" — the Lightning load event can take
   * 60-90s+ and may never fire), a tolerant URL confirmation, then waitForAppReady.
   *
   * Use this as the canonical entry point for SF navigation in generated specs
   * instead of inlining a brittle `page.locator('.oneGlobalNav, ...').waitFor(...)`.
   *
   * @param page Playwright Page
   * @param url  Target URL (frontdoor, instance, Lightning, or Experience Cloud)
   * @param opts.timeout Total budget in ms for goto + readiness (default 60s)
   */
  async gotoApp(page: Page, url: string, opts: { timeout?: number } = {}): Promise<boolean> {
    const timeout = opts.timeout ?? 60_000;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // Tolerant URL confirmation — covers Lightning, Experience Cloud (`/s/`),
    // and *.force.com custom domains. Do not fail here on a non-match; the
    // readiness check below is the real gate.
    try {
      await page.waitForURL(/lightning|\.force\.com|\/s\/|salesforce/i, { timeout: Math.min(timeout, 60_000) });
    } catch {
      console.warn("[tz-sf] gotoApp: URL did not match known SF patterns — continuing to readiness check");
    }

    return this.waitForAppReady(page, { timeout });
  }

  /**
   * Best-effort dismissal of first-load overlays. Safe to call multiple times;
   * never throws.
   */
  async dismissOverlays(page: Page): Promise<void> {
    try {
      const dismiss = page
        .getByRole("button", { name: /close|dismiss|not now|skip|no thanks/i })
        .first();
      if (await dismiss.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await dismiss.click().catch(() => { /* overlay may auto-close */ });
      }
    } catch { /* best-effort — never block the flow on overlay handling */ }
  }

  // ---------- Switch User (Login As) ----------

  /**
   * Switch Salesforce user by navigating to their user detail page and clicking "Login As".
   * After switching, updates the internal auth token from the new browser session cookies.
   *
   * @param page - Playwright Page instance
   * @param userUrl - Full URL to the SF user detail page (e.g. https://org.my.salesforce.com/005XXXXXXXXXXXX)
   * @param timeout - Max wait time in ms for elements to appear (default 30000)
   */
  async switchUser(page: Page, userUrl: string, timeout = 30_000): Promise<boolean> {
    if (!this.auth) return false;

    try {
      await page.goto(userUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout });

      // Click "User Detail" button if present (Classic UI has this)
      const userDetailBtn = page.getByRole("button", { name: /user detail/i });
      if (await userDetailBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await userDetailBtn.click();
        await page.waitForLoadState("networkidle", { timeout: 10_000 });
      }

      // Find and click the "Login" button (Login As)
      // In Classic: input[name="login"] or a link with "Login"
      // In Lightning: button with text "Login"
      const loginBtn = page.locator(
        'input[name="login"], button:has-text("Login"), a:has-text("Login")'
      ).first();

      await loginBtn.waitFor({ state: "visible", timeout });
      await loginBtn.click();

      // Wait for navigation after Login As
      await page.waitForLoadState("domcontentloaded", { timeout });
      await page.waitForTimeout(2000);

      // Extract new SID from cookies
      const context = page.context();
      const cookies = await context.cookies();
      const sidCookie = cookies.find(c => c.name === "sid");
      if (sidCookie) {
        this.auth.accessToken = sidCookie.value;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Logout from current Salesforce session via the UI.
   */
  async logout(page: Page, timeout = 30_000): Promise<boolean> {
    if (!this.auth) return false;

    try {
      // Lightning logout via user menu
      const userIcon = page.locator(".userProfile-button, button[data-aura-class='uiImage']").first();
      if (await userIcon.isVisible({ timeout: 5000 }).catch(() => false)) {
        await userIcon.click();
        const logoutLink = page.getByRole("menuitem", { name: /log out/i });
        await logoutLink.click({ timeout });
      } else {
        // Classic logout URL fallback
        await page.goto(`${this.auth.instanceUrl}/secur/logout.jsp`, { timeout });
      }

      await page.waitForLoadState("domcontentloaded", { timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Perform a SOQL query via the SF REST API and return the records array.
   * Automatically logs via the trace surface for the SOQL viewer.
   */
  async soqlQuery(query: string): Promise<unknown[]> {
    const result = await this.soql(query);
    return result.records;
  }

  /**
   * Perform a SOQL query via the SF REST API and return the full response envelope.
   * Returns { totalSize, done, records } matching the Salesforce REST API shape.
   * Automatically logs via the trace surface for the SOQL viewer.
   */
  async soql(query: string): Promise<{ totalSize: number; done: boolean; records: Record<string, unknown>[] }> {
    const empty = { totalSize: 0, done: true, records: [] };
    if (!this.auth) return empty;

    const url = this.dataUrl(`/query?q=${encodeURIComponent(query)}`);
    this.trace.soqlRequest({ method: "GET", url, query });

    try {
      const resp = await this.request.get(url, { headers: this.headers() });
      const status = resp.status();
      const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
      this.trace.soqlResponse("GET", url, status, {}, body);
      return {
        totalSize: (body.totalSize as number) ?? 0,
        done: (body.done as boolean) ?? true,
        records: (body.records as Record<string, unknown>[]) ?? [],
      };
    } catch (err) {
      this.trace.soqlResponse("GET", url, 500, {}, { error: String(err) });
      return empty;
    }
  }

  /**
   * Perform a Salesforce REST API call (non-SOQL). Logs to soql_logs.log for the SOQL viewer.
   * Use for DML operations, describe calls, or composite requests.
   */
  async rest(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, data?: unknown): Promise<{ status: number; body: unknown }> {
    if (!this.auth) return { status: 0, body: null };

    const url = this.dataUrl(path);
    this.trace.soqlRequest({ method, url });

    try {
      let resp;
      const opts = { headers: this.headers(), data };
      switch (method) {
        case "GET": resp = await this.request.get(url, { headers: this.headers() }); break;
        case "POST": resp = await this.request.post(url, opts); break;
        case "PATCH": resp = await this.request.patch(url, opts); break;
        case "DELETE": resp = await this.request.delete(url, { headers: this.headers() }); break;
      }
      const status = resp.status();
      const body = await resp.json().catch(() => null);
      this.trace.soqlResponse(method, url, status, {}, body);
      return { status, body };
    } catch (err) {
      this.trace.soqlResponse(method, url, 500, {}, { error: String(err) });
      return { status: 500, body: null };
    }
  }
}
