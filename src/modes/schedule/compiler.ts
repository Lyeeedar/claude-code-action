import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { load as parseYaml } from "js-yaml";
import { parseHumanSchedule, assignCronExpression } from "./balancer";
import type { ScheduleSpec } from "./balancer";

/**
 * Create a steering issue for a task via the GitHub API and return its number.
 * Returns undefined if no token / repo info is available (local runs).
 */
async function createSteeringIssue(
  task: { name: string; description: string; schedule: ScheduleSpec },
  githubToken: string,
  owner: string,
  repo: string,
): Promise<number | undefined> {
  const scheduleLabel =
    task.schedule.kind === "interval"
      ? `every ${task.schedule.hours} hours`
      : task.schedule.kind;

  const body = [
    `## Agent Steering Issue`,
    ``,
    `This issue controls the **${task.name}** scheduled agent.`,
    ``,
    `**How to use:** Post a comment here to redirect, adjust, or pause the agent.`,
    `All comments are injected into the agent's prompt on every run, so directives accumulate — you don't need to repeat previous instructions.`,
    ``,
    `To pause: comment \`PAUSE\` and the agent will stop acting until you comment \`RESUME\`.`,
    ``,
    `**Description:** ${task.description}`,
    `**Schedule:** ${scheduleLabel}`,
    `**Workflow:** \`.github/workflows/agent-${task.name}.yml\``,
  ].join("\n");

  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `[Agent] ${task.description}`,
      body,
      labels: ["agent-steering"],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    // Label may not exist — retry without labels
    if (resp.status === 422 && text.includes("Label does not exist")) {
      const resp2 = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: `[Agent] ${task.description}`, body }),
      });
      if (!resp2.ok) {
        console.warn(`  Could not create steering issue: ${await resp2.text()}`);
        return undefined;
      }
      const data = (await resp2.json()) as { number: number };
      return data.number;
    }
    console.warn(`  Could not create steering issue: ${text}`);
    return undefined;
  }

  const data = (await resp.json()) as { number: number };
  return data.number;
}

/**
 * Patch the task file's frontmatter to add/update `steering-issue: <number>`.
 */
function patchSteeringIssue(filePath: string, issueNumber: number): void {
  const content = readFileSync(filePath, "utf-8");
  // Find the closing --- of the frontmatter
  const secondDash = content.indexOf("\n---", 4);
  if (secondDash === -1) return;
  const patched =
    content.slice(0, secondDash) +
    `\nsteering-issue: ${issueNumber}` +
    content.slice(secondDash);
  writeFileSync(filePath, patched, "utf-8");
}

export type TaskPermissions = {
  contents?: "read" | "write";
  issues?: "read" | "write";
  "pull-requests"?: "read" | "write";
  actions?: "read" | "write";
  [key: string]: string | undefined;
};

