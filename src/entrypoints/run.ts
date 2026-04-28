#!/usr/bin/env bun

/**
 * Unified entrypoint for the Claude Code Action.
 * Merges all previously separate action.yml steps (prepare, install, run, cleanup)
 * into a single TypeScript orchestrator.
 */

import * as core from "@actions/core";
import { dirname } from "path";
import { spawn } from "child_process";
import { appendFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { setupGitHubToken, WorkflowValidationSkipError } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import type { Octokits } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../github/context";
import type { GitHubContext } from "../github/context";
import { detectMode } from "../modes/detector";
import { prepareTagMode } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import { prepareScheduleMode, runPostSteps, saveAgentState } from "../modes/schedule";
import { checkContainsTrigger } from "../github/validation/trigger";
import { restoreConfigFromBase } from "../github/operations/restore-config";
import { loadSessionState, saveSessionState } from "../github/operations/session-state";
import { validateBranchName } from "../github/operations/branch";
import { collectActionInputsPresence } from "./collect-inputs";
import { updateCommentLink } from "./update-comment-link";
import { formatTurnsFromData } from "./format-turns";
import type { Turn } from "./format-turns";
// Base-action imports (used directly instead of subprocess)
import { validateEnvironmentVariables } from "../../base-action/src/validate-env";
import { setupClaudeCodeSettings } from "../../base-action/src/setup-claude-code-settings";
import { installPlugins } from "../../base-action/src/install-plugins";
import { preparePrompt } from "../../base-action/src/prepare-prompt";
import { runClaude } from "../../base-action/src/run-claude";
import type { ClaudeRunResult } from "../../base-action/src/run-claude-sdk";
import { setupModelProxy } from "../../base-action/src/setup-model-proxy";

/**
 * Ensure `uv` is installed (needed for `uvx minimax-coding-plan-mcp`).
 * No-ops if uv is already on PATH.
 */
async function ensureUv(): Promise<void> {
  // Check if already available
  const check = spawn("uv", ["--version"], { stdio: "ignore" });
  const already = await new Promise<boolean>((resolve) => {
    check.on("close", (code) => resolve(code === 0));
    check.on("error", () => resolve(false));
  });
  if (already) return;

  console.log("Installing uv...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
      { stdio: "inherit" },
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`uv install failed with exit code ${code}`));
    });
    child.on("error", reject);
  });

  // uv installer places the binary in ~/.local/bin on Linux/macOS
  const localBin = `${process.env.HOME}/.local/bin`;
  const githubPath = process.env.GITHUB_PATH;
  if (githubPath) {
    await appendFile(githubPath, `${localBin}\n`);
  }
  process.env.PATH = `${localBin}:${process.env.PATH}`;
  console.log("uv installed successfully");
}

const WIP_MARKER = "<!-- claude-wip-section -->";

/**
 * Add [WIP] to the PR title and an "In Progress" badge with a job link to the
 * PR body.  Safe to call multiple times — idempotent on both title and body.
 */
async function markPRAsInProgress(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID;
  const jobUrl = runId
    ? `https://github.com/${owner}/${repo}/actions/runs/${runId}`
    : undefined;

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });

  // Prepend [WIP] to the title if not already there
  const newTitle = pr.title.startsWith("[WIP]") ? pr.title : `[WIP] ${pr.title}`;

  // Build the in-progress line
  const wipLine = jobUrl
    ? `${WIP_MARKER}\n\n---\n⚙️ **In Progress** — [View job run](${jobUrl})`
    : `${WIP_MARKER}\n\n---\n⚙️ **In Progress**`;

  // Replace existing WIP section (everything from the marker to the end) or append
  const existingBody = pr.body ?? "";
  const newBody = existingBody.includes(WIP_MARKER)
    ? existingBody.slice(0, existingBody.indexOf(WIP_MARKER)).trimEnd() + "\n\n" + wipLine
    : `${existingBody}\n\n${wipLine}`;

  if (newTitle === pr.title && newBody === existingBody) return; // nothing to do

  await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, title: newTitle, body: newBody });
  console.log(`Marked PR #${prNumber} as in-progress (title: "${newTitle}")`);
}

