// Composio bridge email helpers — mirrors Hercules email_tools.py (fetch_emails / fetch_email_attachment).

import type { APIRequestContext } from "@playwright/test";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { TzTrace } from "./tz-trace";

export interface EmailIntegration {
  provider: string;
  connectedAccountId?: string;
  authConfigId?: string;
  externalUserId?: string;
}

export interface EmailRuntimeConfig {
  bridgeUrl: string;
  pbToken?: string;
  composioApiKey?: string;
  integrations: EmailIntegration[];
}

export interface FetchedEmailAttachment {
  attachment_id: string;
  file_name: string;
  mime_type: string;
}

export interface FetchedEmail {
  sender: string;
  subject: string;
  body: string;
  timestamp: string;
  message_id: string;
  attachments: FetchedEmailAttachment[];
}

type EmailSuccess<T> = T;
type EmailError = { error: string };

const RETRY_BACKOFF_MS = [1_000, 3_000, 6_000];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeFilename(name: string): string {
  const base = basename(name || "attachment").replace(/[^\w.\-()+ ]+/g, "_");
  return base || "attachment";
}

function endpointForProvider(provider: string, kind: "emails" | "attachments"): string {
  const p = provider.toLowerCase();
  const toolkit = p === "outlook" || p === "microsoft" || p === "office365" ? "outlook" : "gmail";
  return `/composio/integrations/composio/${toolkit}/${kind}:fetch`;
}

function flattenMessages(result: Record<string, unknown>): Record<string, unknown>[] {
  const rawEmails = Array.isArray(result.emails) ? result.emails : [];
  const messages: Record<string, unknown>[] = [];
  for (const item of rawEmails) {
    if (!isPlainObject(item)) continue;
    const nested = item.messages;
    if (Array.isArray(nested) && nested.length > 0) {
      for (const msg of nested) {
        if (isPlainObject(msg)) messages.push(msg);
      }
    } else {
      messages.push(item);
    }
  }
  messages.sort((a, b) => {
    const aTs = String(a.messageTimestamp ?? "");
    const bTs = String(b.messageTimestamp ?? "");
    return bTs.localeCompare(aTs);
  });
  return messages;
}

