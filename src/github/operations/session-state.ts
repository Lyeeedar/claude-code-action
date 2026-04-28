import { mkdir, readdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { $ } from "bun";

const SESSION_BRANCH_PREFIX = "claude-sessions";
const PART_PREFIX = "claude-projects.tar.gz.part.";

function branchName(entityType: string, entityNumber: number): string {
  return `${SESSION_BRANCH_PREFIX}/${entityType}-${entityNumber}`;
}

/**
 * Restore Claude Code's project session files from the sessions branch and
 * return the last session ID to pass to --resume.
 * Returns undefined if no saved session exists.
 */
export async function loadSessionState(
  repoPath: string,
  entityType: string,
  entityNumber: number,
): Promise<string | undefined> {
  const branch = branchName(entityType, entityNumber);
  console.log(`[session] Loading session state from branch ${branch}...`);

  const fetch = await $`git -C ${repoPath} fetch origin refs/heads/${branch}`.nothrow();
  if (fetch.exitCode !== 0) {
    const stderr = fetch.stderr.toString().trim();
    console.log(`[session] No session branch found (${branch}) — ${stderr || "fetch failed"}`);
    return undefined;
  }

  const tmpDir = `${process.env.RUNNER_TEMP || "/tmp"}/claude-session-restore-${entityNumber}`;
  await mkdir(tmpDir, { recursive: true });

  const extract =
    await $`git -C ${repoPath} archive FETCH_HEAD | tar -x -C ${tmpDir}`
      .quiet()
      .nothrow();
  if (extract.exitCode !== 0) {
    console.log(`[session] Failed to extract session branch`);
    return undefined;
  }

  const sessionIdPath = join(tmpDir, "session-id.txt");
  if (!existsSync(sessionIdPath)) {
    console.log(`[session] No session-id.txt in branch`);
    return undefined;
  }

  const allFiles = await readdir(tmpDir).catch(() => [] as string[]);
  const parts = allFiles.filter((f) => f.startsWith(PART_PREFIX)).sort();
  if (parts.length === 0) {
    console.log(`[session] No archive parts found in branch`);
    return undefined;
  }
  console.log(`[session] Found ${parts.length} part(s), reassembling...`);

  const archivePath = join(tmpDir, "claude-projects.tar.gz");
  const partPaths = parts.map((p) => join(tmpDir, p)).join(" ");
  const reassemble = await $`bash -c ${`cat ${partPaths} > ${archivePath}`}`.quiet().nothrow();
  if (reassemble.exitCode !== 0) {
    console.log(`[session] Failed to reassemble archive parts`);
    return undefined;
  }

  const claudeDir = homedir() + "/.claude";
  await mkdir(claudeDir, { recursive: true });
  const restore = await $`tar -xzf ${archivePath} -C ${claudeDir}`.quiet().nothrow();
  if (restore.exitCode !== 0) {
    console.log(`[session] Failed to extract archive into ~/.claude`);
    return undefined;
  }

  const sessionId = (await readFile(sessionIdPath, "utf-8")).trim();
  console.log(`[session] Restored session ${sessionId} for ${entityType}-${entityNumber} (${parts.length} part(s))`);
  return sessionId;
}

/**
 * Archive Claude Code's project session files to a dedicated git branch so
 * the next run can restore them and resume with --resume <sessionId>.
 * The archive is split into <=10 MB chunks so no individual git blob is too large.
 */
export async function saveSessionState(
  repoPath: string,
  entityType: string,
  entityNumber: number,
  sessionId: string,
): Promise<void> {
  const claudeProjectsDir = homedir() + "/.claude/projects";
  if (!existsSync(claudeProjectsDir)) return;

  const files = await readdir(claudeProjectsDir).catch(() => [] as string[]);
  if (files.length === 0) return;

  const tmpDir = `${process.env.RUNNER_TEMP || "/tmp"}/claude-session-save-${entityNumber}`;
  await mkdir(tmpDir, { recursive: true });

  // Create archive then split into 10 MB chunks
  const archivePath = join(tmpDir, "claude-projects.tar.gz");
  const archive =
    await $`tar -czf ${archivePath} -C ${homedir() + "/.claude"} projects`
      .quiet()
      .nothrow();
  if (archive.exitCode !== 0) return;

  const partPrefix = join(tmpDir, PART_PREFIX);
  const split = await $`split -b 10m ${archivePath} ${partPrefix}`.quiet().nothrow();
  if (split.exitCode !== 0) return;

  await writeFile(join(tmpDir, "session-id.txt"), sessionId, "utf-8");

  const branch = branchName(entityType, entityNumber);
  const worktreePath = `${process.env.RUNNER_TEMP || "/tmp"}/claude-session-worktree-${entityNumber}`;

  await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet().nothrow();
  await $`rm -rf ${worktreePath}`.quiet().nothrow();

  const hasBranch =
    (
      await $`git -C ${repoPath} rev-parse --verify "refs/remotes/origin/${branch}"`
        .quiet()
        .nothrow()
    ).exitCode === 0;

  if (hasBranch) {
    await $`git -C ${repoPath} worktree add ${worktreePath} "origin/${branch}" --no-checkout`.quiet();
    await $`git -C ${worktreePath} checkout`.quiet();
  } else {
    await $`git -C ${repoPath} worktree add --orphan -b ${branch} ${worktreePath}`.quiet();
  }

  try {
    // Remove old parts (count may differ between runs), copy new parts + session ID
    await $`bash -c "rm -f ${worktreePath}/${PART_PREFIX}*"`.quiet().nothrow();

    const allTmp = await readdir(tmpDir);
    const parts = allTmp.filter((f) => f.startsWith(PART_PREFIX));
    for (const part of parts) {
      await $`cp ${join(tmpDir, part)} ${join(worktreePath, part)}`.quiet();
    }
    await $`cp ${join(tmpDir, "session-id.txt")} ${worktreePath}/session-id.txt`.quiet();

    await $`git -C ${worktreePath} add -A`.quiet();

    const status = await $`git -C ${worktreePath} status --porcelain`.quiet().nothrow();
    if (!status.stdout.toString().trim()) {
      console.log("Session state unchanged — nothing to save");
      return;
    }

    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await $`git -C ${worktreePath} commit -m "session: ${entityType}-${entityNumber} @ ${timestamp}"`.quiet();
    await $`git -C ${worktreePath} push origin "HEAD:refs/heads/${branch}"`;
    console.log(`Session state saved to branch ${branch} (${parts.length} part(s))`);
  } finally {
    await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet().nothrow();
  }
}
