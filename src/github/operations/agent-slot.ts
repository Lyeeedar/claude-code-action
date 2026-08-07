import type { Octokits } from "../api/client";
import { retryWithBackoff } from "../../utils/retry";

/** How often to re-check whether a slot has freed up. */
export const SLOT_POLL_INTERVAL_MS = 60_000;

/**
 * Ceiling on queue time before a run gives up.
 *
 * Deliberately well under the GitHub App installation token's 1-hour lifetime:
 * that token is minted at the start of the job, and the agent itself can run
 * for 40 minutes, so queueing much longer than this would leave the run holding
 * a token that expires before it can push its work.
 */
export const SLOT_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

export class AgentSlotTimeoutError extends Error {
  constructor(waitedMs: number, ahead: number) {
    super(
      `No agent slot free after ${Math.round(waitedMs / 60000)} minutes ` +
        `(${ahead} run(s) still ahead in the queue). Re-trigger once the queue clears — ` +
        `the branch and PR for this run already exist, so nothing is lost.`,
    );
    this.name = "AgentSlotTimeoutError";
  }
}

/**
 * Derive the workflow's filename from GITHUB_WORKFLOW_REF, e.g.
 * "owner/repo/.github/workflows/agent.yml@refs/heads/main" -> "agent.yml".
 *
 * The `@ref` suffix is stripped first because it contains slashes of its own
 * (`refs/pull/12/merge`), which would otherwise swallow the filename.
 */
export function workflowFileFromRef(
  ref: string | undefined,
): string | undefined {
  if (!ref) return undefined;
  const path = ref.split("@")[0] ?? "";
  const file = path.split("/").pop() ?? "";
  return file.endsWith(".yml") || file.endsWith(".yaml") ? file : undefined;
}

/**
 * How many in-progress runs started before this one.
 *
 * Run IDs increase monotonically per repository, so a lower ID means an older
 * run. Admitting strictly oldest-first is what keeps the queue FIFO and free of
 * deadlock: the N oldest runs always see fewer than N ahead of them, so they
 * proceed while newer runs wait. Counting *every* in-progress run instead would
 * have each waiter counting every other waiter, and nothing would ever start.
 */
export function countRunsAhead(runIds: number[], myRunId: number): number {
  return runIds.filter((id) => id < myRunId).length;
}

/** Page through the in-progress runs of a single workflow. */
async function listInProgressRunIds(
  octokit: Octokits,
  owner: string,
  repo: string,
  workflowFile: string,
): Promise<number[]> {
  const perPage = 100;
  const maxPages = 5;
  const ids: number[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowFile,
      status: "in_progress",
      per_page: perPage,
      page,
    });
    ids.push(...data.workflow_runs.map((r) => r.id));
    if (data.workflow_runs.length < perPage) break;
  }
  return ids;
}

export type SlotWaitOptions = {
  octokit: Octokits;
  owner: string;
  repo: string;
  runId: number;
  /** Workflow filename, e.g. "agent.yml". Without it the limit can't be applied. */
  workflowFile: string | undefined;
  /** Max concurrent runs. Zero or negative disables the limit entirely. */
  maxParallel: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Called once per poll while queued — used to publish the wait to the PR. */
  onWaiting?: (info: {
    ahead: number;
    waitedMs: number;
  }) => void | Promise<void>;
};

/**
 * Block until fewer than `maxParallel` older runs of this workflow are still in
 * progress, so parallel agent sessions don't trip provider rate limits.
 *
 * Fails open: if the Actions API can't be reached (or the workflow can't be
 * identified) the run proceeds rather than being blocked by a broken check —
 * an unenforced limit is a better outcome than an agent that never starts.
 */
export async function waitForAgentSlot(opts: SlotWaitOptions): Promise<void> {
  const {
    octokit,
    owner,
    repo,
    runId,
    workflowFile,
    maxParallel,
    timeoutMs = SLOT_WAIT_TIMEOUT_MS,
    pollIntervalMs = SLOT_POLL_INTERVAL_MS,
    onWaiting,
  } = opts;

  if (!(maxParallel > 0)) {
    console.log("[slot] Concurrency limit disabled — starting immediately");
    return;
  }
  if (!workflowFile) {
    console.warn(
      "[slot] Could not determine the workflow filename (GITHUB_WORKFLOW_REF unset) — skipping the concurrency limit",
    );
    return;
  }
  if (!runId) {
    console.warn(
      "[slot] GITHUB_RUN_ID unset — skipping the concurrency limit (queue position is unknowable)",
    );
    return;
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (true) {
    let ahead: number;
    try {
      const ids = await retryWithBackoff(
        () => listInProgressRunIds(octokit, owner, repo, workflowFile),
        { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 4000 },
      );
      ahead = countRunsAhead(ids, runId);
    } catch (err) {
      console.warn(
        `[slot] Could not list in-progress runs (${err}) — proceeding without the concurrency limit`,
      );
      return;
    }

    if (ahead < maxParallel) {
      const waited = Date.now() - startedAt;
      console.log(
        `[slot] Slot acquired — ${ahead} older run(s) in progress (limit ${maxParallel})` +
          (waited > 1000 ? ` after waiting ${Math.round(waited / 1000)}s` : ""),
      );
      return;
    }

    const waitedMs = Date.now() - startedAt;
    if (Date.now() >= deadline) {
      throw new AgentSlotTimeoutError(waitedMs, ahead);
    }

    console.log(
      `[slot] Waiting — ${ahead} run(s) ahead of this one (limit ${maxParallel}), queued for ${Math.round(waitedMs / 1000)}s`,
    );
    try {
      await onWaiting?.({ ahead, waitedMs });
    } catch (err) {
      console.warn(`[slot] Could not publish queue status (non-fatal): ${err}`);
    }

    const sleepMs = Math.max(
      0,
      Math.min(pollIntervalMs, deadline - Date.now()),
    );
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}
