import { describe, expect, test } from "bun:test";
import {
  applyStatusBlock,
  AgentStatusReporter,
  formatDuration,
  formatTokens,
  prNumberFromUrl,
  renderAgentStatus,
  stripStatusBlock,
  updateAgentStatus,
  STATUS_END,
  STATUS_START,
} from "../src/github/operations/pr-status";
import type { Octokits } from "../src/github/api/client";

/** Fake pulls API backed by a single in-memory body. */
function fakePrApi(initialBody: string, opts: { failGet?: boolean } = {}) {
  const state = { body: initialBody, writes: 0, reads: 0 };
  const octokit = {
    rest: {
      pulls: {
        get: async () => {
          state.reads++;
          if (opts.failGet) throw new Error("PR is gone");
          return { data: { body: state.body } };
        },
        update: async (params: { body: string }) => {
          state.writes++;
          state.body = params.body;
          return { data: {} };
        },
      },
    },
  } as unknown as Octokits;
  return { octokit, state };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const PROGRESS = { messages: 42, inputTokens: 1_234_567, outputTokens: 8_912 };

describe("formatDuration", () => {
  test("formats seconds, minutes and hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_930_000)).toBe("1h 5m");
  });

  test("never renders a negative duration", () => {
    expect(formatDuration(-5000)).toBe("0s");
  });
});

describe("formatTokens", () => {
  test("abbreviates thousands and millions", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });
});

describe("prNumberFromUrl", () => {
  test("extracts the number from a PR url", () => {
    expect(prNumberFromUrl("https://github.com/o/r/pull/123")).toBe(123);
  });

  test("returns undefined for non-PR input", () => {
    expect(prNumberFromUrl(undefined)).toBeUndefined();
    expect(prNumberFromUrl("https://github.com/o/r/issues/5")).toBeUndefined();
  });
});

describe("renderAgentStatus", () => {
  test("waiting reports queue depth and how long it has waited", () => {
    const block = renderAgentStatus(
      { phase: "waiting", ahead: 3, waitedMs: 245_000 },
      "https://job",
    );
    expect(block.startsWith(STATUS_START)).toBe(true);
    expect(block.endsWith(STATUS_END)).toBe(true);
    expect(block).toContain("Queued");
    expect(block).toContain("3 agent run(s) ahead");
    expect(block).toContain("waiting 4m 5s");
    expect(block).toContain("(https://job)");
  });

  test("running reports messages and tokens both ways", () => {
    const block = renderAgentStatus({
      phase: "running",
      ...PROGRESS,
      elapsedMs: 600_000,
    });
    expect(block).toContain("Running");
    expect(block).toContain("42 messages");
    expect(block).toContain("1.2M tokens in / 8.9k out");
    expect(block).toContain("elapsed 10m 0s");
  });

  test("omits the token clause when the provider reported none", () => {
    const block = renderAgentStatus({
      phase: "running",
      messages: 56,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 97_000,
    });
    expect(block).toContain("56 messages");
    expect(block).not.toContain("tokens in");
    expect(block).toContain("elapsed 1m 37s");
  });

  test("completed carries a done marker", () => {
    const block = renderAgentStatus({
      phase: "completed",
      ...PROGRESS,
      elapsedMs: 60_000,
    });
    expect(block).toContain("✅");
    expect(block).toContain("Agent run complete");
  });

  test("incomplete states the reason and the work done", () => {
    const block = renderAgentStatus({
      phase: "incomplete",
      ...PROGRESS,
      elapsedMs: 60_000,
      reason: "40-minute timeout reached",
    });
    expect(block).toContain("Incomplete");
    expect(block).toContain("40-minute timeout reached");
    expect(block).toContain("Work done before stopping: 42 messages");
    expect(block).toContain("may be partial");
  });

  test("incomplete before any work says so rather than showing zeroes", () => {
    const block = renderAgentStatus({
      phase: "incomplete",
      messages: 0,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 0,
      reason: "no agent slot free",
    });
    expect(block).toContain("The agent had not started work.");
    expect(block).not.toContain("0 messages");
  });

  test("renders as a single line so the block stays a compact banner", () => {
    const block = renderAgentStatus({
      phase: "running",
      ...PROGRESS,
      elapsedMs: 1000,
    });
    const inner = block
      .replace(STATUS_START, "")
      .replace(STATUS_END, "")
      .trim();
    expect(inner.split("\n")).toHaveLength(1);
    expect(inner.startsWith("> ")).toBe(true);
  });
});

describe("stripStatusBlock", () => {
  test("removes the block and leading whitespace", () => {
    const body = `${STATUS_START}\n> old\n${STATUS_END}\n\nReal description`;
    expect(stripStatusBlock(body)).toBe("Real description");
  });

  test("leaves a body without a block untouched", () => {
    expect(stripStatusBlock("Just a description")).toBe("Just a description");
  });

  test("leaves a body with only a start marker untouched", () => {
    const body = `${STATUS_START}\n> dangling`;
    expect(stripStatusBlock(body)).toBe(body);
  });

  test("preserves content that precedes the block", () => {
    const body = `Intro\n\n${STATUS_START}\n> old\n${STATUS_END}\n\nOutro`;
    expect(stripStatusBlock(body)).toBe("Intro\n\n\n\nOutro");
  });
});

