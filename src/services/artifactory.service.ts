import { ChangeRequest, IntegrationMetadata } from "../types/change";
import { httpRequest, toBasicAuth } from "./httpClient";
import { IntegrationContext, IntegrationOutcome } from "./integrationTypes";
import { opsLog } from "../lib/ops-logger";

interface ArtifactoryConfig {
  enabled: boolean;
  baseUrl?: string;
  repository?: string;
  pathTemplate: string;
  username?: string;
  password?: string;
  token?: string;
  timeoutMs: number;
}

export interface ArtifactoryPublishDetails {
  url: string;
  path: string;
  repository: string;
  statusCode: number;
}

function loadConfig(): ArtifactoryConfig {
  const enabled = (process.env.ARTIFACTORY_ENABLED || "false").toLowerCase() === "true";
  const timeoutMs = parseInt(process.env.ARTIFACTORY_TIMEOUT_MS || "15000", 10);
  return {
    enabled,
    baseUrl: process.env.ARTIFACTORY_BASE_URL,
    repository: process.env.ARTIFACTORY_REPOSITORY,
    pathTemplate: process.env.ARTIFACTORY_PATH_TEMPLATE || "changes/{changeId}/{action}-{timestamp}.json",
    username: process.env.ARTIFACTORY_USERNAME,
    password: process.env.ARTIFACTORY_PASSWORD,
    token: process.env.ARTIFACTORY_TOKEN,
    timeoutMs: Number.isNaN(timeoutMs) ? 15000 : timeoutMs,
  };
}

function sanitizeSegment(value: string | undefined, fallback: string): string {
  const source = value && value.trim().length > 0 ? value : fallback;
  return source.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function buildArtifactPath(change: ChangeRequest, context: IntegrationContext, metadata: IntegrationMetadata | undefined, config: ArtifactoryConfig): string {
  const template = metadata?.artifactory?.path || config.pathTemplate;
  const sanitizedTimestamp = context.timestamp.replace(/[:.]/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
  const replacements: Record<string, string> = {
    changeId: sanitizeSegment(change.changeId || "unknown", "change"),
    collection: sanitizeSegment((change.operation as any).collection, "collection"),
    operation: sanitizeSegment(change.operation.type, "operation"),
    action: sanitizeSegment(context.action, "action"),
    timestamp: sanitizedTimestamp.length > 0 ? sanitizedTimestamp : "timestamp",
  };

  let result = template;
  Object.keys(replacements).forEach(key => {
    const token = "{" + key + "}";
    result = result.split(token).join(replacements[key]);
  });

  if (!result || result === template) {
    result = replacements.changeId + "/" + replacements.action + "-" + replacements.timestamp + ".json";
  }

  result = result.replace(/\+/g, "/");
  result = result.replace(/\.{2,}/g, ".");
  result = result.replace(/^\/+/g, "");
  result = result.replace(/\/+/g, "/");
  if (!result.endsWith(".json")) {
    result += ".json";
  }
  return result;
}

function buildPropertiesSuffix(metadata: IntegrationMetadata | undefined): string {
  const props = metadata?.artifactory?.properties;
  if (!props) return "";
  const segments: string[] = [];
  Object.keys(props).forEach(key => {
    const value = props[key];
    if (typeof value === "string" && value.length > 0) {
      segments.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    }
  });
  if (segments.length === 0) return "";
  return ";" + segments.join(";");
}

export async function publishToArtifactory(change: ChangeRequest, result: Record<string, unknown>, context: IntegrationContext): Promise<IntegrationOutcome<ArtifactoryPublishDetails>> {
  const config = loadConfig();
  const metadata = change.metadata as IntegrationMetadata | undefined;

  if (context.dryRun) {
    return { enabled: config.enabled, success: false, skippedReason: "dryRun" };
  }
  if (!config.enabled) {
    return { enabled: false, success: false, skippedReason: "disabled" };
  }
  if (metadata?.artifactory?.skip === true) {
    return { enabled: true, success: false, skippedReason: "metadata.skip" };
  }
  if (!config.baseUrl || config.baseUrl.trim().length === 0) {
    return { enabled: true, success: false, skippedReason: "missing_base_url" };
  }
  const repository = metadata?.artifactory?.repository || config.repository;
  if (!repository) {
    return { enabled: true, success: false, skippedReason: "missing_repository" };
  }
  const path = buildArtifactPath(change, context, metadata, config);
  const propertiesSuffix = buildPropertiesSuffix(metadata);
  const base = config.baseUrl.replace(/\/$/, "");
  const url = base + "/" + repository + "/" + path + propertiesSuffix;
  const payload = JSON.stringify({
    change,
    result,
    context: {
      action: context.action,
      timestamp: context.timestamp,
      actor: context.actor,
      requestId: context.requestId,
      batch: context.batch,
      extra: context.extra,
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
  };

  if (config.token && config.token.trim().length > 0) {
    headers["X-JFrog-Art-Api"] = config.token.trim();
  } else if (config.username && config.password) {
    headers["Authorization"] = "Basic " + toBasicAuth(config.username, config.password);
  } else {
    return { enabled: true, success: false, skippedReason: "missing_credentials" };
  }

  try {
    const response = await httpRequest(url, { method: "PUT", headers, body: payload, timeoutMs: config.timeoutMs });
    const success = response.statusCode >= 200 && response.statusCode < 300;
    if (!success) {
      const errorMessage = "Artifactory responded with status " + response.statusCode;
      opsLog({ kind: "integration.artifactory", status: "error", url, statusCode: response.statusCode, body: response.body.slice(0, 200) });
      return { enabled: true, success: false, error: errorMessage };
    }
    opsLog({ kind: "integration.artifactory", status: "ok", url, statusCode: response.statusCode });
    return {
      enabled: true,
      success: true,
      details: { url, path, repository, statusCode: response.statusCode },
    };
  } catch (err: any) {
    const message = err && err.message ? err.message : String(err);
    opsLog({ kind: "integration.artifactory", status: "exception", message });
    return { enabled: true, success: false, error: message };
  }
}
