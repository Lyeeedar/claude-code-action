export type PostStep = {
  name: string;
  env?: Record<string, string>;
  run: string;
};

export type WorkflowTools = {
  bash?: boolean;
  "web-fetch"?: boolean | Record<string, unknown>;
  github?: {
    toolsets?: string[];
  };
  "repo-memory"?: boolean;
  "cache-memory"?: boolean;
};

export type AgentWorkflow = {
  description?: string;
  schedule?: string;
  timeoutMinutes?: number;
  permissions?: string;
  secrets?: Record<string, string>;
  postSteps: PostStep[];
  tools?: WorkflowTools;
  markdownBody: string;
  steeringIssue?: number;
};
