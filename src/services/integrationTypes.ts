import { ChangeRequest } from "../types/change";

export type ChangeAction = "apply" | "batch" | "revert";

export interface IntegrationContext {
  action: ChangeAction;
  timestamp: string;
  dryRun: boolean;
  actor?: { sub?: string; email?: string };
  requestId?: string;
  batch?: { index: number; total: number };
  extra?: Record<string, unknown>;
}

export interface IntegrationInput {
  change: ChangeRequest;
  result: Record<string, unknown>;
  context: IntegrationContext;
}

export interface IntegrationOutcome<T = unknown> {
  enabled: boolean;
  success: boolean;
  skippedReason?: string;
  error?: string;
  details?: T;
}
