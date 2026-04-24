/**
 * Validates that the proxy is configured before Claude Code runs.
 * setupModelProxy() must have already run — it sets ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN pointing at the local LiteLLM instance.
 */
export function validateEnvironmentVariables() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;

  if (!baseUrl || (!apiKey && !authToken)) {
    throw new Error(
      "Model backend is not configured. " +
        "ANTHROPIC_BASE_URL and either ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN must be set. " +
        "Ensure 'xai_api_key', 'openai_api_key', or 'minimax_api_key' is provided.",
    );
  }
}