describe("applyStatusBlock", () => {
  const block = renderAgentStatus({
    phase: "completed",
    ...PROGRESS,
    elapsedMs: 1000,
  });

  test("puts the block first in a plain body", () => {
    const result = applyStatusBlock("Description here", block);
    expect(result.startsWith(STATUS_START)).toBe(true);
    expect(result).toContain("Description here");
  });

  test("replaces a previous block rather than stacking them", () => {
    const first = applyStatusBlock(
      "Description here",
      renderAgentStatus({ phase: "waiting", ahead: 2, waitedMs: 0 }),
    );
    const second = applyStatusBlock(first, block);
    expect(second.indexOf(STATUS_START)).toBe(0);
    expect(second.split(STATUS_START)).toHaveLength(2);
    expect(second).not.toContain("Queued");
    expect(second).toContain("Description here");
  });

  test("is stable when applied repeatedly with the same status", () => {
    const once = applyStatusBlock("Body", block);
    expect(applyStatusBlock(once, block)).toBe(once);
  });

  test("handles an empty body", () => {
    expect(applyStatusBlock("", block)).toBe(block);
  });
});

describe("updateAgentStatus", () => {
  test("prepends the banner to the existing description", async () => {
    const { octokit, state } = fakePrApi("Original description");
    await updateAgentStatus(octokit, "o", "r", 7, {
      phase: "waiting",
      ahead: 4,
      waitedMs: 0,
    });
    expect(state.writes).toBe(1);
    expect(state.body.startsWith(STATUS_START)).toBe(true);
    expect(state.body).toContain("Original description");
  });

  test("does not write when the body is already correct", async () => {
    const { octokit, state } = fakePrApi("Body");
    const status = { phase: "completed" as const, ...PROGRESS, elapsedMs: 0 };
    await updateAgentStatus(octokit, "o", "r", 7, status);
    await updateAgentStatus(octokit, "o", "r", 7, status);
    expect(state.writes).toBe(1);
  });

  test("survives a null body", async () => {
    const octokit = {
      rest: {
        pulls: {
          get: async () => ({ data: { body: null } }),
          update: async () => ({ data: {} }),
        },
      },
    } as unknown as Octokits;
    await updateAgentStatus(octokit, "o", "r", 7, {
      phase: "waiting",
      ahead: 1,
      waitedMs: 0,
    });
  });
});

describe("AgentStatusReporter", () => {
  const reporterFor = (octokit: Octokits, refreshMs = 5) =>
    new AgentStatusReporter({
      octokit,
      owner: "o",
      repo: "r",
      prNumber: 7,
      refreshMs,
    });

  test("publishes immediately when the phase changes", async () => {
    const { octokit, state } = fakePrApi("Body");
    const reporter = reporterFor(octokit);
    reporter.set({ phase: "waiting", ahead: 3, waitedMs: 0 });
    await reporter.flush();
    reporter.stop();
    expect(state.writes).toBe(1);
    expect(state.body).toContain("Queued");
  });

  test("collapses a burst of updates into one write of the newest values", async () => {
    const { octokit, state } = fakePrApi("Body");
    const reporter = reporterFor(octokit);
    // No timer started, so nothing but the phase change reaches the API — and
    // because a queued write reads the status at write time, the 25 rapid
    // updates collapse into that one write rather than 25.
    for (let i = 1; i <= 25; i++) {
      reporter.set({
        phase: "running",
        messages: i,
        inputTokens: i * 10,
        outputTokens: i,
        elapsedMs: i * 1000,
      });
    }
    await reporter.flush();
    reporter.stop();
    expect(state.writes).toBe(1);
    expect(state.body).toContain("25 messages");
  });

  test("the refresh timer republishes the latest values", async () => {
    const { octokit, state } = fakePrApi("Body");
    const reporter = reporterFor(octokit, 5);
    reporter.start();
    reporter.set({
      phase: "running",
      messages: 1,
      inputTokens: 1,
      outputTokens: 1,
      elapsedMs: 0,
    });
    await tick();
    const afterFirst = state.writes;
    reporter.set({
      phase: "running",
      messages: 99,
      inputTokens: 500_000,
      outputTokens: 4_000,
      elapsedMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    reporter.stop();
    await reporter.flush();
    expect(state.writes).toBeGreaterThan(afterFirst);
    expect(state.body).toContain("99 messages");
  });

  test("stop() prevents any further timer writes", async () => {
    const { octokit, state } = fakePrApi("Body");
    const reporter = reporterFor(octokit, 5);
    reporter.start();
    reporter.set({ phase: "waiting", ahead: 1, waitedMs: 0 });
    await reporter.flush();
    reporter.stop();
    const writes = state.writes;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.writes).toBe(writes);
  });

  test("a failing API never throws out of the reporter", async () => {
    const { octokit, state } = fakePrApi("Body", { failGet: true });
    const reporter = reporterFor(octokit);
    reporter.set({ phase: "waiting", ahead: 1, waitedMs: 0 });
    await reporter.flush();
    reporter.stop();
    expect(state.writes).toBe(0);
  });

  test("never runs two body updates at once", async () => {
    // Two overlapping read-modify-write cycles would race, and the loser would
    // resurrect a stale banner — so writes must be strictly serialised.
    let active = 0;
    let maxActive = 0;
    let writes = 0;
    const octokit = {
      rest: {
        pulls: {
          // Always returns the original body, so every publish has work to do.
          get: async () => ({ data: { body: "Body" } }),
          update: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
            writes++;
            return { data: {} };
          },
        },
      },
    } as unknown as Octokits;
    const reporter = reporterFor(octokit);
    reporter.set({ phase: "waiting", ahead: 1, waitedMs: 0 });
    await Promise.all([reporter.flush(), reporter.flush(), reporter.flush()]);
    reporter.stop();
    expect(maxActive).toBe(1);
    expect(writes).toBe(4); // the phase change plus three explicit flushes
  });
});
