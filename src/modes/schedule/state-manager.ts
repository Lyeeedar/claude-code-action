import { mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { $ } from "bun";

/**
 * Load state from the agent-state/<taskName> branch into RUNNER_TEMP/agent-state/.
 * If the branch doesn't exist yet, returns an empty directory.
 * Sets AGENT_STATE_DIR in process.env so the agent can find it.
 */
export async function loadAgentState(
  taskName: string,
  repoPath: string,
): Promise<string> {
  const stateDir = `${process.env.RUNNER_TEMP || "/tmp"}/agent-state`;
  await mkdir(stateDir, { recursive: true });

  const branchName = `agent-state/${taskName}`;

  // Fetch the state branch (may not exist yet — that's fine)
  const fetchResult = await $`git -C ${repoPath} fetch origin ${branchName}:refs/remotes/origin/${branchName}`
    .quiet()
    .nothrow();

  if (fetchResult.exitCode === 0) {
    // Extract branch contents into stateDir
    await $`git -C ${repoPath} archive "origin/${branchName}" | tar -x -C ${stateDir}`
      .quiet()
      .nothrow();
    console.log(`Loaded agent state from branch ${branchName}`);
  } else {
    console.log(
      `No existing state branch ${branchName} — starting with empty state`,
    );
  }

  process.env.AGENT_STATE_DIR = stateDir;
  return stateDir;
}

/**
 * Commit any changes in AGENT_STATE_DIR back to the agent-state/<taskName> branch.
 * Uses git worktree to avoid touching the main working tree.
 */
export async function saveAgentState(
  taskName: string,
  stateDir: string,
  repoPath: string,
): Promise<void> {
  // Nothing to save if the directory is empty
  if (!existsSync(stateDir)) return;
  const files = await readdir(stateDir).catch(() => [] as string[]);
  if (files.length === 0) {
    console.log("Agent state directory is empty — nothing to save");
    return;
  }

  const branchName = `agent-state/${taskName}`;
  const worktreePath = `${process.env.RUNNER_TEMP || "/tmp"}/state-worktree-${taskName}`;

  // Clean up any stale worktree from a previous run
  await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet().nothrow();
  await $`rm -rf ${worktreePath}`.quiet().nothrow();

  // Check if the state branch already exists remotely
  const hasBranch =
    (
      await $`git -C ${repoPath} rev-parse --verify "refs/remotes/origin/${branchName}"`
        .quiet()
        .nothrow()
    ).exitCode === 0;

  if (hasBranch) {
    await $`git -C ${repoPath} worktree add ${worktreePath} "origin/${branchName}" --no-checkout`.quiet();
    await $`git -C ${worktreePath} checkout`.quiet();
  } else {
    await $`git -C ${repoPath} worktree add --orphan -b ${branchName} ${worktreePath}`.quiet();
  }

  try {
    // Sync state files into the worktree (remove old files not in new state)
    await $`bash -c "cp -r ${stateDir}/. ${worktreePath}/"`.quiet();

    await $`git -C ${worktreePath} add -A`.quiet();

    // Only commit if there are actual changes
    const status = await $`git -C ${worktreePath} status --porcelain`.quiet().nothrow();
    if (!status.stdout.toString().trim()) {
      console.log("Agent state unchanged — nothing to commit");
      return;
    }

    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await $`git -C ${worktreePath} commit -m "state: ${taskName} @ ${timestamp}"`.quiet();
    await $`git -C ${worktreePath} push origin "HEAD:refs/heads/${branchName}"`;
    console.log(`Agent state saved to branch ${branchName}`);
  } finally {
    await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet().nothrow();
  }
}
