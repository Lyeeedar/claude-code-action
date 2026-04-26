import { execSync, spawn } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PROXY_PORT = 4001;
const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";
const KIMI_ANTHROPIC_BASE_URL = "https://api.moonshot.ai/anthropic";
const SUPPORTED_PROVIDERS = ["openai", "xai", "minimax", "kimi"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

interface ParsedModel {
  provider: SupportedProvider;
  modelName: string;
  litellmTarget: string;
}

/**
 * Parse a model spec of the form "provider/model-name" or just "model-name"
 * (bare names default to the openai backend).
 * Examples: "xai/grok-4-1-fast-non-reasoning", "minimax/MiniMax-M2.7", "gpt-4o"
 *
 * Provider prefix is lowercased for matching; model name casing is preserved
 * because some APIs (MiniMax) are case-sensitive.
 */
function parseModelSpec(spec: string): ParsedModel {
  const slashIdx = spec.indexOf("/");
  if (slashIdx !== -1) {
    const prefix = spec.slice(0, slashIdx).toLowerCase();
    if ((SUPPORTED_PROVIDERS as readonly string[]).includes(prefix)) {
      const modelName = spec.slice(slashIdx + 1);
      return {
        provider: prefix as SupportedProvider,
        modelName,
        litellmTarget: `${prefix}/${modelName}`,
      };
    }
  }
  const modelName = spec;
  return {
    provider: "openai",
    modelName,
    litellmTarget: `openai/${modelName}`,
  };
}

function apiKeyEnvName(provider: SupportedProvider): string {
  if (provider === "xai") return "XAI_API_KEY";
  if (provider === "minimax") return "MINIMAX_API_KEY";
  if (provider === "kimi") return "KIMI_API_KEY";
  return "OPENAI_API_KEY";
}

function buildLiteLLMConfig(models: ParsedModel[]): string {
  const lines = [
    "litellm_settings:",
    "  use_responses_api: false",
    "model_list:",
  ];
  const seen = new Set<string>();
  for (const { modelName, litellmTarget, provider, apiBase } of models) {
    if (seen.has(modelName)) continue;
    seen.add(modelName);
    lines.push(
      `  - model_name: "${modelName}"`,
      `    litellm_params:`,
      `      model: "${litellmTarget}"`,
      `      api_key: os.environ/${apiKeyEnvName(provider)}`,
    );
  }
  return lines.join("\n") + "\n";
}

function installLiteLLM(): void {
  console.log("Installing LiteLLM proxy...");
  execSync(
    "pip install 'litellm[proxy]' --quiet --disable-pip-version-check",
    { stdio: "inherit" },
  );
  console.log("LiteLLM installed.");
}

async function waitForProxy(
  port: number,
  child: ReturnType<typeof spawn>,
  maxWaitMs = 60000,
): Promise<void> {
  const url = `http://localhost:${port}/health`;
  const start = Date.now();

  // Fail immediately if the child exits before the proxy is ready
  let childExitCode: number | null = null;
  child.on("exit", (code) => {
    childExitCode = code ?? 1;
  });

  while (Date.now() - start < maxWaitMs) {
    if (childExitCode !== null) {
      throw new Error(`LiteLLM exited with code ${childExitCode} before becoming ready`);
    }
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `LiteLLM proxy did not become ready within ${maxWaitMs / 1000}s`,
  );
}

/**
 * Configure the model backend for Claude Code.
 *
 * When ALL three tiers use the "minimax" provider, skips LiteLLM entirely and
 * points ANTHROPIC_BASE_URL directly at MiniMax's native Anthropic-compatible
 * endpoint. This avoids parameter translation issues and removes the proxy
 * overhead.
 *
 * For mixed-provider setups (e.g. xAI for small, OpenAI for medium/large),
 * starts a LiteLLM proxy that translates Anthropic-format requests from Claude
 * Code into the appropriate provider API calls.
 *
 * Model specs use "provider/model-name" format (e.g. "minimax/MiniMax-M2.7").
 * Bare names default to the openai backend.
 *
 * Tier mapping (what Claude Code routes internally):
 *   haiku  → small spec  (fast / cheap — used by Claude Code for lightweight tasks)
 *   sonnet → medium spec (the default for almost all work)
 *   opus   → large spec  (complex reasoning, rarely selected)
 */
export async function setupModelProxy(
  smallSpec: string,
  mediumSpec: string,
  largeSpec: string,
  xaiApiKey: string,
  openaiApiKey: string,
  minimaxApiKey: string,
  kimiApiKey: string,
): Promise<void> {
  if (!mediumSpec) throw new Error("'model' (medium tier) is required");
  if (!xaiApiKey && !openaiApiKey && !minimaxApiKey && !kimiApiKey)
    throw new Error(
      "At least one of 'xai_api_key', 'openai_api_key', 'minimax_api_key', or 'kimi_api_key' must be provided",
    );

  const small = parseModelSpec(smallSpec || mediumSpec);
  const medium = parseModelSpec(mediumSpec);
  const large = parseModelSpec(largeSpec || mediumSpec);

  if (xaiApiKey) process.env.XAI_API_KEY = xaiApiKey;
  if (openaiApiKey) process.env.OPENAI_API_KEY = openaiApiKey;
  if (minimaxApiKey) process.env.MINIMAX_API_KEY = minimaxApiKey;
  if (kimiApiKey) process.env.KIMI_API_KEY = kimiApiKey;

  const allMinimax = [small, medium, large].every(m => m.provider === "minimax");
  const allKimi = [small, medium, large].every(m => m.provider === "kimi");

  if (allMinimax) {
    if (!minimaxApiKey)
      throw new Error("'minimax_api_key' is required when using MiniMax models");

    console.log(
      `Using MiniMax direct endpoint (no proxy):\n` +
        `  haiku  → ${small.modelName}\n` +
        `  sonnet → ${medium.modelName}  ← default\n` +
        `  opus   → ${large.modelName}`,
    );

    process.env.ANTHROPIC_BASE_URL = MINIMAX_ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = minimaxApiKey;
    process.env.ANTHROPIC_AUTH_TOKEN = "";
  } else if (allKimi) {
    if (!kimiApiKey)
      throw new Error("'kimi_api_key' is required when using Kimi models");

    console.log(
      `Using Kimi direct endpoint (no proxy):\n` +
        `  haiku  → ${small.modelName}\n` +
        `  sonnet → ${medium.modelName}  ← default\n` +
        `  opus   → ${large.modelName}`,
    );

    process.env.ANTHROPIC_BASE_URL = KIMI_ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = kimiApiKey;
    process.env.ANTHROPIC_AUTH_TOKEN = "";
    process.env.ENABLE_TOOL_SEARCH = "false";
  } else {
    installLiteLLM();

    const configPath = join(tmpdir(), "litellm-config.yaml");
    writeFileSync(configPath, buildLiteLLMConfig([small, medium, large]));

    console.log(
      `Starting LiteLLM proxy on port ${PROXY_PORT}...\n` +
        `  haiku  → ${small.modelName} (${small.provider})\n` +
        `  sonnet → ${medium.modelName} (${medium.provider})  ← default\n` +
        `  opus   → ${large.modelName} (${large.provider})`,
    );

    const child = spawn(
      "litellm",
      ["--config", configPath, "--port", String(PROXY_PORT)],
      {
        env: { ...process.env, LITELLM_USE_RESPONSES_API: "false" },
        stdio: "inherit",
        detached: false,
      },
    );

    await waitForProxy(PROXY_PORT, child);
    child.unref();

    process.env.ANTHROPIC_BASE_URL = `http://localhost:${PROXY_PORT}`;
    process.env.ANTHROPIC_AUTH_TOKEN = "litellm-proxy";
    process.env.ANTHROPIC_API_KEY = "";
  }

  // Set all four model env vars so Claude Code routes each tier correctly
  process.env.ANTHROPIC_MODEL = medium.modelName;
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = medium.modelName;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small.modelName;
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = large.modelName;

  console.log("Model backend configured.");
}
