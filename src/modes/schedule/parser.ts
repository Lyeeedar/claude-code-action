import { load as parseYaml } from "js-yaml";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AgentWorkflow, PostStep, WorkflowTools } from "./types";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function resolveWorkflowPath(workflowFile: string): string {
  if (!workflowFile.startsWith("/")) {
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    return resolve(workspace, workflowFile);
  }
  return workflowFile;
}

export function parseWorkflowFile(workflowFile: string): AgentWorkflow {
  const filePath = resolveWorkflowPath(workflowFile);
  const content = readFileSync(filePath, "utf-8");

  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { markdownBody: content.trim(), postSteps: [] };
  }

  const [, yamlStr, rawBody] = match;
  const raw = (parseYaml(yamlStr) as Record<string, unknown> | null) ?? {};

  const postSteps: PostStep[] = [];
  const rawSteps = raw["post-steps"];
  if (Array.isArray(rawSteps)) {
    for (const step of rawSteps) {
      if (step && typeof step === "object") {
        const s = step as Record<string, unknown>;
        postSteps.push({
          name: String(s.name ?? "Post-step"),
          env: s.env
            ? resolveExpressionMap(s.env as Record<string, string>)
            : undefined,
          run: String(s.run ?? ""),
        });
      }
    }
  }

  const rawOn = raw["on"] as Record<string, unknown> | undefined;
  const schedule =
    typeof rawOn?.schedule === "string" ? rawOn.schedule : undefined;

  return {
    description:
      typeof raw.description === "string" ? raw.description : undefined,
    schedule,
    timeoutMinutes:
      typeof raw["timeout-minutes"] === "number"
        ? (raw["timeout-minutes"] as number)
        : undefined,
    permissions:
      typeof raw.permissions === "string" ? raw.permissions : undefined,
    secrets: raw.secrets
      ? resolveExpressionMap(raw.secrets as Record<string, string>)
      : undefined,
    postSteps,
    tools: raw.tools as WorkflowTools | undefined,
    markdownBody: rawBody.trim(),
    steeringIssue:
      typeof raw["steering-issue"] === "number"
        ? raw["steering-issue"]
        : undefined,
  };
}

function resolveExpressionMap(
  obj: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] =
      typeof val === "string" ? resolveExpression(val) : String(val);
  }
  return result;
}

// Resolves ${{ secrets.X || secrets.Y || 'literal' }} to actual env var values.
// GitHub Actions resolves these at workflow parse time; in our parser we do it
// at runtime by looking up process.env (secrets are injected as env vars by
// the caller's workflow step env: block).
function resolveExpression(expr: string): string {
  return expr.replace(/\$\{\{\s*([\s\S]+?)\s*\}\}/g, (_, inner: string) => {
    for (const part of inner.split("||")) {
      const trimmed = part.trim();
      const secretsMatch = trimmed.match(/^secrets\.(\w+)$/);
      if (secretsMatch) {
        const val = process.env[secretsMatch[1]];
        if (val) return val;
        continue;
      }
      const literalMatch = trimmed.match(/^['"](.*)['"]$/);
      if (literalMatch) return literalMatch[1];
    }
    return "";
  });
}
