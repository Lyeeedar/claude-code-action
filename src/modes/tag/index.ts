import { checkHumanActor } from "../../github/validation/actor";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { setupBranch } from "../../github/operations/branch";
import {
  configureGitAuth,
  replaceCheckoutCredentials,
  setupSshSigning,
} from "../../github/operations/git-config";
import { $ } from "bun";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import {
  fetchGitHubData,
  resolveTriggerTimestamp,
  extractOriginalTitle,
  extractOriginalBody,
} from "../../github/data/fetcher";
import { createPrompt, classifyBugWorkflow } from "../../create-prompt";
import { isEntityContext } from "../../github/context";
import type { GitHubContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import { parseAllowedTools } from "../agent/parse-tools";
import { buildBaseTools } from "../shared-tools";
import { redactGitHubTokens } from "../../github/utils/sanitizer";

/**
 * Renders a Bun shell failure with git's stderr attached.
 *
 * `$`...`.quiet()` captures stderr on the thrown ShellError instead of printing
 * it, and the error's own message is only "Failed with exit code N" — useless on
 * its own for diagnosing a push rejection. git echoes the remote URL on failure,
 * which carries the auth token, so redact before this reaches the log.
 */
function describeShellError(err: unknown): string {
  const stderr = (err as { stderr?: { toString(): string } })?.stderr
    ?.toString()
    .trim();
  const stdout = (err as { stdout?: { toString(): string } })?.stdout
    ?.toString()
    .trim();
  return redactGitHubTokens(
    [String(err), stderr, stdout].filter(Boolean).join("\n"),
  );
}

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

  const triggerTime = await resolveTriggerTimestamp(context, octokit);
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

  // Localisation bug issues must NOT have changes/commits forced on them:
  // making no change (or only a scoped template.json + source change the agent
  // commits itself) is the correct outcome. Signal the base-action Stop hook and
  // the branch-cleanup auto-commit to stand down for this run. Set before
  // setupClaudeCodeSettings() and branch cleanup, which read this env var.
  const bugWorkflow = classifyBugWorkflow({
    isIssuesEvent: context.eventName === "issues",
    title: githubData.contextData?.title ?? "",
    labels: (githubData.contextData?.labels?.nodes ?? []).map(
      (l) => l?.name ?? "",
    ),
  });
  if (bugWorkflow === "localisation") {
    process.env.CLAUDE_SKIP_FORCED_CHANGES = "true";
    console.log(
      "Localisation bug detected — disabling forced-change Stop hook and auto-commit (CLAUDE_SKIP_FORCED_CHANGES=true)",
    );
  }

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
  } else {
    // Commits go through the GitHub API, so no git user setup is needed, but
    // the credential actions/checkout left in git config should still be
    // replaced with the action's own.
    try {
      await replaceCheckoutCredentials(githubToken, context);
    } catch (error) {
      console.error("Failed to configure git credentials:", error);
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
    let lastPushError = "";
    for (let attempt = 1; attempt <= 3 && !pushed; attempt++) {
      try {
        await $`git push -u origin ${branchInfo.claudeBranch}`.quiet();
        pushed = true;
      } catch (err) {
        lastPushError = describeShellError(err);
        if (attempt < 3) {
          // Surface git's stderr — without it "exit code 1" is undiagnosable.
          console.log(`Push attempt ${attempt} failed: ${lastPushError}`);
          console.log("Retrying in 3s...");
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

    const wipTitle = `[WIP] ${originalTitle || `Issue #${context.entityNumber}`}`;
    const prPlaceholderBody =
      `<!-- claude-pr-placeholder -->\n` +
      `_Work in progress — the agent will update this description when done._\n\n` +
      `Addresses issue #${context.entityNumber}\n\n` +
      `Generated with [Claude Code](https://claude.ai/code)`;

    if (existingPrUrl) {
      draftPrUrl = existingPrUrl;
      // Ensure existing PR has [WIP] prefix so it's clear work is ongoing
      try {
        const prNum = parseInt(
          existingPrUrl.match(/\/pull\/(\d+)/)?.[1] ?? "0",
        );
        if (prNum) {
          const { data: existingPr } = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: prNum,
          });
          if (!existingPr.title.startsWith("[WIP]")) {
            await octokit.rest.pulls.update({
              owner,
              repo,
              pull_number: prNum,
              title: `[WIP] ${existingPr.title}`,
            });
          }
        }
      } catch {}
    } else {
      // Make an empty commit so GitHub allows draft PR creation before any real
      // changes exist (GitHub rejects PRs with no commits between base and head).
      try {
        await $`git commit --allow-empty -m "chore: initialize branch for agent"`.quiet();
        await $`git push origin ${branchInfo.claudeBranch}`.quiet();
        console.log(`Created empty commit on ${branchInfo.claudeBranch}`);
      } catch (emptyErr) {
        console.log(`Could not create empty commit: ${emptyErr}`);
      }

      try {
        const { data: pr } = await octokit.rest.pulls.create({
          owner,
          repo,
          title: wipTitle,
          body: prPlaceholderBody,
          head: branchInfo.claudeBranch,
          base: branchInfo.baseBranch || context.repository.default_branch,
          draft: true,
        });
        draftPrUrl = pr.html_url;
        console.log(`✅ Created draft PR #${pr.number}: ${draftPrUrl}`);
      } catch (prError: any) {
        console.log(`Draft PR creation failed: ${prError.message}`);
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

  const tagModeTools = buildBaseTools({
    useApiCommitSigning,
    gitPushWrapper,
    userAllowedMCPTools,
    extraTools: [
      "mcp__github_comment__update_claude_comment",
      "mcp__github_ci__get_ci_status",
      "mcp__github_ci__get_workflow_run_details",
      "mcp__github_ci__download_job_log",
    ],
  });

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

  // Add required tools for tag mode. The permission mode is not set here — run.ts
  // forces `--permission-mode auto` for every mode after user args are appended.
  // Note the headless SDK has no prompt handler, so whatever Auto's safety check
  // routes to "ask" is denied rather than prompted.
  claudeArgs += ` --allowedTools "${tagModeTools.join(",")}"`;

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
