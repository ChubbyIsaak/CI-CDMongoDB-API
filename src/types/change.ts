import { z } from "zod";
import { ChangeRequestSchema } from "../lib/validator";

export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

export interface ArtifactoryMetadata {
  path?: string;
  repository?: string;
  properties?: Record<string, string>;
  skip?: boolean;
}

export interface JiraMetadata {
  issueKey?: string;
  summary?: string;
  description?: string;
  issueType?: string;
  projectKey?: string;
  labels?: string[];
  components?: string[];
  skip?: boolean;
  linkIssues?: string[];
  assignee?: string;
}

export interface IntegrationMetadata {
  artifactory?: ArtifactoryMetadata;
  jira?: JiraMetadata;
  [key: string]: unknown;
}
