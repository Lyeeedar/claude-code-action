import { describe, expect, test } from "bun:test";
import {
  AgentSlotTimeoutError,
  countRunsAhead,
  waitForAgentSlot,
  workflowFileFromRef,
} from "../src/github/operations/agent-slot";
import type { Octokits } from "../src/github/api/client";

// Realistic 11-digit run IDs — the ordering must survive numbers this large.
const OLDER = [
  19834567801, 19834567802, 19834567803, 19834567804, 19834567805, 19834567806,
  19834567807, 19834567808, 19834567809, 19834567810, 19834567811,
];
const ME = 19834567899;

/**
 * Fake Actions API. Each entry in `pages` is the id list returned by one
 * successive call, so a test can model the queue draining between polls.
 * `null` makes that call throw.
 */
function fakeOctokit(responses: (number[] | null)[]) {
  const calls: { page: number; workflow_id: string }[] = [];
  const octokit = {
    rest: {
      actions: {
        listWorkflowRuns: async (params: {
          workflow_id: string;
          page: number;
        }) => {
          calls.push({ page: params.page, workflow_id: params.workflow_id });
          const ids =
            responses[Math.min(calls.length - 1, responses.length - 1)];
          if (ids === null || ids === undefined) throw new Error("API is down");
          return { data: { workflow_runs: ids.map((id) => ({ id })) } };
        },
      },
    },
  } as unknown as Octokits;
  return { octokit, calls };
}

const base = {
  owner: "o",
  repo: "r",
  runId: ME,
  workflowFile: "agent.yml",
  maxParallel: 9,
  pollIntervalMs: 5,
};

describe("workflowFileFromRef", () => {
  test("extracts the filename from a branch ref", () => {
    expect(
      workflowFileFromRef(
        "o/r/.github/workflows/afnm_agent.yml@refs/heads/main",
      ),
    ).toBe("afnm_agent.yml");
  });

  test("survives a ref containing slashes", () => {
    expect(
      workflowFileFromRef("o/r/.github/workflows/agent.yml@refs/pull/12/merge"),
    ).toBe("agent.yml");
  });

  test("accepts .yaml", () => {
    expect(
      workflowFileFromRef("o/r/.github/workflows/a.yaml@refs/heads/x"),
    ).toBe("a.yaml");
  });

  test("returns undefined when unset or not a workflow file", () => {
    expect(workflowFileFromRef(undefined)).toBeUndefined();
    expect(workflowFileFromRef("")).toBeUndefined();
    expect(
      workflowFileFromRef("o/r/.github/workflows/agent@refs/heads/x"),
    ).toBeUndefined();
  });
});

describe("countRunsAhead", () => {
  test("counts only older runs", () => {
    expect(countRunsAhead(OLDER, ME)).toBe(11);
    expect(countRunsAhead(OLDER, OLDER[2]!)).toBe(2);
  });

  test("ignores newer runs entirely", () => {
    expect(countRunsAhead(OLDER, 19834567800)).toBe(0);
  });

  test("does not count the run itself", () => {
    expect(countRunsAhead([ME], ME)).toBe(0);
  });

  test("handles an empty queue", () => {
    expect(countRunsAhead([], ME)).toBe(0);
  });
});

describe("waitForAgentSlot", () => {
  test("returns immediately when fewer runs are ahead than the limit", async () => {
    const { octokit, calls } = fakeOctokit([OLDER]);
    await waitForAgentSlot({ ...base, octokit, runId: OLDER[2]! });
    expect(calls).toHaveLength(1);
  });

  test("waits while the queue is full, then proceeds when it drains", async () => {
    const { octokit, calls } = fakeOctokit([OLDER, OLDER, OLDER.slice(0, 3)]);
    const waits: number[] = [];
    await waitForAgentSlot({
      ...base,
      octokit,
      onWaiting: ({ ahead }) => {
        waits.push(ahead);
      },
    });
    expect(waits).toEqual([11, 11]);
    expect(calls).toHaveLength(3);
  });

  test("treats exactly `maxParallel` ahead as full", async () => {
    const { octokit } = fakeOctokit([OLDER.slice(0, 9), OLDER.slice(0, 8)]);
    const waits: number[] = [];
    await waitForAgentSlot({
      ...base,
      octokit,
      onWaiting: ({ ahead }) => {
        waits.push(ahead);
      },
    });
    expect(waits).toEqual([9]);
  });

  test("throws once the queue timeout passes", async () => {
    const { octokit } = fakeOctokit([OLDER]);
    await expect(
      waitForAgentSlot({ ...base, octokit, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(AgentSlotTimeoutError);
  });

  test("does not apply the limit when maxParallel is zero or negative", async () => {
    const { octokit, calls } = fakeOctokit([OLDER]);
    await waitForAgentSlot({ ...base, octokit, maxParallel: 0 });
    await waitForAgentSlot({ ...base, octokit, maxParallel: -1 });
    expect(calls).toHaveLength(0);
  });

  test("skips the limit when the workflow file is unknown", async () => {
    const { octokit, calls } = fakeOctokit([OLDER]);
    await waitForAgentSlot({ ...base, octokit, workflowFile: undefined });
    expect(calls).toHaveLength(0);
  });

  test("skips the limit when the run id is unknown", async () => {
    const { octokit, calls } = fakeOctokit([OLDER]);
    await waitForAgentSlot({ ...base, octokit, runId: 0 });
    expect(calls).toHaveLength(0);
  });

  test("fails open rather than blocking when the API keeps erroring", async () => {
    const { octokit, calls } = fakeOctokit([null]);
    await waitForAgentSlot({ ...base, octokit });
    expect(calls.length).toBeGreaterThanOrEqual(3); // retried before giving up
  }, 15_000);

  test("a failing onWaiting hook never blocks the queue", async () => {
    const { octokit } = fakeOctokit([OLDER, OLDER.slice(0, 1)]);
    await waitForAgentSlot({
      ...base,
      octokit,
      onWaiting: () => {
        throw new Error("PR update failed");
      },
    });
  });
});
