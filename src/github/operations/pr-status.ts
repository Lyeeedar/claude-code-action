import type { Octokits } from "../api/client";

/**
 * Live agent status, rendered as the first thing in the PR description.
 *
 * The block is delimited by HTML comment markers so it can be replaced in place
 * without disturbing whatever the agent (or a human) wrote below it.
 */
export const STATUS_START = "<!-- claude-agent-status:start -->";
export const STATUS_END = "<!-- claude-agent-status:end -->";

/** How often the reporter republishes the current status. */
export const STATUS_REFRESH_MS = 60_000;

export type AgentProgress = {
  /** Conversation messages seen so far (assistant replies + tool results). */
  messages: number;
  inputTokens: number;
  outputTokens: number;
};

export type AgentStatus =
  | { phase: "waiting"; ahead: number; waitedMs: number }
  | ({ phase: "running"; elapsedMs: number } & AgentProgress)
  | ({ phase: "completed"; elapsedMs: number } & AgentProgress)
  | ({
      phase: "incomplete";
      elapsedMs: number;
      reason: string;
    } & AgentProgress);

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(n)));
}

function formatWork(p: AgentProgress): string {
  const messages = `${p.messages} message${p.messages === 1 ? "" : "s"}`;
  // Not every provider reports token usage. Saying "0 tokens" would be a
  // claim we can't back — omit the clause rather than print a false zero.
  if (p.inputTokens === 0 && p.outputTokens === 0) return messages;
  return (
    `${messages} · ` +
    `${formatTokens(p.inputTokens)} tokens in / ${formatTokens(p.outputTokens)} out`
  );
}

/** Extract the PR number from an html_url like ".../pull/123". */
export function prNumberFromUrl(url: string | undefined): number | undefined {
  const match = url?.match(/\/pull\/(\d+)/);
  if (!match?.[1]) return undefined;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function renderAgentStatus(
  status: AgentStatus,
  jobUrl?: string,
): string {
  const link = jobUrl ? ` · [view job run](${jobUrl})` : "";

  let line: string;
  switch (status.phase) {
    case "waiting":
      line =
        `⏳ **Queued** — ${status.ahead} agent run(s) ahead of this one · ` +
        `waiting ${formatDuration(status.waitedMs)}`;
      break;
    case "running":
      line =
        `🤖 **Running** — ${formatWork(status)} · ` +
        `elapsed ${formatDuration(status.elapsedMs)}`;
      break;
    case "completed":
      line =
        `✅ **Agent run complete** — ${formatWork(status)} · ` +
        `took ${formatDuration(status.elapsedMs)}`;
      break;
    case "incomplete": {
      const work =
        status.messages === 0 && status.outputTokens === 0
          ? "The agent had not started work."
          : `Work done before stopping: ${formatWork(status)} over ${formatDuration(status.elapsedMs)}.`;
      line =
        `⚠️ **Incomplete — the agent did not finish** (${status.reason}). ` +
        `${work} Anything pushed to this branch may be partial.`;
      break;
    }
  }

  return `${STATUS_START}\n> ${line}${link}\n${STATUS_END}`;
}

/** Remove any existing status block, leaving the rest of the body untouched. */
export function stripStatusBlock(body: string): string {
  const start = body.indexOf(STATUS_START);
  if (start === -1) return body;
  const end = body.indexOf(STATUS_END, start);
  if (end === -1) return body;
  const rest = body.slice(0, start) + body.slice(end + STATUS_END.length);
  return rest.replace(/^\s+/, "");
}

/** Put `block` at the very top of the body, replacing any previous block. */
export function applyStatusBlock(body: string, block: string): string {
  const rest = stripStatusBlock(body).trimStart();
  return rest ? `${block}\n\n${rest}` : block;
}

export type AgentStatusReporterOptions = {
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
  jobUrl?: string;
  refreshMs?: number;
};

/**
 * Keeps a PR description's status banner up to date.
 *
 * `set()` only records the status — it publishes immediately on a phase change
 * (queued → running → done) and otherwise lets the refresh timer push the
 * latest values once a minute, so a chatty agent can't spam the API.
 */
export class AgentStatusReporter {
  private readonly opts: AgentStatusReporterOptions;
  private status: AgentStatus | undefined;
  private publishedPhase: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: AgentStatusReporterOptions) {
    this.opts = opts;
  }

  /** Begin republishing the current status once per refresh interval. */
  start(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      void this.publish();
    }, this.opts.refreshMs ?? STATUS_REFRESH_MS);
    // Never let the refresh timer hold the process open at shutdown.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  set(status: AgentStatus): void {
    this.status = status;
    if (status.phase !== this.publishedPhase) {
      this.publishedPhase = status.phase;
      void this.publish();
    }
  }

  /** Wait for any in-flight write, then publish the latest status. */
  async flush(): Promise<void> {
    await this.publish();
  }

  private publish(): Promise<void> {
    // Serialise writes — two overlapping read-modify-write cycles on the same
    // body would race, and the loser would resurrect a stale status.
    this.queue = this.queue.then(async () => {
      const status = this.status;
      if (!status) return;
      try {
        await updateAgentStatus(
          this.opts.octokit,
          this.opts.owner,
          this.opts.repo,
          this.opts.prNumber,
          status,
          this.opts.jobUrl,
        );
      } catch (err) {
        console.warn(
          `[status] Could not update PR #${this.opts.prNumber} description (non-fatal): ${err}`,
        );
      }
    });
    return this.queue;
  }
}

/** Read the PR body, replace the status block, and write it back. */
export async function updateAgentStatus(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
  status: AgentStatus,
  jobUrl?: string,
): Promise<void> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const existing = pr.body ?? "";
  const body = applyStatusBlock(existing, renderAgentStatus(status, jobUrl));
  if (body === existing) return;
  await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, body });
}
