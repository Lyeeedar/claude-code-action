import { describe, expect, test } from "bun:test";
import {
  findUsage,
  readUsage,
  updateProgress,
  type ClaudeProgress,
} from "../base-action/src/progress-usage";

const fresh = (): ClaudeProgress => ({
  messages: 0,
  inputTokens: 0,
  outputTokens: 0,
});

/** The shape the Anthropic path emits. */
const anthropicAssistant = (usage: Record<string, number>) => ({
  type: "assistant",
  message: { role: "assistant", content: [], usage },
});

describe("findUsage", () => {
  test("finds usage nested under message", () => {
    expect(findUsage(anthropicAssistant({ input_tokens: 5 }))).toEqual({
      input_tokens: 5,
    });
  });

  test("finds usage at the top level", () => {
    expect(findUsage({ type: "result", usage: { input_tokens: 5 } })).toEqual({
      input_tokens: 5,
    });
  });

  test("prefers the nested object when both exist", () => {
    const message = {
      type: "assistant",
      usage: { input_tokens: 1 },
      message: { usage: { input_tokens: 2 } },
    };
    expect(findUsage(message)).toEqual({ input_tokens: 2 });
  });

  test("returns undefined when there is no usage anywhere", () => {
    expect(
      findUsage({ type: "assistant", message: { content: [] } }),
    ).toBeUndefined();
    expect(findUsage({ type: "system" })).toBeUndefined();
    expect(findUsage(null)).toBeUndefined();
    expect(findUsage(undefined)).toBeUndefined();
  });

  test("ignores a non-object usage field", () => {
    expect(findUsage({ type: "assistant", usage: 42 })).toBeUndefined();
  });
});

describe("readUsage", () => {
  test("adds Anthropic cache tokens to the input side", () => {
    expect(
      readUsage({
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 300,
        output_tokens: 50,
      }),
    ).toEqual({ input: 420, output: 50 });
  });

  test("understands OpenAI-style names from a proxied model", () => {
    expect(readUsage({ prompt_tokens: 900, completion_tokens: 120 })).toEqual({
      input: 900,
      output: 120,
    });
  });

  test("does not double-count when both vocabularies are present", () => {
    expect(
      readUsage({
        input_tokens: 100,
        prompt_tokens: 100,
        output_tokens: 10,
        completion_tokens: 10,
      }),
    ).toEqual({ input: 100, output: 10 });
  });

  test("treats missing, null and non-numeric fields as zero", () => {
    expect(readUsage({})).toEqual({ input: 0, output: 0 });
    expect(
      readUsage({ input_tokens: null, output_tokens: "many" } as Record<
        string,
        unknown
      >),
    ).toEqual({ input: 0, output: 0 });
  });
});

describe("updateProgress", () => {
  test("counts assistant and user turns, not system or result", () => {
    const p = fresh();
    updateProgress(p, { type: "system", subtype: "init" });
    updateProgress(p, anthropicAssistant({}));
    updateProgress(p, { type: "user", message: { content: [] } });
    updateProgress(p, { type: "result", subtype: "success" });
    expect(p.messages).toBe(2);
  });

  test("accumulates tokens across assistant turns", () => {
    const p = fresh();
    updateProgress(
      p,
      anthropicAssistant({ input_tokens: 10, output_tokens: 3 }),
    );
    updateProgress(
      p,
      anthropicAssistant({ input_tokens: 20, output_tokens: 4 }),
    );
    expect(p).toEqual({ messages: 2, inputTokens: 30, outputTokens: 7 });
  });

  test("counts a proxied top-level usage object", () => {
    const p = fresh();
    updateProgress(p, {
      type: "assistant",
      usage: { prompt_tokens: 500, completion_tokens: 60 },
    });
    expect(p).toEqual({ messages: 1, inputTokens: 500, outputTokens: 60 });
  });

  test("ignores usage attached to a tool result", () => {
    const p = fresh();
    updateProgress(p, {
      type: "user",
      message: { usage: { input_tokens: 999, output_tokens: 999 } },
    });
    expect(p).toEqual({ messages: 1, inputTokens: 0, outputTokens: 0 });
  });

  test("the result message corrects totals upward when nothing was reported", () => {
    const p = fresh();
    updateProgress(p, anthropicAssistant({}));
    updateProgress(p, {
      type: "result",
      usage: { input_tokens: 12_000, output_tokens: 800 },
    });
    expect(p.inputTokens).toBe(12_000);
    expect(p.outputTokens).toBe(800);
  });

  test("the result message never reduces already-counted totals", () => {
    const p = fresh();
    updateProgress(
      p,
      anthropicAssistant({ input_tokens: 900, output_tokens: 90 }),
    );
    updateProgress(p, {
      type: "result",
      usage: { input_tokens: 400, output_tokens: 40 },
    });
    expect(p.inputTokens).toBe(900);
    expect(p.outputTokens).toBe(90);
  });

  test("survives messages with no usage at all", () => {
    const p = fresh();
    updateProgress(p, { type: "assistant", message: { content: [] } });
    updateProgress(p, { type: "stream_event" });
    expect(p).toEqual({ messages: 1, inputTokens: 0, outputTokens: 0 });
  });
});
