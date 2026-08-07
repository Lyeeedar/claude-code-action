/**
 * Token accounting for the live progress banner.
 *
 * Kept free of SDK imports so it can be unit tested against raw message shapes.
 *
 * Message shapes vary by provider: the Anthropic path reports usage on
 * `message.message.usage` with `input_tokens`/`output_tokens`, while a model
 * proxied through LiteLLM (MiniMax, xAI, OpenAI) can surface it at the top
 * level and/or with OpenAI's `prompt_tokens`/`completion_tokens` names. Rather
 * than bet on one, look in both places and accept both vocabularies.
 */

export type ClaudeProgress = {
  messages: number;
  inputTokens: number;
  outputTokens: number;
};

export type ClaudeProgressCallback = (progress: ClaudeProgress) => void;

/** Input-side totals. Anthropic splits cache tokens out; OpenAI folds them in. */
const INPUT_KEYS = ["input_tokens", "prompt_tokens"];
const INPUT_EXTRA_KEYS = [
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];
const OUTPUT_KEYS = ["output_tokens", "completion_tokens"];

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** First key that carries a number, so alternative spellings don't double-count. */
function firstOf(usage: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (typeof usage[key] === "number") return num(usage[key]);
  }
  return 0;
}

/** Locate a usage object regardless of where this provider hangs it. */
export function findUsage(
  message: unknown,
): Record<string, unknown> | undefined {
  const m = message as
    | { usage?: unknown; message?: { usage?: unknown } | null }
    | null
    | undefined;
  for (const candidate of [m?.message?.usage, m?.usage]) {
    if (candidate && typeof candidate === "object") {
      return candidate as Record<string, unknown>;
    }
  }
  return undefined;
}

export function readUsage(usage: Record<string, unknown>): {
  input: number;
  output: number;
} {
  const input =
    firstOf(usage, INPUT_KEYS) +
    INPUT_EXTRA_KEYS.reduce((sum, key) => sum + num(usage[key]), 0);
  return { input, output: firstOf(usage, OUTPUT_KEYS) };
}

/**
 * Fold one streamed message into the running totals.
 *
 * The terminal `result` message carries session-cumulative usage, so it's
 * allowed to correct the running totals upward — that way a provider which
 * reports usage only at the end still produces a truthful final number,
 * without a provider that reports per-message ever being double-counted.
 */
export function updateProgress(
  progress: ClaudeProgress,
  message: unknown,
): void {
  const type = (message as { type?: unknown } | null)?.type;

  if (type === "assistant" || type === "user") {
    progress.messages++;
  }

  const usage = findUsage(message);
  if (!usage) return;
  const { input, output } = readUsage(usage);

  if (type === "result") {
    if (input > progress.inputTokens) progress.inputTokens = input;
    if (output > progress.outputTokens) progress.outputTokens = output;
    return;
  }

  // Tool results (`user`) echo no usage of their own; only model turns do.
  if (type !== "assistant") return;
  progress.inputTokens += input;
  progress.outputTokens += output;
}