/**
 * Remove [WIP] from the PR title and strip the in-progress section from the body.
 * Always called when the agent finishes (success or failure).
 */
async function clearPRWIPStatus(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });

  const newTitle = pr.title.startsWith("[WIP] ")
    ? pr.title.slice("[WIP] ".length)
    : pr.title.startsWith("[WIP]")
    ? pr.title.slice("[WIP]".length).trimStart()
    : pr.title;

  const existingBody = pr.body ?? "";
  const newBody = existingBody.includes(WIP_MARKER)
    ? existingBody.slice(0, existingBody.indexOf(WIP_MARKER)).trimEnd()
    : existingBody;

  if (newTitle === pr.title && newBody === existingBody) return;

  await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, title: newTitle, body: newBody });
  console.log(`Cleared WIP status from PR #${prNumber}`);
}

/**
 * After Claude runs, find any PR it created for the given branch and ensure
 * the body contains "Fixes #<issueNumber>" so GitHub auto-closes the issue on merge.
 */
async function patchPRWithIssueLink(
  octokit: Octokits,
  owner: string,
  repo: string,
  branch: string,
  issueNumber: number,
): Promise<void> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
  });
  if (prs.length === 0) return;

  const pr = prs[0];
  const closingRe = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+/i;
  if (pr.body && closingRe.test(pr.body)) return; // already has one

  const newBody = (pr.body ?? "") + `\n\nFixes #${issueNumber}`;
  await octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, body: newBody });
  console.log(`Added "Fixes #${issueNumber}" to PR #${pr.number}`);
}

/**
 * Install Claude Code CLI, handling retry logic and custom executable paths.
 * Returns the absolute path to the claude executable.
 */
async function installClaudeCode(): Promise<string> {
  const customExecutable = process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE;
  if (customExecutable) {
    if (/[\x00-\x1f\x7f]/.test(customExecutable)) {
      throw new Error(
        "PATH_TO_CLAUDE_CODE_EXECUTABLE contains control characters (e.g. newlines), which is not allowed",
      );
    }
    console.log(`Using custom Claude Code executable: ${customExecutable}`);
    const claudeDir = dirname(customExecutable);
    // Add to PATH by appending to GITHUB_PATH
    const githubPath = process.env.GITHUB_PATH;
    if (githubPath) {
      await appendFile(githubPath, `${claudeDir}\n`);
    }
    // Also add to current process PATH
    process.env.PATH = `${claudeDir}:${process.env.PATH}`;
    return customExecutable;
  }

  const claudeCodeVersion = "2.1.119";
  console.log(`Installing Claude Code v${claudeCodeVersion}...`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Installation attempt ${attempt}...`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "bash",
          [
            "-c",
            `curl -fsSL https://claude.ai/install.sh | bash -s -- ${claudeCodeVersion}`,
          ],
          { stdio: "inherit" },
        );
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Install failed with exit code ${code}`));
        });
        child.on("error", reject);
      });
      console.log("Claude Code installed successfully");
      // Add to PATH
      const homeBin = `${process.env.HOME}/.local/bin`;
      const githubPath = process.env.GITHUB_PATH;
      if (githubPath) {
        await appendFile(githubPath, `${homeBin}\n`);
      }
      process.env.PATH = `${homeBin}:${process.env.PATH}`;
      return `${homeBin}/claude`;
    } catch (error) {
      if (attempt === 3) {
        throw new Error(
          `Failed to install Claude Code after 3 attempts: ${error}`,
        );
      }
      console.log("Installation failed, retrying...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error("unreachable");
}

/**
 * Extract the last assistant text response from the execution output file.
 */
function extractLastAssistantText(executionFile: string): string | undefined {
  try {
    const data: Turn[] = JSON.parse(readFileSync(executionFile, "utf-8"));
    for (let i = data.length - 1; i >= 0; i--) {
      const turn = data[i];
      if (turn.type === "assistant" && turn.message?.content) {
        const text = turn.message.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Write the step summary from Claude's execution output file.
 */
async function writeStepSummary(executionFile: string): Promise<void> {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  try {
    const fileContent = readFileSync(executionFile, "utf-8");
    const data: Turn[] = JSON.parse(fileContent);
    const markdown = formatTurnsFromData(data);
    await appendFile(summaryFile, markdown);
    console.log("Successfully formatted Claude Code report");
  } catch (error) {
    console.error(`Failed to format output: ${error}`);
    // Fall back to raw JSON
    try {
      let fallback = "## Claude Code Report (Raw Output)\n\n";
      fallback +=
        "Failed to format output (please report). Here's the raw JSON:\n\n";
      fallback += "```json\n";
      fallback += readFileSync(executionFile, "utf-8");
      fallback += "\n```\n";
      await appendFile(summaryFile, fallback);
    } catch {
      console.error("Failed to write raw output to step summary");
    }
  }
}

