import { runClaudeWithSdk } from "./run-claude-sdk";
import type { ClaudeProgressCallback, ClaudeRunResult } from "./run-claude-sdk";
import { parseSdkOptions } from "./parse-sdk-options";

export type { ClaudeProgress, ClaudeProgressCallback } from "./run-claude-sdk";

export type ClaudeOptions = {
  claudeArgs?: string;
  model?: string;
  pathToClaudeCodeExecutable?: string;
  allowedTools?: string;
  disallowedTools?: string;
  maxTurns?: string;
  mcpConfig?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  fallbackModel?: string;
  showFullOutput?: string;
};

export async function runClaude(
  promptPath: string,
  options: ClaudeOptions,
  onProgress?: ClaudeProgressCallback,
): Promise<ClaudeRunResult> {
  const parsedOptions = parseSdkOptions(options);
  return runClaudeWithSdk(promptPath, parsedOptions, onProgress);
}