function extractBodyText(msg: Record<string, unknown>): string {
  const parts: string[] = [];
  const msgText = msg.messageText;
  if (typeof msgText === "string" && msgText) parts.push(msgText);

  const preview = msg.preview;
  if (isPlainObject(preview) && typeof preview.body === "string" && preview.body) {
    parts.push(preview.body);
  }

  const body = msg.body;
  if (isPlainObject(body) && typeof body.content === "string") {
    parts.push(body.content);
  } else if (typeof body === "string" && body) {
    parts.push(body);
  }

  for (const key of ["snippet", "bodyPreview"]) {
    const val = msg[key];
    if (typeof val === "string" && val) parts.push(val);
  }

  return parts
    .join("\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSender(msg: Record<string, unknown>): string {
  const sender = msg.sender ?? msg.from;
  if (isPlainObject(sender)) {
    const ea = sender.emailAddress;
    if (isPlainObject(ea)) {
      return String(ea.address ?? ea.name ?? "");
    }
  }
  return typeof sender === "string" ? sender : "";
}

export class TzEmail {
  private readonly config: EmailRuntimeConfig;

  constructor(
    private readonly request: APIRequestContext,
    config: EmailRuntimeConfig,
    private readonly trace: TzTrace,
    private readonly rootDir: string,
  ) {
    if (!config.bridgeUrl) {
      throw new Error("tz.email: bridgeUrl is not configured for this run");
    }
    if (!config.integrations?.length) {
      throw new Error("tz.email: no email integrations configured for this environment");
    }
    this.config = config;
  }

  private resolveIntegration(provider?: string): EmailIntegration {
    const integrations = this.config.integrations;
    if (provider) {
      const match = integrations.find(
        i => i.provider.toLowerCase() === provider.toLowerCase(),
      );
      if (match) return match;
    }
    return integrations[0]!;
  }

  private buildComposioContext(integration: EmailIntegration): Record<string, string> {
    const ctx: Record<string, string> = {};
    if (this.config.composioApiKey) ctx.apiKey = this.config.composioApiKey;
    if (integration.authConfigId) ctx.authConfigId = integration.authConfigId;
    if (integration.connectedAccountId) ctx.connectedAccountId = integration.connectedAccountId;
    if (integration.externalUserId) ctx.externalUserId = integration.externalUserId;
    return ctx;
  }

  private bridgeHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = this.config.pbToken;
    if (token) {
      headers.Authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    }
    return headers;
  }

  private async callBridge(
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.config.bridgeUrl.replace(/\/$/, "")}${endpoint}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      this.trace.apiRequest("POST", url, this.bridgeHeaders(), payload);
      try {
        const resp = await this.request.post(url, {
          headers: this.bridgeHeaders(),
          data: payload,
          timeout: 30_000,
        });
        const status = resp.status();
        const text = await resp.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          /* keep raw text */
        }
        this.trace.apiResponse(status, resp.headers(), body);

        if (status >= 400 && status < 500) {
          return { error: `Bridge returned ${status}: ${text.slice(0, 500)}` };
        }
        if (status >= 500) {
          throw new Error(`Bridge server error ${status}`);
        }
        return (typeof body === "object" && body !== null ? body : { raw: body }) as Record<
          string,
          unknown
        >;
      } catch (err) {
        lastError = err;
        const wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]!;
        await new Promise(r => setTimeout(r, wait));
      }
    }
    return { error: `Bridge call failed after retries: ${String(lastError)}` };
  }

  async fetchEmails(opts: {
    query?: string;
    provider?: string;
    maxResults?: number;
    labelIds?: string;
    fromEmail?: string;
    subject?: string;
  } = {}): Promise<EmailSuccess<{ emails: FetchedEmail[]; count: number; provider: string }> | EmailError> {
    const integration = this.resolveIntegration(opts.provider);
    const resolvedProvider = opts.provider || integration.provider || "gmail";
    const endpoint = endpointForProvider(resolvedProvider, "emails");
    const payload: Record<string, unknown> = {
      composio: this.buildComposioContext(integration),
    };
    if (integration.connectedAccountId) {
      payload.connectedAccountId = integration.connectedAccountId;
    }

    const isOutlook = ["outlook", "microsoft", "office365"].includes(
      resolvedProvider.toLowerCase(),
    );
    const maxResults = opts.maxResults ?? 10;
    if (opts.query) payload.query = opts.query;
    if (isOutlook) {
      payload.pageSize = Math.min(maxResults, 25);
      if (opts.fromEmail) payload.fromEmail = opts.fromEmail;
      if (opts.subject) payload.subject = opts.subject;
    } else {
      payload.maxResults = maxResults;
      if (opts.labelIds) {
        payload.labelIds = opts.labelIds.split(",").map(s => s.trim()).filter(Boolean);
      }
    }

    const raw = await this.callBridge(endpoint, payload);
    if (typeof raw.error === "string") return { error: raw.error };

    const messages = flattenMessages(raw);
    if (messages.length === 0) {
      return { error: "No emails matched the query. Try broadening the search." };
    }

    if (messages.length === 1 && messages[0]!.message && !messages[0]!.messageId) {
      return { error: String(messages[0]!.message) };
    }

    const structured: FetchedEmail[] = [];
    for (const msg of messages) {
      if (msg.successful === false) continue;
      const attachmentList = Array.isArray(msg.attachmentList) ? msg.attachmentList : [];
      structured.push({
        sender: extractSender(msg),
        subject: String(msg.subject ?? ""),
        body: extractBodyText(msg),
        timestamp: String(msg.messageTimestamp ?? ""),
        message_id: String(msg.messageId ?? msg.id ?? ""),
        attachments: attachmentList
          .filter(isPlainObject)
          .map(att => ({
            attachment_id: String(att.attachmentId ?? ""),
            file_name: String(att.filename ?? att.fileName ?? ""),
            mime_type: String(att.mimeType ?? ""),
          })),
      });
    }

    if (structured.length === 0) {
      return { error: "Bridge returned emails but none contained usable data." };
    }

    return { emails: structured, count: structured.length, provider: resolvedProvider };
  }

  async fetchAttachment(opts: {
    messageId: string;
    attachmentId: string;
    fileName: string;
    provider?: string;
  }): Promise<EmailSuccess<{ filePath: string }> | EmailError> {
    const integration = this.resolveIntegration(opts.provider);
    const resolvedProvider = opts.provider || integration.provider || "gmail";
    const endpoint = endpointForProvider(resolvedProvider, "attachments");
    const payload: Record<string, unknown> = {
      composio: this.buildComposioContext(integration),
      messageId: opts.messageId,
      attachmentId: opts.attachmentId,
      fileName: opts.fileName,
    };
    if (integration.connectedAccountId) {
      payload.connectedAccountId = integration.connectedAccountId;
    }

    const raw = await this.callBridge(endpoint, payload);
    if (typeof raw.error === "string") return { error: raw.error };

    const attachment = isPlainObject(raw.attachment) ? raw.attachment : {};
    if (attachment.successful === false) {
      return { error: `Attachment fetch failed: ${String(attachment.error ?? "unknown error")}` };
    }

    const downloadUrl = String(attachment.downloadUrl ?? "");
    if (!downloadUrl) {
      return { error: "Bridge returned success but no downloadUrl was provided." };
    }

    const dir = join(this.rootDir, "results", "downloads");
    mkdirSync(dir, { recursive: true });
    let dest = join(dir, sanitizeFilename(opts.fileName));
    if (existsSync(dest)) {
      const stem = dest.replace(/\.[^.]+$/, "");
      const ext = dest.includes(".") ? dest.slice(dest.lastIndexOf(".")) : "";
      let counter = 1;
      while (existsSync(dest)) {
        dest = `${stem}_${counter}${ext}`;
        counter += 1;
      }
    }

    this.trace.apiRequest("GET", downloadUrl, {}, null);
    const resp = await this.request.get(downloadUrl, { timeout: 120_000 });
    const status = resp.status();
    const buf = await resp.body();
    this.trace.apiResponse(status, resp.headers(), `[binary ${buf.length} bytes]`);

    if (status < 200 || status >= 300) {
      return { error: `Attachment download failed with status ${status}` };
    }

    await pipeline(Readable.from(buf), createWriteStream(dest));
    return { filePath: dest };
  }
}