async function run() {
  let githubToken: string | undefined;
  let commentId: number | undefined;
  let claudeBranch: string | undefined;
  let baseBranch: string | undefined;
  let draftPrUrl: string | undefined;
  let executionFile: string | undefined;
  let claudeSuccess = false;
  let prepareSuccess = true;
  let prepareError: string | undefined;
  let context: GitHubContext | undefined;
  let octokit: Octokits | undefined;
  // All PR numbers that were marked [WIP] this run — cleared in finally.
  const wipPrNumbers: number[] = [];
  // New PRs created from issues that need "Fixes #N" added after WIP is cleared.
  const pendingIssueLinks: { prNumber: number; issueNumber: number }[] = [];
  // Track whether we've completed prepare phase, so we can attribute errors correctly
  let prepareCompleted = false;
  try {
    // Phase 1: Prepare
    const actionInputsPresent = collectActionInputsPresence();
    context = parseGitHubContext();
    const modeName = detectMode(context);
    console.log(
      `Auto-detected mode: ${modeName} for event: ${context.eventName}`,
    );

    try {
      githubToken = await setupGitHubToken();
    } catch (error) {
      if (error instanceof WorkflowValidationSkipError) {
        core.setOutput("skipped_due_to_workflow_validation_mismatch", "true");
        console.log("Exiting due to workflow validation skip");
        return;
      }
      throw error;
    }

    octokit = createOctokit(githubToken);

    // Set GITHUB_TOKEN and GH_TOKEN in process env for downstream usage
    process.env.GITHUB_TOKEN = githubToken;
    process.env.GH_TOKEN = githubToken;

    // Replace the git extraheader actions/checkout set with our token (which has
    // workflows: write). --replace-all does an atomic in-place swap so there is
    // never more than one Authorization header, avoiding the 400 "Duplicate header"
    // error that happens when a local + global header are both present.
    try {
      const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
      const b64 = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
      execSync(
        `git config --local --replace-all http.https://github.com/.extraheader "AUTHORIZATION: basic ${b64}"`,
        { cwd: workspace, stdio: "ignore" },
      );
    } catch {
      // Non-fatal — git push may still work with the original credential.
    }

    // Check write permissions (only for entity contexts)
    if (isEntityContext(context)) {
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        !!process.env.OVERRIDE_GITHUB_TOKEN,
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    // Check trigger conditions
    const containsTrigger =
      modeName === "schedule"
        ? true // schedule mode always runs when workflow_file is set
        : modeName === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : !!context.inputs?.prompt;
    console.log(`Mode: ${modeName}`);
    console.log(`Context prompt: ${context.inputs?.prompt || "NO PROMPT"}`);
    console.log(`Trigger result: ${containsTrigger}`);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      core.setOutput("github_token", githubToken);
      return;
    }

    // Run prepare
    console.log(
      `Preparing with mode: ${modeName} for event: ${context.eventName}`,
    );
    const prepareResult =
      modeName === "tag"
        ? await prepareTagMode({ context, octokit, githubToken })
        : modeName === "schedule"
        ? await prepareScheduleMode({
            context,
            octokit,
            githubToken,
            workflowFile: process.env.WORKFLOW_FILE!,
          })
        : await prepareAgentMode({ context, octokit, githubToken });

    commentId = prepareResult.commentId;
    claudeBranch = prepareResult.branchInfo.claudeBranch;
    baseBranch = prepareResult.branchInfo.baseBranch;
    draftPrUrl = "draftPrUrl" in prepareResult ? prepareResult.draftPrUrl : undefined;
    prepareCompleted = true;

    // Mark an existing PR as in-progress immediately so the WIP label is
    // visible before Claude starts working (and before any install time).
    if (isEntityContext(context) && context.isPR && octokit) {
      try {
        await markPRAsInProgress(
          octokit,
          context.repository.owner,
          context.repository.repo,
          context.entityNumber,
        );
        wipPrNumbers.push(context.entityNumber);
      } catch (err) {
        console.warn(`Could not mark PR as in-progress: ${err}`);
      }
    }

    // Phase 2: Install toolchain dependencies
    if (process.env.MINIMAX_API_KEY) {
      await ensureUv();
    }

    // Phase 2b: Install Claude Code CLI
    const claudeExecutable = await installClaudeCode();

    // Phase 3: Run Claude (import base-action directly)
    // Set env vars needed by the base-action code
    process.env.INPUT_ACTION_INPUTS_PRESENT = actionInputsPresent;
    process.env.CLAUDE_CODE_ACTION = "1";
    process.env.DETAILED_PERMISSION_MESSAGES = "1";
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    process.env.CLAUDE_MODE = modeName;

    // Signal to setup-claude-code-settings that we're operating on a PR,
    // so it can inject the Stop hook enforcing that edits are made.
    if (isEntityContext(context) && context.isPR) {
      process.env.CLAUDE_AGENT_ON_PR = "true";
    }

    // Expose entity number and branch for Stop hooks.
    if (isEntityContext(context)) {
      process.env.CLAUDE_ENTITY_NUMBER = String(context.entityNumber);
    }
    if (claudeBranch) {
      process.env.CLAUDE_BRANCH = claudeBranch;
    }

    // Expose the tracking comment ID so the Stop hook can check for unchecked items.
    if (commentId) {
      process.env.CLAUDE_TRACKING_COMMENT_ID = String(commentId);
    }

    // Snapshot HEAD before Claude runs so the Stop hook can detect pushed commits.
    try {
      const initialHead = execSync("git rev-parse HEAD", {
        cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
        encoding: "utf-8",
      }).trim();
      process.env.CLAUDE_INITIAL_HEAD = initialHead;
    } catch {
      // Not a git repo or git unavailable — hook will skip the check.
    }

    await setupModelProxy(
      process.env.MODEL_SMALL || process.env.MODEL_MEDIUM || "",
      process.env.MODEL_MEDIUM || "",
      process.env.MODEL_LARGE || process.env.MODEL_MEDIUM || "",
      process.env.XAI_API_KEY || "",
      process.env.OPENAI_API_KEY || "",
      process.env.MINIMAX_API_KEY || "",
      process.env.KIMI_API_KEY || "",
    );

    validateEnvironmentVariables();

    // On PRs, .claude/ and .mcp.json in the checkout are attacker-controlled.
    // Restore them from the base branch before the CLI reads them.
    //
    // We read pull_request.base.ref from the payload directly because agent
    // mode's branchInfo.baseBranch defaults to the repo's default branch rather
    // than the PR's actual target (agent/index.ts). For issue_comment on a PR the payload
    // lacks base.ref, so we fall back to the mode-provided value — tag mode
    // fetches it from GraphQL; agent mode on issue_comment is an edge case
    // that at worst restores from the wrong trusted branch (still secure).
    if (isEntityContext(context) && context.isPR) {
      let restoreBase = baseBranch;
      if (
        isPullRequestEvent(context) ||
        isPullRequestReviewEvent(context) ||
        isPullRequestReviewCommentEvent(context)
      ) {
        restoreBase = context.payload.pull_request.base.ref;
        validateBranchName(restoreBase);
      }
      if (restoreBase) {
        restoreConfigFromBase(restoreBase);
      }
    }

    await setupClaudeCodeSettings(process.env.INPUT_SETTINGS);

    await installPlugins(
      process.env.INPUT_PLUGIN_MARKETPLACES,
      process.env.INPUT_PLUGINS,
      claudeExecutable,
    );

    const promptFile =
      process.env.INPUT_PROMPT_FILE ||
      `${process.env.RUNNER_TEMP}/claude-prompts/claude-prompt.txt`;
    const promptConfig = await preparePrompt({
      prompt: "",
      promptFile,
    });

    // Non-Anthropic models (e.g. MiniMax) may call lowercase tool names like
    // "grep" or "bash" instead of Claude Code's "Grep" / "Bash". Append a
    // brief reminder when a third-party key is in use.
    const toolNamingNote =
      process.env.MINIMAX_API_KEY ||
      process.env.XAI_API_KEY ||
      process.env.OPENAI_API_KEY
        ? "\n\nIMPORTANT — tool names are case-sensitive. Use Grep (not grep), Bash (not bash/shell/grep/find/cat directly), Glob (not glob), Read (not read/cat), Write (not write), Edit (not edit). Always call Bash with a command string rather than calling shell utilities as standalone tool names."
        : "";

    const agentTeamNote = "\n\nCRITICAL INSTRUCTION — MANDATORY FIRST ACTION: Your very first tool call MUST be TeamCreate. Do not read any files, do not analyse anything, do not call any other tool first. Call TeamCreate immediately.\n\nHow to structure the team:\n1. Read the task description only (no file exploration yet)\n2. Call TeamCreate with teammates tailored to the specific aspects of this task:\n   - One teammate per distinct area of the codebase or concern the task touches (e.g. if the task involves UI rendering, game state logic, and save/load — that is three separate teammates, each with a focused brief)\n   - One quality-control teammate: their ONLY job is to scrutinise the work done by other teammates for bugs, edge cases, missed requirements, and integration issues\n   - One reviewer teammate: reads the final diff with fresh eyes, challenges every decision, and must explicitly sign off before the lead finishes\n3. Give each teammate a specific, detailed brief — not generic instructions\n4. Use SendMessage to have teammates share findings with each other and with you\n5. Wait for ALL teammates to report back and for the reviewer to sign off before finishing\n6. To shut down: call requestShutdown on EVERY active member simultaneously (do not wait for their responses), then immediately call TeamDelete. If TeamDelete returns an error about active members, call it once more and then proceed regardless — do NOT wait or retry further.\n\nFailure to call TeamCreate as your first action is a critical error. There are no exceptions.";

    // Restore prior conversation so the agent has full context for follow-up requests.
    // Not used for schedule mode (each run is independent).
    let priorSessionId: string | undefined;
    console.log(`[session] Checking restore: mode=${modeName} isEntityContext=${isEntityContext(context)} isPR=${isEntityContext(context) ? context.isPR : "n/a"} entityNumber=${isEntityContext(context) ? context.entityNumber : "n/a"}`);
    if (modeName !== "schedule" && isEntityContext(context)) {
      const entityType = context.isPR ? "pr" : "issue";
      const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
      try {
        priorSessionId = await loadSessionState(workspace, entityType, context.entityNumber);
      } catch (err) {
        console.warn(`Could not restore session state (starting fresh): ${err}`);
      }
    }

    const claudeArgsWithResume = priorSessionId
      ? `${prepareResult.claudeArgs || ""} --resume ${priorSessionId}`.trim()
      : prepareResult.claudeArgs;

    const claudeResult: ClaudeRunResult = await runClaude(promptConfig.path, {
      claudeArgs: claudeArgsWithResume,
      appendSystemPrompt: (process.env.APPEND_SYSTEM_PROMPT ?? "") + toolNamingNote + agentTeamNote || undefined,
      model: process.env.ANTHROPIC_MODEL,
      pathToClaudeCodeExecutable: claudeExecutable,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    });

    claudeSuccess = claudeResult.conclusion === "success";
    executionFile = claudeResult.executionFile;

    // Persist session so follow-up triggers can resume the same conversation.
    if (modeName !== "schedule" && isEntityContext(context) && claudeResult.sessionId) {
      const entityType = context.isPR ? "pr" : "issue";
      const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
      try {
        await saveSessionState(workspace, entityType, context.entityNumber, claudeResult.sessionId);
      } catch (err) {
        console.warn(`Could not save session state: ${err}`);
      }
    }

    // Run post-steps for schedule mode (always, regardless of Claude's conclusion)
    if (
      modeName === "schedule" &&
      "workflow" in prepareResult &&
      prepareResult.workflow.postSteps.length > 0
    ) {
      console.log(`\nRunning ${prepareResult.workflow.postSteps.length} post-step(s)...`);
      await runPostSteps(prepareResult.workflow.postSteps);
    }

    // Save agent state back to dedicated branch
    if (modeName === "schedule" && "taskName" in prepareResult && "stateDir" in prepareResult) {
      try {
        await saveAgentState(
          prepareResult.taskName,
          prepareResult.stateDir,
          process.env.GITHUB_WORKSPACE || process.cwd(),
        );
      } catch (err) {
        console.error(`Failed to save agent state: ${err}`);
      }
    }

    // After Claude runs, if it created a PR for an issue:
    //   - inject "Fixes #N" (tag mode only) so GitHub auto-closes the issue on merge
    //   - mark the new PR as in-progress
    if (
      claudeBranch &&
      octokit &&
      isEntityContext(context) &&
      !context.isPR &&
      context.entityNumber
    ) {
      try {
        const { data: newPrs } = await octokit.rest.pulls.list({
          owner: context.repository.owner,
          repo: context.repository.repo,
          head: `${context.repository.owner}:${claudeBranch}`,
          state: "open",
        });

        if (newPrs.length > 0) {
          const newPr = newPrs[0];

          // Defer "Fixes #N" injection to the finally block (after WIP is cleared)
          // to avoid the issue link being overwritten by markPRAsInProgress.
          if (modeName === "tag") {
            pendingIssueLinks.push({ prNumber: newPr.number, issueNumber: context.entityNumber });
          }

          try {
            await markPRAsInProgress(
              octokit,
              context.repository.owner,
              context.repository.repo,
              newPr.number,
            );
            wipPrNumbers.push(newPr.number);
          } catch (err) {
            console.warn(`Could not mark new PR as in-progress: ${err}`);
          }
        }
      } catch (err) {
        console.warn(`Could not check for new PRs: ${err}`);
      }
    }

    // Set action-level outputs
    if (claudeResult.executionFile) {
      core.setOutput("execution_file", claudeResult.executionFile);
    }
    if (claudeResult.sessionId) {
      core.setOutput("session_id", claudeResult.sessionId);
    }
    if (claudeResult.structuredOutput) {
      core.setOutput("structured_output", claudeResult.structuredOutput);
    }
    core.setOutput("conclusion", claudeResult.conclusion);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Only mark as prepare failure if we haven't completed the prepare phase
    if (!prepareCompleted) {
      prepareSuccess = false;
      prepareError = errorMessage;
    }
    core.setFailed(`Action failed with error: ${errorMessage}`);
  } finally {
    // Phase 4: Cleanup (always runs)

    // Stage, commit, and push any work Claude left behind.
    // Must be in finally so it runs even if runClaude threw an exception.
    if (claudeBranch) {
      try {
        const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
        const status = execSync("git status --porcelain", { cwd: workspace, encoding: "utf-8" }).trim();
        if (status) {
          console.log("Staging and committing uncommitted changes left by Claude...");
          execSync("git add -A", { cwd: workspace, stdio: "inherit" });
          execSync(`git commit -m "chore: apply remaining changes from Claude session"`, { cwd: workspace, stdio: "inherit" });
        }
        const unpushed = execSync("git log @{u}..HEAD --oneline 2>/dev/null || true", { cwd: workspace, encoding: "utf-8" }).trim();
        if (unpushed) {
          console.log(`Pushing ${unpushed.split("\n").length} unpushed commit(s) on ${claudeBranch}...`);
          execSync(`git push origin ${claudeBranch}`, { cwd: workspace, stdio: "inherit" });
          console.log("Push successful");
        }
      } catch (err) {
        console.warn(`Post-run commit/push failed (non-fatal): ${err}`);
      }
    }

    // Remove [WIP] from every PR we marked in-progress this run.
    if (octokit && context && isEntityContext(context) && wipPrNumbers.length > 0) {
      for (const prNum of wipPrNumbers) {
        try {
          await clearPRWIPStatus(
            octokit,
            context.repository.owner,
            context.repository.repo,
            prNum,
          );
        } catch (err) {
          console.warn(`Could not clear WIP status from PR #${prNum}: ${err}`);
        }
      }
    }

    // Inject "Fixes #N" after WIP is cleared so it isn't overwritten.
    if (octokit && context && isEntityContext(context) && pendingIssueLinks.length > 0) {
      for (const { prNumber, issueNumber } of pendingIssueLinks) {
        try {
          await patchPRWithIssueLink(
            octokit,
            context.repository.owner,
            context.repository.repo,
            claudeBranch!,
            issueNumber,
          );
        } catch (err) {
          console.warn(`Could not patch PR #${prNumber} with issue link: ${err}`);
        }
      }
    }

    // Update tracking comment
    if (
      commentId &&
      context &&
      isEntityContext(context) &&
      githubToken &&
      octokit
    ) {
      try {
        await updateCommentLink({
          commentId,
          githubToken,
          claudeBranch,
          baseBranch: baseBranch || context.repository.default_branch || "main",
          triggerUsername: context.actor,
          context,
          octokit,
          claudeSuccess,
          outputFile: executionFile,
          prepareSuccess,
          prepareError,
          useCommitSigning: context.inputs.useCommitSigning,
          existingPrUrl: draftPrUrl,
        });
      } catch (error) {
        console.error("Error updating comment with job link:", error);
        // Fallback: post the last assistant response directly into the comment
        if (executionFile && existsSync(executionFile)) {
          const lastResponse = extractLastAssistantText(executionFile);
          if (lastResponse) {
            try {
              await octokit.rest.issues.updateComment({
                owner: context.repository.owner,
                repo: context.repository.repo,
                comment_id: commentId,
                body: lastResponse,
              });
              console.log("Posted last assistant response as comment fallback");
            } catch (fallbackError) {
              console.error("Fallback comment update also failed:", fallbackError);
            }
          }
        }
      }
    }

    // Write step summary (unless display_report is set to false)
    if (
      executionFile &&
      existsSync(executionFile) &&
      process.env.DISPLAY_REPORT !== "false"
    ) {
      await writeStepSummary(executionFile);
    }

    // Set remaining action-level outputs
    core.setOutput("branch_name", claudeBranch);
    core.setOutput("github_token", githubToken);
  }
}

if (import.meta.main) {
  run();
}
