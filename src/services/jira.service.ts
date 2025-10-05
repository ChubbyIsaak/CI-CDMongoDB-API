import { ChangeRequest, IntegrationMetadata, JiraMetadata } from "../types/change";
import { httpRequest, toBasicAuth } from "./httpClient";
import { IntegrationContext, IntegrationOutcome } from "./integrationTypes";
import { opsLog } from "../lib/ops-logger";

interface JiraConfig {
  enabled: boolean;
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  projectKey?: string;
  issueType: string;
  defaultLabels: string[];
  timeoutMs: number;
}

export interface JiraSyncDetails {
  issueKey: string;
  created: boolean;
  commentId?: string;
  url: string;
}

function loadConfig(): JiraConfig {
  const enabled = (process.env.JIRA_ENABLED || "false").toLowerCase() === "true";
  const issueType = process.env.JIRA_ISSUE_TYPE && process.env.JIRA_ISSUE_TYPE.trim().length > 0 ? process.env.JIRA_ISSUE_TYPE.trim() : "Task";
  const defaultLabelsEnv = process.env.JIRA_DEFAULT_LABELS || "";
  const labels = defaultLabelsEnv.split(",").map(part => part.trim()).filter(part => part.length > 0);
  const timeoutMs = parseInt(process.env.JIRA_TIMEOUT_MS || "15000", 10);
  return {
    enabled,
    baseUrl: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    apiToken: process.env.JIRA_API_TOKEN,
    projectKey: process.env.JIRA_PROJECT_KEY,
    issueType,
    defaultLabels: labels,
    timeoutMs: Number.isNaN(timeoutMs) ? 15000 : timeoutMs,
  };
}

function ensureArray(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map(item => String(item)).filter(item => item.length > 0);
  }
  if (typeof input === "string") {
    return input.split(",").map(part => part.trim()).filter(part => part.length > 0);
  }
  return [];
}

function mergeLabels(config: JiraConfig, metadata: JiraMetadata | undefined): string[] {
  const fromMeta = ensureArray(metadata?.labels);
  const merged = [...config.defaultLabels, ...fromMeta];
  const unique: string[] = [];
  merged.forEach(label => {
    if (!unique.includes(label)) unique.push(label);
  });
  return unique;
}

function buildSummary(change: ChangeRequest, metadata: JiraMetadata | undefined): string {
  if (metadata && metadata.summary && metadata.summary.trim().length > 0) {
    return metadata.summary.trim();
  }
  const operation = change.operation.type;
  const collection = (change.operation as any).collection || "n/a";
  const database = change.target.database;
  const changeId = change.changeId || "n/a";
  return "MongoDB change " + changeId + " - " + operation + " on " + database + "." + collection;
}

function safeString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const text = String(value);
  return text.length > 0 ? text : fallback;
}

function buildDescription(change: ChangeRequest, result: Record<string, unknown>, context: IntegrationContext, metadata: JiraMetadata | undefined): string {
  if (metadata && metadata.description && metadata.description.trim().length > 0) {
    return metadata.description.trim();
  }
  const lines: string[] = [];
  lines.push("Change ID: " + safeString(change.changeId, "n/a"));
  lines.push("Action: " + context.action);
  lines.push("Status: " + safeString(result.status, "unknown"));
  if (result.message) {
    lines.push("Message: " + safeString(result.message, ""));
  }
  lines.push("Target URI: " + safeString(change.target.uri, "n/a"));
  lines.push("Database: " + safeString(change.target.database, "n/a"));
  const operation = change.operation as any;
  if (operation.collection) {
    lines.push("Collection: " + safeString(operation.collection, "n/a"));
  }
  lines.push("Operation type: " + change.operation.type);
  if (result.durationMs) {
    lines.push("Duration (ms): " + safeString(result.durationMs, ""));
  }
  if (context.requestId) {
    lines.push("Request ID: " + context.requestId);
  }
  if (context.actor && context.actor.email) {
    lines.push("Actor: " + context.actor.email);
  }
  lines.push("");
  lines.push("Payload:");
  lines.push(JSON.stringify(change, null, 2));
  if (result && Object.keys(result).length > 0) {
    lines.push("");
    lines.push("Result payload:");
    lines.push(JSON.stringify(result, null, 2));
  }
  return lines.join("\n");
}

function buildComponents(metadata: JiraMetadata | undefined): Array<{ name: string }> {
  const components = ensureArray(metadata?.components);
  return components.map(name => ({ name }));
}

function buildIssueUrl(config: JiraConfig, issueKey: string): string {
  if (!config.baseUrl) return issueKey;
  const base = config.baseUrl.replace(/\/$/, "");
  return base + "/browse/" + issueKey;
}

function buildAuthHeader(config: JiraConfig): string | undefined {
  if (!config.email || !config.apiToken) return undefined;
  return "Basic " + toBasicAuth(config.email, config.apiToken);
}

function parseJson(input: string): any {
  try {
    return JSON.parse(input);
  } catch (_err) {
    return undefined;
  }
}

