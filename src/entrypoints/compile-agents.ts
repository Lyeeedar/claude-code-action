#!/usr/bin/env bun
/**
 * Compile agent task definitions (.github/agents/*.md) into GitHub Actions
 * workflow files (.github/workflows/agent-*.yml) with auto-balanced cron schedules.
 *
 * Run directly:
 *   bun run src/entrypoints/compile-agents.ts
 *
 * Or via the compile-agents GitHub Actions workflow.
 */

import { join } from "path";
import { compileAgentTasks } from "../modes/schedule/compiler";

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

const tasksDir = process.argv[2] ?? join(workspace, ".github/agents");
const workflowsDir = process.argv[3] ?? join(workspace, ".github/workflows");
const actionRef = process.argv[4] ?? undefined;

console.log(`Compiling agent tasks...`);
console.log(`  Tasks dir:     ${tasksDir}`);
console.log(`  Workflows dir: ${workflowsDir}`);

const githubToken = process.env.GITHUB_TOKEN;
const githubRepository = process.env.GITHUB_REPOSITORY; // "owner/repo"
const [owner, repo] = githubRepository?.split("/") ?? [];

const compiled = await compileAgentTasks({
  tasksDir,
  workflowsDir,
  actionRef,
  github:
    githubToken && owner && repo
      ? { token: githubToken, owner, repo }
      : undefined,
});

if (compiled.length === 0) {
  console.log("No tasks found.");
} else {
  console.log(`\nCompiled ${compiled.length} task(s):`);
  for (const t of compiled) {
    console.log(`  • ${t.name} [${t.cronExpression}]`);
  }
}
