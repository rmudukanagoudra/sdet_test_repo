// TestZeus runtime data contract — TypeScript consumer side (Phase 4).
//
// The Python prep step (testzeus_variable_runtime) writes `runtime-context.json`
// next to the Playwright config and, when the test uses secrets, a LOCAL-ONLY
// `fixtures/.tz-secrets.json` overlay that is gitignored and NEVER uploaded as an
// artifact. This class loads both, overlays the real secret values onto the masked
// context, and exposes `tz.input / tz.testdata / tz.environment / tz.files` plus the
// `setOutput` / `saveFileOutput` write surface. The runner reads back the flushed
// `results/outputs.json`; the Python post step assembles `test_runs.outputs` from it
// (TS does ZERO resolution — Python is the single source of truth on both sides).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { EmailIntegration, EmailRuntimeConfig } from "./tz-email";
import { TzTrace } from "./tz-trace";

export interface RuntimeContext {
  baseURL?: string;
  browser?: string;
  headed?: boolean;
  timeoutMs?: number;
  retries?: number;
  executionMode?: "lenient" | "strict";
  input?: Record<string, unknown>;
  testdata?: Record<string, Record<string, unknown>>;
  environment?: Record<string, Record<string, unknown>>;
  files?: Record<string, string>;
  storageStatePath?: string | null;
  outputsPath?: string;
  outputFilesDir?: string;
  email?: {
    bridgeUrl?: string;
    integrations?: EmailIntegration[];
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Overlay only LEAVES that exist in `overlay` onto `base` (used to merge real secret
// values over masked placeholders). Mutates and returns `base`.
function deepOverlay(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      deepOverlay(base[key] as Record<string, unknown>, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function collectSecretValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.length >= 4) out.push(value);
    return out;
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) {
      collectSecretValues(nested, out);
    }
  }
  return out;
}

export class TzRuntime {
  readonly input: Record<string, unknown>;
  readonly testdata: Record<string, Record<string, unknown>>;
  readonly environment: Record<string, Record<string, unknown>>;
  readonly files: Record<string, string>;

  private readonly ctx: RuntimeContext;
  private readonly rootDir: string;
  private readonly secretValues: string[];
  private readonly secretOverlay: Record<string, unknown>;
  private readonly scalarOutputs: Record<string, unknown> = {};
  private readonly fileOutputs: Record<string, string> = {};
  private _trace?: TzTrace;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    const ctxPath = join(rootDir, "runtime-context.json");
    const ctx: RuntimeContext = existsSync(ctxPath)
      ? (JSON.parse(readFileSync(ctxPath, "utf8")) as RuntimeContext)
      : {};

    const secretsPath =
      process.env.TZ_SECRETS_FILE || join(rootDir, "fixtures", ".tz-secrets.json");
    let secretOverlay: Record<string, unknown> = {};
    if (existsSync(secretsPath)) {
      secretOverlay = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, unknown>;
      deepOverlay(ctx as unknown as Record<string, unknown>, secretOverlay);
    }
    this.secretOverlay = secretOverlay;
    this.secretValues = collectSecretValues(secretOverlay);

    this.ctx = ctx;
    this.input = ctx.input ?? {};
    this.testdata = ctx.testdata ?? {};
    this.environment = ctx.environment ?? {};
    if (!this.environment.current) {
      const buckets = Object.keys(this.environment).filter(key => key !== "current");
      if (buckets.length > 0) {
        const first = this.environment[buckets[0]!];
        if (isPlainObject(first)) {
          this.environment.current = { ...(first as Record<string, unknown>) };
        }
      }
    }
    this.files = {};
    for (const [logicalKey, relPath] of Object.entries(ctx.files ?? {})) {
      this.files[logicalKey] = resolve(rootDir, relPath);
    }
  }

  get baseURL(): string | undefined {
    return this.ctx.baseURL;
  }

  get executionMode(): "lenient" | "strict" {
    return this.ctx.executionMode ?? "lenient";
  }

  get emailConfig(): EmailRuntimeConfig | undefined {
    const email = this.ctx.email;
    if (!email?.bridgeUrl || !email.integrations?.length) return undefined;
    const overlayEmail = isPlainObject(this.secretOverlay.email)
      ? (this.secretOverlay.email as Record<string, unknown>)
      : {};
    return {
      bridgeUrl: email.bridgeUrl,
      integrations: email.integrations,
      pbToken: typeof overlayEmail.pbToken === "string" ? overlayEmail.pbToken : undefined,
      composioApiKey:
        typeof overlayEmail.composioApiKey === "string" ? overlayEmail.composioApiKey : undefined,
    };
  }