async function createIssue(config: JiraConfig, change: ChangeRequest, result: Record<string, unknown>, context: IntegrationContext, metadata: JiraMetadata | undefined): Promise<{ issueKey: string; created: boolean } | { error: string }> {
  if (!config.projectKey) {
    return { error: "missing_project" };
  }
  const summary = buildSummary(change, metadata);
  const description = buildDescription(change, result, context, metadata);
  const labels = mergeLabels(config, metadata);
  const components = buildComponents(metadata);
  const auth = buildAuthHeader(config);
  if (!config.baseUrl || !auth) {
    return { error: "missing_configuration" };
  }
  const url = config.baseUrl.replace(/\/$/, "") + "/rest/api/2/issue";
  const body: Record<string, unknown> = {
    fields: {
      project: { key: metadata && metadata.projectKey ? metadata.projectKey : config.projectKey },
      summary,
      description,
      issuetype: { name: metadata && metadata.issueType ? metadata.issueType : config.issueType },
    },
  };
  if (labels.length > 0) {
    (body.fields as any).labels = labels;
  }
  if (components.length > 0) {
    (body.fields as any).components = components;
  }
  if (metadata && metadata.assignee) {
    (body.fields as any).assignee = { name: metadata.assignee };
  }

  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
    Authorization: auth,
  };

  const response = await httpRequest(url, { method: "POST", headers, body: payload, timeoutMs: config.timeoutMs });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { error: "jira_create_failed_" + String(response.statusCode) };
  }
  const parsed = parseJson(response.body);
  const issueKey = parsed && parsed.key ? String(parsed.key) : "";
  if (!issueKey) {
    return { error: "jira_create_no_key" };
  }
  return { issueKey, created: true };
}

async function addComment(config: JiraConfig, issueKey: string, comment: string): Promise<{ commentId: string } | { error: string }> {
  const auth = buildAuthHeader(config);
  if (!config.baseUrl || !auth) {
    return { error: "missing_configuration" };
  }
  const url = config.baseUrl.replace(/\/$/, "") + "/rest/api/2/issue/" + encodeURIComponent(issueKey) + "/comment";
  const payload = JSON.stringify({ body: comment });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
    Authorization: auth,
  };
  const response = await httpRequest(url, { method: "POST", headers, body: payload, timeoutMs: config.timeoutMs });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { error: "jira_comment_failed_" + String(response.statusCode) };
  }
  const parsed = parseJson(response.body);
  const commentId = parsed && parsed.id ? String(parsed.id) : "";
  return commentId ? { commentId } : { error: "jira_comment_no_id" };
}

export async function syncWithJira(change: ChangeRequest, result: Record<string, unknown>, context: IntegrationContext): Promise<IntegrationOutcome<JiraSyncDetails>> {
  const config = loadConfig();
  const metadata = change.metadata as IntegrationMetadata | undefined;
  const jiraMeta = metadata?.jira;

  if (context.dryRun) {
    return { enabled: config.enabled, success: false, skippedReason: "dryRun" };
  }
  if (!config.enabled) {
    return { enabled: false, success: false, skippedReason: "disabled" };
  }
  if (jiraMeta && jiraMeta.skip === true) {
    return { enabled: true, success: false, skippedReason: "metadata.skip" };
  }
  if (!config.baseUrl) {
    return { enabled: true, success: false, skippedReason: "missing_base_url" };
  }
  const authHeader = buildAuthHeader(config);
  if (!authHeader) {
    return { enabled: true, success: false, skippedReason: "missing_credentials" };
  }

  let issueKey = jiraMeta && jiraMeta.issueKey ? jiraMeta.issueKey : "";
  let created = false;

  if (!issueKey) {
    const creation = await createIssue(config, change, result, context, jiraMeta);
    if ("error" in creation) {
      opsLog({ kind: "integration.jira", status: "error", message: creation.error, changeId: change.changeId });
      return { enabled: true, success: false, error: creation.error };
    }
    issueKey = creation.issueKey;
    created = creation.created;
    opsLog({ kind: "integration.jira", status: "created", issueKey, changeId: change.changeId });
  }

  const commentText = "Action: " + context.action + "\nStatus: " + safeString(result.status, "unknown") + "\nMessage: " + safeString(result.message, "") + "\nTimestamp: " + context.timestamp;
  const commentResult = await addComment(config, issueKey, commentText);
  if ("error" in commentResult) {
    opsLog({ kind: "integration.jira", status: "comment_error", issueKey, error: commentResult.error });
    return { enabled: true, success: created, error: commentResult.error, details: { issueKey, created, url: buildIssueUrl(config, issueKey) } };
  }
  opsLog({ kind: "integration.jira", status: "comment", issueKey, commentId: commentResult.commentId });
  return {
    enabled: true,
    success: true,
    details: {
      issueKey,
      created,
      commentId: commentResult.commentId,
      url: buildIssueUrl(config, issueKey),
    },
  };
}
