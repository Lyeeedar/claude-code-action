import { $ } from "bun";
import { homedir } from "os";
import { readFile, writeFile } from "fs/promises";

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

  // Force in-process teammate mode — no tmux available in CI.
  settings.teammateMode = "in-process";
  console.log(`Set teammateMode: in-process`);

  // Enforce that Claude always makes changes — except in schedule mode where read-only runs are valid.
  // Checks uncommitted changes, unpushed commits, and whether HEAD moved since the session started.
  if (process.env.CLAUDE_MODE !== "schedule") {
    const command =
      `python3 -c "import subprocess,json,os\n` +
      `g=subprocess.run(['git','status','--porcelain'],capture_output=True,text=True)\n` +
      `p=subprocess.run(['git','log','@{u}..HEAD','--oneline'],capture_output=True,text=True)\n` +
      `h=subprocess.run(['git','rev-parse','HEAD'],capture_output=True,text=True)\n` +
      `has_changes=bool(g.stdout.strip())\n` +
      `has_unpushed=p.returncode!=0 or bool(p.stdout.strip())\n` +
      `head_moved=h.returncode==0 and h.stdout.strip()!=os.environ.get('CLAUDE_INITIAL_HEAD','')\n` +
      `if not has_changes and not has_unpushed and not head_moved: print(json.dumps({'hookSpecificOutput':{'hookEventName':'Stop','decision':'block','reason':'You have not made any code changes. Your job is to implement fixes and improvements, not just review or explain. Go back and make the actual changes required.'}}))"`;
    const stopHook = {
      hooks: [{ type: "command", command, statusMessage: "Checking for edits..." }],
    };
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    hooks.Stop = [...(hooks.Stop ?? []), stopHook];
    settings.hooks = hooks;
    console.log(`Injected Stop hook to enforce edits (mode: ${process.env.CLAUDE_MODE})`);
  }

  // Write the code review subagent script. The Stop hook calls this to spin up
  // a full Claude Code session that explores the codebase and verifies the work
  // is complete. Uses --setting-sources project to skip user settings and prevent
  // recursive Stop hook triggering.
  const reviewScript = `#!/usr/bin/env python3
import subprocess, json, os, sys

try:
    repo = os.environ.get('GITHUB_REPOSITORY', '')
    entity_num = os.environ.get('CLAUDE_ENTITY_NUMBER', '')
    if not repo or not entity_num:
        sys.exit(0)

    r = subprocess.run(['gh', 'api', f'/repos/{repo}/issues/{entity_num}'],
        capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(0)
    issue = json.loads(r.stdout)

    cr = subprocess.run(['gh', 'api', f'/repos/{repo}/issues/{entity_num}/comments'],
        capture_output=True, text=True)
    comments = json.loads(cr.stdout) if cr.returncode == 0 else []
    comment_thread = '\\n\\n'.join([
        f"**@{c['user']['login']}**: {c['body']}" for c in comments[:20]
    ]) or '(no comments)'

    diff_result = subprocess.run(['git', 'diff', 'origin/main...HEAD'],
        capture_output=True, text=True)
    diff = diff_result.stdout[:80000] if diff_result.returncode == 0 else '(no diff available)'

    prompt = f"""You are an extremely critical code reviewer. Your job is to verify whether a GitHub issue has been fully and correctly addressed.

## Issue #{entity_num}: {issue['title']}

{issue['body']}

## Discussion Thread

{comment_thread}

## Changes Made (diff vs main)

\`\`\`diff
{diff}
\`\`\`

## Your Task

Explore the codebase thoroughly using Read, Grep, and Glob. Do NOT rely solely on the diff - look at the actual files in context to understand what was changed and whether it is correct.

Be **extremely critical**. Check:
1. Every requirement stated in the issue is fully addressed
2. The implementation has no logic errors or missed edge cases
3. The code integrates correctly with surrounding systems
4. Nothing is half-done, stubbed out, or left as a placeholder
5. Any files mentioned in the issue or discussion were actually modified

If anything is missing, wrong, or incomplete, say so explicitly.

End your response with exactly one of these lines (nothing after it):
VERDICT: COMPLETE
VERDICT: INCOMPLETE - <specific list of problems>"""

    result = subprocess.run(
        ['claude', '-p', prompt, '--setting-sources', 'project'],
        capture_output=True, text=True,
        timeout=600,
        env={**os.environ}
    )
    if result.returncode != 0:
        sys.exit(0)

    output = result.stdout
    verdict_line = ''
    for line in reversed(output.strip().split('\\n')):
        line = line.strip()
        if line.startswith('VERDICT:'):
            verdict_line = line
            break

    if not verdict_line or 'INCOMPLETE' not in verdict_line:
        sys.exit(0)

    reason = verdict_line.split('INCOMPLETE -', 1)[-1].strip() if 'INCOMPLETE -' in verdict_line else 'See review output.'
    block_reason = f"Code review subagent found the implementation incomplete.\\n\\n**Problems:**\\n{reason}\\n\\n**Full review:**\\n{output[-3000:]}"
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'Stop', 'decision': 'block', 'reason': block_reason}}))
except Exception as e:
    print(f"Review hook error (non-fatal): {e}", file=sys.stderr)
    sys.exit(0)
`;

  const reviewScriptPath = "/tmp/claude-code-review.py";
  await writeFile(reviewScriptPath, reviewScript, "utf-8");
  console.log(`Wrote code review script to ${reviewScriptPath}`);

  const reviewStopHook = {
    hooks: [{ type: "command", command: `python3 ${reviewScriptPath}`, statusMessage: "Running code review subagent..." }],
  };
  {
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    hooks.Stop = [...(hooks.Stop ?? []), reviewStopHook];
    settings.hooks = hooks;
  }
  console.log(`Injected Stop hook for code review subagent`);

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
