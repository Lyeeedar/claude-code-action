/**
 * Validates that the proxy is configured before Claude Code runs.
 * setupModelProxy() must have already run — it sets ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN pointing at the local LiteLLM instance.
 */
export function validateEnvironmentVariables() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;

  if (!baseUrl || !authToken) {
    throw new Error(
      "Model proxy is not configured. " +
        "ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN must be set before running Claude Code. " +
        "Ensure 'xai_api_key' or 'openai_api_key' is provided so the proxy can start.",
    );
  }
}
