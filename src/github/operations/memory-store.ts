import { mkdir, readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import type { Octokits } from "../api/client";

const MEMORY_BRANCH = "claude-memory";

/**
 * Fetch the shared claude-memory branch and restore all markdown files into
 * .memsearch/memory/ inside the workspace so the memsearch plugin can find them.
 * The plugin's SessionStart/UserPromptSubmit hooks handle indexing and injection.
 */
export async function restoreMemoryFiles(repoPath: string): Promise<void> {
  const memoryDir = join(repoPath, ".memsearch", "memory");
  await mkdir(memoryDir, { recursive: true });

  console.log(`[memory] Fetching memory store from branch ${MEMORY_BRANCH}...`);
  const fetch = await $`git -C ${repoPath} fetch origin refs/heads/${MEMORY_BRANCH}`.nothrow();
  if (fetch.exitCode !== 0) {
    console.log("[memory] No memory branch yet — starting fresh");
    return;
  }

  const extract = await $`git -C ${repoPath} archive FETCH_HEAD | tar -x -C ${memoryDir}`
    .quiet()
    .nothrow();
  if (extract.exitCode !== 0) {
    console.log("[memory] Failed to extract memory files — starting fresh");
    return;
  }

  const files = await readdir(memoryDir).catch(() => [] as string[]);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  console.log(`[memory] Restored ${mdFiles.length} memory file(s)`);
}

/**
 * Commit any new or updated markdown files in .memsearch/memory/ back to
 * the shared claude-memory branch.  Retries once on concurrent-push conflict.
 */
export async function saveMemoryStore(repoPath: string): Promise<void> {
  const memoryDir = join(repoPath, ".memsearch", "memory");
  if (!existsSync(memoryDir)) return;

  const files = await readdir(memoryDir).catch(() => [] as string[]);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return;

  const worktreePath = `${process.env.RUNNER_TEMP || "/tmp"}/claude-memory-worktree`;

  await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet().nothrow();
  await $`rm -rf ${worktreePath}`.quiet().nothrow();

  const hasBranch =
    (
      await $`git -C ${repoPath} rev-parse --verify "refs/remotes/origin/${MEMORY_BRANCH}"`
        .quiet()
        .nothrow()
    ).exitCode === 0;

  if (hasBranch) {
    await $`git -C ${repoPath} worktree add ${worktreePath} "origin/${MEMORY_BRANCH}" --no-checkout`
      .quiet()
      .nothrow();
    await $`git -C ${worktreePath} checkout`.quiet().nothrow();
  } else {
    await $`git -C ${repoPath} worktree add --orphan -b ${MEMORY_BRANCH} ${worktreePath}`
      .quiet()
      .nothrow();
  }

  try {
    for (const file of mdFiles) {
      await $`cp ${join(memoryDir, file)} ${join(worktreePath, file)}`.quiet();
    }

    await $`git -C ${worktreePath} add -A`.quiet();

    const status = await $`git -C ${worktreePath} status --porcelain`.quiet().nothrow();
    if (!status.stdout.toString().trim()) {
      console.log("[memory] No new memories to save");
      return;
    }

    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await $`git -C ${worktreePath} commit -m "memory: update @ ${timestamp}"`.quiet();

    const push = await $`git -C ${worktreePath} push origin "HEAD:refs/heads/${MEMORY_BRANCH}"`
      .nothrow();
    if (push.exitCode !== 0) {
      console.log("[memory] Push conflict — rebasing and retrying...");
      await $`git -C ${worktreePath} pull origin ${MEMORY_BRANCH} --rebase`.quiet().nothrow();
      await $`git -C ${worktreePath} push origin "HEAD:refs/heads/${MEMORY_BRANCH}"`.quiet().nothrow();
    }

    console.log(`[memory] Saved memory store to branch ${MEMORY_BRANCH}`);
  } finally {
    await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet().nothrow();
  }
}

const MEMORY_ISSUE_TITLE = "🧠 Claude Agent Memory Store";
const MEMORY_ISSUE_BODY_LIMIT = 60_000;

/**
 * Find or create the persistent memory issue and update its body with the
 * full contents of every markdown file in the memory store, newest first.
 */
export async function updateMemoryIssue(
  octokit: Octokits,
  owner: string,
  repo: string,
  repoPath: string,
): Promise<void> {
  const memoryDir = join(repoPath, ".memsearch", "memory");
  if (!existsSync(memoryDir)) return;

  const allFiles = await readdir(memoryDir).catch(() => [] as string[]);
  const mdFiles = allFiles.filter((f) => f.endsWith(".md")).sort().reverse();
  if (mdFiles.length === 0) return;

  const sections: string[] = [];
  for (const file of mdFiles) {
    const content = await readFile(join(memoryDir, file), "utf-8").catch(() => "");
    if (content.trim()) {
      sections.push(`## ${file}\n\n${content.trim()}`);
    }
  }

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let body =
    `> Auto-updated by Claude agent after each run. Do not edit manually.\n` +
    `> Last updated: ${timestamp}\n\n---\n\n` +
    sections.join("\n\n---\n\n");

  if (body.length > MEMORY_ISSUE_BODY_LIMIT) {
    body =
      body.slice(0, MEMORY_ISSUE_BODY_LIMIT) +
      "\n\n…*(truncated — see `claude-memory` branch for full history)*";
  }

  const search = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: "all",
    per_page: 100,
  });
  const existing = search.data.find(
    (i) => i.title === MEMORY_ISSUE_TITLE && !i.pull_request,
  );

  if (existing) {
    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: existing.number,
      body,
      state: "open",
    });
    console.log(`[memory] Updated memory issue #${existing.number}`);
  } else {
    const created = await octokit.rest.issues.create({
      owner,
      repo,
      title: MEMORY_ISSUE_TITLE,
      body,
      labels: [],
    });
    console.log(`[memory] Created memory issue #${created.data.number}`);
  }
}
