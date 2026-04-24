import { checkHumanActor } from "../../github/validation/actor";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { setupBranch } from "../../github/operations/branch";
import {
  configureGitAuth,
  setupSshSigning,
} from "../../github/operations/git-config";
import { $ } from "bun";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import {
  fetchGitHubData,
  extractTriggerTimestamp,
  extractOriginalTitle,
  extractOriginalBody,
} from "../../github/data/fetcher";
import { createPrompt } from "../../create-prompt";
import { isEntityContext } from "../../github/context";
import type { GitHubContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import { parseAllowedTools } from "../agent/parse-tools";

/**
 * Prepares the tag mode execution context.
 *
 * Tag mode responds to @claude mentions, issue assignments, or labels.
 * Creates tracking comments showing progress and has full implementation capabilities.
 */
export async function prepareTagMode({
  context,
  octokit,
  githubToken,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
}) {
  // Tag mode only handles entity-based events
  if (!isEntityContext(context)) {
    throw new Error("Tag mode requires entity context");
  }

  // Check if actor is human
  await checkHumanActor(octokit.rest, context);

  // Create initial tracking comment
  const commentData = await createInitialComment(octokit.rest, context);
  const commentId = commentData.id;

  const triggerTime = extractTriggerTimestamp(context);
  const originalTitle = extractOriginalTitle(context);
  const originalBody = extractOriginalBody(context);

  const githubData = await fetchGitHubData({
    octokits: octokit,
    repository: `${context.repository.owner}/${context.repository.repo}`,
    prNumber: context.entityNumber.toString(),
    isPR: context.isPR,
    triggerUsername: context.actor,
    triggerTime,
    originalTitle,
    originalBody,
    includeCommentsByActor: context.inputs.includeCommentsByActor,
    excludeCommentsByActor: context.inputs.excludeCommentsByActor,
  });

  // Setup branch
  const branchInfo = await setupBranch(octokit, githubData, context);

  // Configure git authentication
  // SSH signing takes precedence if provided
  const useSshSigning = !!context.inputs.sshSigningKey;
  const useApiCommitSigning = context.inputs.useCommitSigning && !useSshSigning;

  if (useSshSigning) {
    // Setup SSH signing for commits
    await setupSshSigning(context.inputs.sshSigningKey);

    // Still configure git auth for push operations (user/email and remote URL)
    const user = {
      login: context.inputs.botName,
      id: parseInt(context.inputs.botId),
    };
    try {
      await configureGitAuth(githubToken, context, user);
    } catch (error) {
      console.error("Failed to configure git authentication:", error);
      throw error;
    }
  } else if (!useApiCommitSigning) {
    // Use bot_id and bot_name from inputs directly
    const user = {
      login: context.inputs.botName,
      id: parseInt(context.inputs.botId),
    };

    try {
      await configureGitAuth(githubToken, context, user);
    } catch (error) {
      console.error("Failed to configure git authentication:", error);
      throw error;
    }
  }

  // Push branch to remote and create a draft PR immediately — before Claude runs.
  // This ensures work is never lost even if Claude's final push fails.
  let draftPrUrl: string | undefined;
  if (branchInfo.claudeBranch && !context.isPR) {
    const { owner, repo } = context.repository;
    // Push with retry — if this fails we abort immediately rather than
    // burning tokens on work that will be lost when the runner exits.
    let pushed = false;
    let lastPushError: unknown;
    for (let attempt = 1; attempt <= 3 && !pushed; attempt++) {
      try {
        await $`git push -u origin ${branchInfo.claudeBranch}`.quiet();
        pushed = true;
      } catch (err) {
        lastPushError = err;
        if (attempt < 3) {
          console.log(`Push attempt ${attempt} failed, retrying in 3s...`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    if (!pushed) {
      throw new Error(
        `Failed to push branch ${branchInfo.claudeBranch} to remote after 3 attempts — aborting to avoid burning tokens on work that cannot be saved.\n${lastPushError}`,
      );
    }
    console.log(`Pushed branch ${branchInfo.claudeBranch} to remote`);

    // Look for an existing open PR for this branch (e.g. re-trigger on same issue)
    let existingPrUrl: string | undefined;
    try {
      const { data: openPrs } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        head: `${owner}:${branchInfo.claudeBranch}`,
      });
      if (openPrs.length > 0) {
        existingPrUrl = openPrs[0].html_url;
        console.log(`Found existing PR: ${existingPrUrl}`);
      }
    } catch {}

    if (existingPrUrl) {
      draftPrUrl = existingPrUrl;
    } else {
      try {
        const { data: pr } = await octokit.rest.pulls.create({
          owner,
          repo,
          title: `Issue #${context.entityNumber}: Changes from Claude`,
          body: `Addresses issue #${context.entityNumber}\n\nGenerated with [Claude Code](https://claude.ai/code)`,
          head: branchInfo.claudeBranch,
          base: branchInfo.baseBranch || context.repository.default_branch,
          draft: true,
        });
        draftPrUrl = pr.html_url;
        console.log(`✅ Created draft PR #${pr.number}: ${draftPrUrl}`);
      } catch (prError: any) {
        // GitHub rejects PRs with no diff — fine, PR will be created after Claude pushes
        console.log(`Skipping draft PR creation (no diff yet): ${prError.message}`);
      }
    }
  }

  // Create prompt file
  await createPrompt(
    commentId,
    branchInfo.baseBranch,
    branchInfo.claudeBranch,
    githubData,
    context,
    draftPrUrl,
  );

  const userClaudeArgs = process.env.CLAUDE_ARGS || "";
  const userAllowedMCPTools = parseAllowedTools(userClaudeArgs).filter((tool) =>
    tool.startsWith("mcp__github_"),
  );

  const gitPushWrapper = `${process.env.GITHUB_ACTION_PATH}/scripts/git-push.sh`;

  // Build claude_args for tag mode with required tools.
  // Edit/MultiEdit/Write are intentionally omitted: acceptEdits permission mode (set below)
  // auto-allows file edits inside $GITHUB_WORKSPACE and denies writes outside (e.g. ~/.bashrc).
  // Listing them here would grant blanket write access to the whole runner (Asana 1213310082312048).
  const tagModeTools = [
    "Glob",
    "Grep",
    "LS",
    "Read",
    "mcp__github_comment__update_claude_comment",
    "mcp__github_ci__get_ci_status",
    "mcp__github_ci__get_workflow_run_details",
    "mcp__github_ci__download_job_log",
    ...userAllowedMCPTools,
  ];

  // Add git commands when using git CLI (no API commit signing, or SSH signing)
  // SSH signing still uses git CLI, just with signing enabled
  if (!useApiCommitSigning) {
    tagModeTools.push(
      "Bash(git add:*)",
      "Bash(git commit:*)",
      `Bash(${gitPushWrapper}:*)`,
      "Bash(git rm:*)",
    );
  } else {
    // When using API commit signing, use MCP file ops tools
    tagModeTools.push(
      "mcp__github_file_ops__commit_files",
      "mcp__github_file_ops__delete_files",
    );
  }

  // Get our GitHub MCP servers configuration
  const ourMcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: branchInfo.claudeBranch || branchInfo.currentBranch,
    baseBranch: branchInfo.baseBranch,
    claudeCommentId: commentId.toString(),
    allowedTools: Array.from(new Set(tagModeTools)),
    mode: "tag",
    context,
  });

  // Build complete claude_args with multiple --mcp-config flags
  let claudeArgs = "";

  // Add our GitHub servers config
  const escapedOurConfig = ourMcpConfig.replace(/'/g, "'\\''");
  claudeArgs = `--mcp-config '${escapedOurConfig}'`;

  // Add required tools for tag mode.
  // acceptEdits: file edits auto-allowed inside cwd ($GITHUB_WORKSPACE), denied outside.
  // Headless SDK has no prompt handler, so anything that falls through to "ask" is denied.
  claudeArgs += ` --permission-mode acceptEdits --allowedTools "${tagModeTools.join(",")}"`;

  // Append user's claude_args (which may have more --mcp-config flags)
  if (userClaudeArgs) {
    claudeArgs += ` ${userClaudeArgs}`;
  }

  return {
    commentId,
    branchInfo,
    mcpConfig: ourMcpConfig,
    claudeArgs: claudeArgs.trim(),
    draftPrUrl,
  };
}
