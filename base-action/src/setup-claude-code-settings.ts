import { $ } from "bun";
import { homedir } from "os";
import { readFile } from "fs/promises";

export async function setupClaudeCodeSettings(
  settingsInput?: string,
  homeDir?: string,
) {
  const home = homeDir ?? homedir();
  const settingsPath = `${home}/.claude/settings.json`;
  console.log(`Setting up Claude settings at: ${settingsPath}`);

  // Ensure .claude directory exists
  console.log(`Creating .claude directory...`);
  await $`mkdir -p ${home}/.claude`.quiet();

  let settings: Record<string, unknown> = {};
  try {
    const existingSettings = await $`cat ${settingsPath}`.quiet().text();
    if (existingSettings.trim()) {
      settings = JSON.parse(existingSettings);
      console.log(
        `Found existing settings:`,
        JSON.stringify(settings, null, 2),
      );
    } else {
      console.log(`Settings file exists but is empty`);
    }
  } catch (e) {
    console.log(`No existing settings file found, creating new one`);
  }

  // Handle settings input (either file path or JSON string)
  if (settingsInput && settingsInput.trim()) {
    console.log(`Processing settings input...`);
    let inputSettings: Record<string, unknown> = {};

    try {
      // First try to parse as JSON
      inputSettings = JSON.parse(settingsInput);
      console.log(`Parsed settings input as JSON`);
    } catch (e) {
      // If not JSON, treat as file path
      console.log(
        `Settings input is not JSON, treating as file path: ${settingsInput}`,
      );
      try {
        const fileContent = await readFile(settingsInput, "utf-8");
        inputSettings = JSON.parse(fileContent);
        console.log(`Successfully read and parsed settings from file`);
      } catch (fileError) {
        console.error(`Failed to read or parse settings file: ${fileError}`);
        throw new Error(`Failed to process settings input: ${fileError}`);
      }
    }

    // Merge input settings with existing settings
    settings = { ...settings, ...inputSettings };
    console.log(`Merged settings with input settings`);
  }

  // Always set enableAllProjectMcpServers to true
  settings.enableAllProjectMcpServers = true;
  console.log(`Updated settings with enableAllProjectMcpServers: true`);

  // On PR review events, inject a Stop hook that enforces Claude made edits before finishing.
  // Checks both uncommitted changes (git status) and unpushed commits (git log @{u}..HEAD).
  if (process.env.GITHUB_EVENT_NAME === "pull_request_review" || process.env.CLAUDE_AGENT_ON_PR === "true") {
    const command =
      `python3 -c "import subprocess,json,os\n` +
      `g=subprocess.run(['git','status','--porcelain'],capture_output=True,text=True)\n` +
      `p=subprocess.run(['git','log','@{u}..HEAD','--oneline'],capture_output=True,text=True)\n` +
      `h=subprocess.run(['git','rev-parse','HEAD'],capture_output=True,text=True)\n` +
      `has_changes=bool(g.stdout.strip())\n` +
      `has_unpushed=p.returncode!=0 or bool(p.stdout.strip())\n` +
      `head_moved=h.returncode==0 and h.stdout.strip()!=os.environ.get('CLAUDE_INITIAL_HEAD','')\n` +
      `if not has_changes and not has_unpushed and not head_moved: print(json.dumps({'hookSpecificOutput':{'hookEventName':'Stop','decision':'block','reason':'No edits made and nothing to push. A reviewer requested changes on this PR - go back and address the review comments before finishing.'}}))"`;
    const stopHook = {
      hooks: [{ type: "command", command, statusMessage: "Checking for edits..." }],
    };
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    hooks.Stop = [...(hooks.Stop ?? []), stopHook];
    settings.hooks = hooks;
    console.log(`Injected Stop hook to enforce edits on pull_request_review`);
  }

  // Inject a Stop hook that checks the tracking comment for unchecked checkboxes.
  // If any remain, Claude must either complete the work or update the checkboxes.
  {
    const command =
      `python3 -c "import subprocess,json,os,sys\n` +
      `cid=os.environ.get('CLAUDE_TRACKING_COMMENT_ID')\n` +
      `repo=os.environ.get('GITHUB_REPOSITORY','')\n` +
      `if not cid or not repo: sys.exit(0)\n` +
      `r=subprocess.run(['gh','api',f'/repos/{repo}/issues/comments/{cid}'],capture_output=True,text=True)\n` +
      `if r.returncode!=0: sys.exit(0)\n` +
      `body=json.loads(r.stdout).get('body','')\n` +
      `if '- [ ]' in body: print(json.dumps({'hookSpecificOutput':{'hookEventName':'Stop','decision':'block','reason':'The tracking comment still has unchecked items. Either complete the remaining work or update the checkboxes to reflect what was actually accomplished.'}}))"`;
    const stopHook = {
      hooks: [{ type: "command", command, statusMessage: "Checking tracking comment..." }],
    };
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    hooks.Stop = [...(hooks.Stop ?? []), stopHook];
    settings.hooks = hooks;
    console.log(`Injected Stop hook to check tracking comment checkboxes`);
  }

  await $`echo ${JSON.stringify(settings, null, 2)} > ${settingsPath}`.quiet();
  console.log(`Settings saved successfully`);
}