export type CompiledTask = {
  name: string; // slug derived from filename
  description: string;
  schedule: ScheduleSpec;
  cronExpression: string;
  timeoutMinutes: number;
  permissions: TaskPermissions;
  extraEnv: Record<string, string>;
  steeringIssue?: number;
  enabled: boolean;
  sourcePath: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function slugify(filename: string): string {
  return basename(filename, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseTaskFile(filePath: string): {
  raw: Record<string, unknown>;
  markdownBody: string;
} {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${filePath}: missing YAML frontmatter (--- ... ---)`);
  }
  const raw = (parseYaml(match[1]) as Record<string, unknown> | null) ?? {};
  const markdownBody = content.slice(match[0].length).trim();
  return { raw, markdownBody };
}

/**
 * Extract cron expressions from all previously generated workflow files.
 * Used to avoid scheduling conflicts when adding new tasks.
 */
function collectExistingCrons(workflowsDir: string, excludeSlug: string): string[] {
  if (!existsSync(workflowsDir)) return [];
  const crons: string[] = [];
  for (const f of readdirSync(workflowsDir)) {
    if (!f.startsWith("agent-") || !f.endsWith(".yml")) continue;
    if (f === `agent-${excludeSlug}.yml`) continue;
    const content = readFileSync(join(workflowsDir, f), "utf-8");
    const m = content.match(/cron:\s*['"]([^'"]+)['"]/g);
    if (m) {
      for (const expr of m) {
        const val = expr.match(/['"]([^'"]+)['"]/)?.[1];
        if (val) crons.push(val);
      }
    }
  }
  return crons;
}

/**
 * Read back the cron expression from an already-generated workflow file.
 * Returns null if the file doesn't exist yet (new task).
 */
function readExistingCron(workflowsDir: string, slug: string): string | null {
  const path = join(workflowsDir, `agent-${slug}.yml`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  const m = content.match(/cron:\s*['"]([^'"]+)['"]/);
  return m?.[1] ?? null;
}

function generateWorkflowYaml(task: CompiledTask, actionRef: string): string {
  const perms = {
    contents: "write", // needed for state branch
    issues: "write", // needed for steering issue
    "pull-requests": "write",
    ...task.permissions,
  };
  const permLines = Object.entries(perms)
    .map(([k, v]) => `      ${k}: ${v}`)
    .join("\n");

  const envLines = Object.entries(task.extraEnv)
    .map(([k, v]) => `          ${k}: ${v}`)
    .join("\n");

  const steeringComment = task.steeringIssue
    ? `\n          # Steering issue: ${task.steeringIssue}`
    : "";

  return `# AUTO-GENERATED — do not edit manually
# Source: .github/agents/${task.name}.md
# To change the schedule or settings, edit the source file and push.
name: "Agent: ${task.description}"

on:
  schedule:
    - cron: '${task.cronExpression}'
  workflow_dispatch:

permissions:
${permLines}

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: ${task.timeoutMinutes}
    if: \${{ vars.AGENTS_ENABLED != 'false' }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run agent task${steeringComment}
        uses: ${actionRef}
        with:
          workflow_file: .github/agents/${task.name}.md
          github_token: \${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
${envLines ? `        env:\n${envLines}` : ""}
`;
}

export type CompileOptions = {
  tasksDir: string; // e.g. ".github/agents"
  workflowsDir: string; // e.g. ".github/workflows"
  actionRef?: string; // e.g. "Lyeeedar/claude-code-action@main"
  /** If provided, creates steering issues for new tasks and patches the source file. */
  github?: { token: string; owner: string; repo: string };
};

export async function compileAgentTasks(opts: CompileOptions): Promise<CompiledTask[]> {
  const { tasksDir, workflowsDir } = opts;
  const actionRef =
    opts.actionRef ??
    (process.env.GITHUB_ACTION_REPOSITORY
      ? `${process.env.GITHUB_ACTION_REPOSITORY}@${process.env.GITHUB_ACTION_REF ?? "main"}`
      : "Lyeeedar/claude-code-action@main");

  if (!existsSync(tasksDir)) {
    console.log(`Tasks directory ${tasksDir} does not exist — nothing to compile`);
    return [];
  }

  mkdirSync(workflowsDir, { recursive: true });

  const taskFiles = readdirSync(tasksDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const compiled: CompiledTask[] = [];

  for (const file of taskFiles) {
    const filePath = join(tasksDir, file);
    const slug = slugify(file);

    let raw: Record<string, unknown>;
    let _body: string;
    try {
      ({ raw, markdownBody: _body } = parseTaskFile(filePath));
    } catch (err) {
      console.error(`Skipping ${file}: ${err}`);
      continue;
    }

    const enabled = raw.enabled !== false;
    if (!enabled) {
      console.log(`Skipping disabled task: ${slug}`);
      // Remove generated file if it exists
      const genPath = join(workflowsDir, `agent-${slug}.yml`);
      if (existsSync(genPath)) {
        console.log(`  Removing ${genPath}`);
        try { require("fs").unlinkSync(genPath); } catch {}
      }
      continue;
    }

    const description =
      typeof raw.description === "string"
        ? raw.description
        : slug.replace(/-/g, " ");

    const scheduleStr =
      typeof raw.schedule === "string" ? raw.schedule : "daily";
    let scheduleSpec: ScheduleSpec;
    try {
      scheduleSpec = parseHumanSchedule(scheduleStr);
    } catch (err) {
      console.error(`Skipping ${file}: ${err}`);
      continue;
    }

    // Preserve existing cron if already compiled — don't rebalance on every push
    const existingCron = readExistingCron(workflowsDir, slug);
    const cronExpression =
      existingCron ??
      assignCronExpression(scheduleSpec, collectExistingCrons(workflowsDir, slug));

    const permissions = (raw.permissions as TaskPermissions | undefined) ?? {};
    const extraEnv = (raw["extra-env"] as Record<string, string> | undefined) ?? {};

    let steeringIssue: number | undefined =
      typeof raw["steering-issue"] === "number" ? raw["steering-issue"] : undefined;

    // Auto-create steering issue if not already set
    if (!steeringIssue && opts.github) {
      const { token, owner, repo } = opts.github;
      const issueNum = await createSteeringIssue(
        { name: slug, description, schedule: scheduleSpec },
        token, owner, repo,
      );
      if (issueNum) {
        steeringIssue = issueNum;
        patchSteeringIssue(filePath, issueNum);
        console.log(`  Created steering issue #${issueNum} for ${slug}`);
      }
    }

    const task: CompiledTask = {
      name: slug,
      description,
      schedule: scheduleSpec,
      cronExpression,
      timeoutMinutes: typeof raw["timeout-minutes"] === "number" ? raw["timeout-minutes"] : 30,
      permissions,
      extraEnv,
      steeringIssue,
      enabled,
      sourcePath: filePath,
    };

    const yaml = generateWorkflowYaml(task, actionRef);
    const outPath = join(workflowsDir, `agent-${slug}.yml`);
    writeFileSync(outPath, yaml, "utf-8");
    console.log(
      `  Compiled ${slug} → agent-${slug}.yml  [cron: ${cronExpression}]${steeringIssue ? `  [steering: #${steeringIssue}]` : ""}`,
    );
    compiled.push(task);
  }

  return compiled;
}