  secret(key: string): string {
    const envName = `TZ_SECRET_${key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
    const fromEnv = process.env[envName];
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;

    const inputSecrets = isPlainObject(this.secretOverlay.input)
      ? (this.secretOverlay.input as Record<string, unknown>)
      : {};
    const inputVal = inputSecrets[key];
    if (typeof inputVal === "string") return inputVal;

    const envSecrets = isPlainObject(this.secretOverlay.environment)
      ? (this.secretOverlay.environment as Record<string, Record<string, unknown>>)
      : {};
    for (const bucket of Object.values(envSecrets)) {
      if (isPlainObject(bucket)) {
        const val = bucket[key];
        if (typeof val === "string") return val;
      }
    }

    const tdSecrets = isPlainObject(this.secretOverlay.testdata)
      ? (this.secretOverlay.testdata as Record<string, Record<string, unknown>>)
      : {};
    for (const bucket of Object.values(tdSecrets)) {
      if (isPlainObject(bucket)) {
        const val = bucket[key];
        if (typeof val === "string") return val;
      }
    }

    throw new Error(`tz.secret: no secret value found for key "${key}"`);
  }

  get storageState(): string | undefined {
    const path = this.ctx.storageStatePath;
    return path ? resolve(this.rootDir, path) : undefined;
  }

  // Resolve an injected file by logical key, falling back to basename/stem match so a
  // generated spec stays robust to the prep step's key naming.
  file(key: string): string {
    if (this.files[key]) return this.files[key];
    for (const path of Object.values(this.files)) {
      const name = basename(path);
      if (name === key || name.split(".")[0] === key) return path;
    }
    throw new Error(`tz.file: no injected fixture for key "${key}"`);
  }

  // Resolve a runtime data path: an absolute/real path (e.g. a freshly downloaded file
  // via `await download.path()`) is used as-is; otherwise it is treated as a tz.files key.
  private resolveDataPath(pathOrKey: string): string {
    if (existsSync(pathOrKey)) return pathOrKey;
    return this.file(pathOrKey);
  }

  // --- Runtime data-file helpers (for files PRODUCED during the run, e.g. a CSV/XLSX/PDF
  // the test downloads, or an API response saved to disk). STATIC test_data attachments
  // are already parsed by the Python prep step and exposed at tz.testdata.<bucket>.<stem>
  // — prefer reading those directly; use these only for runtime-produced files. ---

  // Read a UTF-8 text file (raw).
  readText(pathOrKey: string): string {
    return readFileSync(this.resolveDataPath(pathOrKey), "utf8");
  }

  // Parse a JSON file (downloaded report, saved API response, etc.).
  readJson<T = unknown>(pathOrKey: string): T {
    return JSON.parse(readFileSync(this.resolveDataPath(pathOrKey), "utf8")) as T;
  }

  // Parse a CSV/TSV file into an array of row objects (header row -> keys). Uses SheetJS,
  // which auto-detects the delimiter.
  async readCsv<T = Record<string, unknown>>(pathOrKey: string): Promise<T[]> {
    const XLSX = await import("xlsx");
    const buf = readFileSync(this.resolveDataPath(pathOrKey));
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<T>(sheet, { defval: null });
  }

  // Parse an XLSX/XLS/ODS file. Returns the first sheet's rows by default; pass a sheet
  // name to target a specific sheet.
  async readXlsx<T = Record<string, unknown>>(pathOrKey: string, sheetName?: string): Promise<T[]> {
    const XLSX = await import("xlsx");
    const buf = readFileSync(this.resolveDataPath(pathOrKey));
    const wb = XLSX.read(buf, { type: "buffer" });
    const target = sheetName ?? wb.SheetNames[0];
    const sheet = wb.Sheets[target];
    if (!sheet) throw new Error(`tz.readXlsx: sheet "${target}" not found in workbook`);
    return XLSX.utils.sheet_to_json<T>(sheet, { defval: null });
  }

  // Extract all text from a PDF (merged across pages). Uses unpdf's serverless PDF.js build.
  async readPdfText(pathOrKey: string): Promise<string> {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const buf = readFileSync(this.resolveDataPath(pathOrKey));
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  }

  // NDJSON trace logger (api/sql/soql/agent). Writes under results/ so the Python post step
  // uploads the logs under their exact Hercules names and the UIX trace viewers render.
  get trace(): TzTrace {
    if (!this._trace) {
      const outPath = resolve(this.rootDir, this.ctx.outputsPath ?? "results/outputs.json");
      this._trace = new TzTrace(dirname(outPath), this.secretValues);
    }
    return this._trace;
  }

  // Wrap a Playwright APIRequestContext so API calls auto-log to api_logs.log. Pass
  // channel="soql" for Salesforce REST so calls land in soql_logs.log instead.
  api<T extends object>(context: T, channel: "api" | "soql" = "api"): T {
    return this.trace.wrap(context, channel === "soql" ? "soql_logs.log" : "api_logs.log");
  }

  setOutput(key: string, value: unknown): void {
    this.scalarOutputs[key] = value;
  }

  // Stage a produced file so the Python post step uploads it as a pb_attachment ref.
  saveFileOutput(key: string, localPath: string): void {
    const dir = resolve(this.rootDir, this.ctx.outputFilesDir ?? "results/output-files");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, basename(localPath));
    copyFileSync(localPath, dest);
    this.fileOutputs[key] = dest;
  }

  // Persist collected outputs for the Python post step. Called once per test by the
  // fixture teardown.
  flush(): void {
    const outPath = resolve(this.rootDir, this.ctx.outputsPath ?? "results/outputs.json");
    mkdirSync(dirname(outPath), { recursive: true });
    const payload = { scalars: this.scalarOutputs, files: this.fileOutputs };
    writeFileSync(outPath, JSON.stringify(payload, null, 2));
  }
}
