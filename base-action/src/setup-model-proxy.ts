import { execSync, spawn } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PROXY_PORT = 4001;
const SUPPORTED_PROVIDERS = ["openai", "xai"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

interface ParsedModel {
  provider: SupportedProvider;
  modelName: string;
  litellmTarget: string;
}

/**
 * Parse a model spec of the form "provider/model-name" or just "model-name"
 * (bare names default to the openai backend).
 * Examples: "xai/grok-4-1-fast-non-reasoning", "openai/GPT-5.3-Codex", "GPT-5.4"
 */
function parseModelSpec(spec: string): ParsedModel {
  const slashIdx = spec.indexOf("/");
  if (slashIdx !== -1) {
    const prefix = spec.slice(0, slashIdx);
    if ((SUPPORTED_PROVIDERS as readonly string[]).includes(prefix)) {
      const modelName = spec.slice(slashIdx + 1);
      return {
        provider: prefix as SupportedProvider,
        modelName,
        litellmTarget: spec,
      };
    }
  }
  return {
    provider: "openai",
    modelName: spec,
    litellmTarget: `openai/${spec}`,
  };
}

function apiKeyEnvName(provider: SupportedProvider): string {
  return provider === "xai" ? "XAI_API_KEY" : "OPENAI_API_KEY";
}

function buildLiteLLMConfig(models: ParsedModel[]): string {
  const lines = ["model_list:"];
  const seen = new Set<string>();
  for (const { modelName, litellmTarget, provider } of models) {
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

async function waitForProxy(port: number, maxWaitMs = 60000): Promise<void> {
  const url = `http://localhost:${port}/health`;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
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
 * Start a LiteLLM proxy that translates Anthropic-format requests from Claude
 * Code into OpenAI or xAI API calls, then sets ANTHROPIC_BASE_URL to point
 * Claude Code at it.
 *
 * Model specs use "provider/model-name" format (e.g. "xai/grok-4-1-fast-non-reasoning").
 * Bare names default to the openai backend.
 *
 * Tier mapping (what Claude Code routes internally):
 *   haiku  → small spec  (fast / cheap — used by Claude Code for lightweight tasks)
 *   sonnet → medium spec (the default for almost all work)
 *   opus   → large spec  (complex reasoning, rarely selected)
 *
 * To enforce "almost always medium", pass the same medium spec for both
 * smallSpec and mediumSpec so the haiku tier also routes to the medium model.
 */
export async function setupModelProxy(
  smallSpec: string,
  mediumSpec: string,
  largeSpec: string,
  xaiApiKey: string,
  openaiApiKey: string,
): Promise<void> {
  if (!mediumSpec) throw new Error("'model' (medium tier) is required");
  if (!xaiApiKey && !openaiApiKey)
    throw new Error(
      "At least one of 'xai_api_key' or 'openai_api_key' must be provided",
    );

  const small = parseModelSpec(smallSpec || mediumSpec);
  const medium = parseModelSpec(mediumSpec);
  const large = parseModelSpec(largeSpec || mediumSpec);

  if (xaiApiKey) process.env.XAI_API_KEY = xaiApiKey;
  if (openaiApiKey) process.env.OPENAI_API_KEY = openaiApiKey;

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
    { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: false },
  );

  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  child.on("error", (err: Error) => {
    throw new Error(`LiteLLM failed to start: ${err.message}`);
  });

  await waitForProxy(PROXY_PORT);

  process.env.ANTHROPIC_BASE_URL = `http://localhost:${PROXY_PORT}`;
  process.env.ANTHROPIC_AUTH_TOKEN = "litellm-proxy";
  process.env.ANTHROPIC_API_KEY = "";

  // Set all four model env vars so Claude Code routes each tier correctly
  process.env.ANTHROPIC_MODEL = medium.modelName;
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = medium.modelName;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small.modelName;
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = large.modelName;

  console.log("LiteLLM proxy ready.");
}
