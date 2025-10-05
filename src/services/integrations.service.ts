import { ChangeRequest } from "../types/change";
import { publishToArtifactory, ArtifactoryPublishDetails } from "./artifactory.service";
import { syncWithJira, JiraSyncDetails } from "./jira.service";
import { IntegrationContext, IntegrationOutcome } from "./integrationTypes";

export interface CombinedIntegrationResult {
  artifactory?: IntegrationOutcome<ArtifactoryPublishDetails>;
  jira?: IntegrationOutcome<JiraSyncDetails>;
}

function ensureContext(input: Partial<IntegrationContext>): IntegrationContext {
  return {
    action: input.action || "apply",
    timestamp: input.timestamp || new Date().toISOString(),
    dryRun: input.dryRun ?? false,
    actor: input.actor,
    requestId: input.requestId,
    batch: input.batch,
    extra: input.extra,
  };
}

function convertRejection<T>(reason: unknown): IntegrationOutcome<T> {
  const message = reason && typeof reason === "object" && (reason as any).message ? String((reason as any).message) : String(reason);
  return { enabled: true, success: false, error: message };
}

export async function runIntegrations(change: ChangeRequest, result: Record<string, unknown>, contextInput: Partial<IntegrationContext>): Promise<CombinedIntegrationResult> {
  const context = ensureContext(contextInput);
  const [artifactoryResult, jiraResult] = await Promise.allSettled([
    publishToArtifactory(change, result, context),
    syncWithJira(change, result, context),
  ]) as [
    PromiseSettledResult<IntegrationOutcome<ArtifactoryPublishDetails>>,
    PromiseSettledResult<IntegrationOutcome<JiraSyncDetails>>,
  ];

  return {
    artifactory: artifactoryResult.status === "fulfilled" ? artifactoryResult.value : convertRejection<ArtifactoryPublishDetails>(artifactoryResult.reason),
    jira: jiraResult.status === "fulfilled" ? jiraResult.value : convertRejection<JiraSyncDetails>(jiraResult.reason),
  };
}
