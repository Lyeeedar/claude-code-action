import { mkdir, writeFile } from "fs/promises";
import { basename } from "path";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import { parseAllowedTools } from "../agent/parse-tools";
import type { GitHubContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import { parseWorkflowFile, resolveWorkflowPath } from "./parser";
import { loadAgentState } from "./state-manager";
import type { AgentWorkflow } from "./types";

export { runPostSteps } from "./post-steps";
export { saveAgentState } from "./state-manager";
export type { AgentWorkflow } from "./types";

/**
 * Fetch ALL comments from a GitHub issue (for steering directives).
 * Returns them formatted oldest-first so the agent has full conversation history.
 */
async function fetchSteeringIssueContent(
  octokit: Octokits,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  try {
    // Fetch issue body
    const { data: issue } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    // Fetch all comments
    const comments: { login: string; body: string; created_at: string }[] = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
        page,
      });
      for (const c of data) {
        comments.push({
          login: c.user?.login ?? "unknown",
          body: c.body ?? "",
          created_at: c.created_at,
        });
      }
      if (data.length < 100) break;
      page++;
    }

    const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
    let out = `<steering_directives issue="${issueUrl}">\n`;
    out += `**Issue: ${issue.title}**\n\n`;
    if (issue.body) out += `${issue.body}\n\n`;
    if (comments.length > 0) {
      out += `**Comments (${comments.length}):**\n\n`;
      for (const c of comments) {
        out += `@${c.login} (${c.created_at.slice(0, 10)}): ${c.body}\n\n`;
      }
    }
    out += `</steering_directives>`;
    return out;
  } catch (err) {
    console.warn(`Could not fetch steering issue #${issueNumber}: ${err}`);
    return "";
  }
}

/**
 * Derive a task name (slug) from the workflow file path.
 * e.g. ".github/agents/daily-review.md" → "daily-review"
 */
function taskNameFromPath(workflowFile: string): string {
  return basename(workflowFile, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function prepareScheduleMode({
  context,
  octokit,
  githubToken,
  workflowFile,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  workflowFile: string;
}) {
  const resolvedPath = resolveWorkflowPath(workflowFile);
  console.log(`Loading agent workflow from: ${resolvedPath}`);

  const workflow = parseWorkflowFile(workflowFile);
  console.log(
    `Workflow: ${workflow.description?.split("\n")[0] ?? "(no description)"}`,
  );
  if (workflow.postSteps.length) {
    console.log(
      `Post-steps: ${workflow.postSteps.map((s) => s.name).join(", ")}`,
    );
  }

  const taskName = taskNameFromPath(workflowFile);
  const repoPath = process.env.GITHUB_WORKSPACE || process.cwd();

  // Load agent state from dedicated branch → RUNNER_TEMP/agent-state/
  const stateDir = await loadAgentState(taskName, repoPath);

  // Fetch steering directives (all comments on the steering issue)
  let steeringBlock = "";
  if (workflow.steeringIssue) {
    console.log(`Fetching steering directives from issue #${workflow.steeringIssue}...`);
    steeringBlock = await fetchSteeringIssueContent(
      octokit,
      context.repository.owner,
      context.repository.repo,
      workflow.steeringIssue,
    );
  }

  // Inject the resolved state dir path so the agent knows where to read/write state
  const stateNote = `<agent_context>
task_name: ${taskName}
state_dir: ${stateDir}
Your persistent state is stored in the directory above (backed by branch agent-state/${taskName}).
Read files from it at the start of your run. Write any updates back before finishing.
All files you write there will be committed to the state branch automatically after the run.
</agent_context>`;

  // Build prompt: steering directives (if any) prepended to the task body
  const fullPrompt = [stateNote, steeringBlock, workflow.markdownBody]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const promptDir = `${process.env.RUNNER_TEMP || "/tmp"}/claude-prompts`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(`${promptDir}/claude-prompt.txt`, fullPrompt);

  const defaultBranch = context.repository.default_branch || "main";
  const baseBranch = context.inputs.baseBranch || defaultBranch;
  const currentBranch =
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    defaultBranch;

  const userClaudeArgs = process.env.CLAUDE_ARGS || "";
  const userAllowedTools = parseAllowedTools(userClaudeArgs);

  const scheduleTools = buildToolList(workflow, userAllowedTools);

  const ourMcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: currentBranch,
    baseBranch,
    claudeCommentId: undefined,
    allowedTools: scheduleTools,
    mode: "agent",
    context,
  });

  let claudeArgs = "";
  const ourConfig = JSON.parse(ourMcpConfig) as {
    mcpServers?: Record<string, unknown>;
  };
  if (ourConfig.mcpServers && Object.keys(ourConfig.mcpServers).length > 0) {
    const escaped = ourMcpConfig.replace(/'/g, "'\\''");
    claudeArgs = `--mcp-config '${escaped}'`;
  }

  if (scheduleTools.length > 0) {
    claudeArgs += ` --allowedTools "${scheduleTools.join(",")}"`;
  }

  claudeArgs = `${claudeArgs} ${userClaudeArgs}`.trim();

  return {
    commentId: undefined,
    branchInfo: {
      baseBranch,
      currentBranch,
      claudeBranch: undefined,
    },
    mcpConfig: ourMcpConfig,
    claudeArgs,
    workflow,
    taskName,
    stateDir,
  };
}

function buildToolList(workflow: AgentWorkflow, extraTools: string[]): string[] {
  const tools = new Set<string>(extraTools);

  // Always available
  tools.add("Glob");
  tools.add("Grep");
  tools.add("Read");
  tools.add("LS");
  tools.add("Write");
  tools.add("Edit");
  tools.add("MultiEdit");

  // Git ops for state commits, PRs, etc.
  const gitPushWrapper = `${process.env.GITHUB_ACTION_PATH}/scripts/git-push.sh`;
  tools.add("Bash(git add:*)");
  tools.add("Bash(git commit:*)");
  tools.add("Bash(git fetch:*)");
  tools.add("Bash(git rebase:*)");
  tools.add("Bash(git checkout:*)");
  tools.add("Bash(git status:*)");
  tools.add("Bash(git diff:*)");
  tools.add("Bash(git log:*)");
  tools.add("Bash(git stash:*)");
  tools.add(`Bash(${gitPushWrapper}:*)`);
  tools.add("Bash(gh pr create:*)");
  tools.add("Bash(gh pr edit:*)");
  tools.add("Bash(gh issue create:*)");
  tools.add("Bash(gh issue comment:*)");

  if (workflow.tools?.bash) {
    tools.add("Bash(*)");
  }

  if (workflow.tools?.["web-fetch"]) {
    tools.add("WebFetch(*)");
  }

  if (process.env.MINIMAX_API_KEY) {
    tools.add("mcp__MiniMax__understand_image");
  }

  return Array.from(tools);
}
