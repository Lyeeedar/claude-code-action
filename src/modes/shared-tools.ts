/**
 * Shared tool list builder used by tag, agent, and schedule modes.
 *
 * Non-Anthropic models (e.g. MiniMax) may call lowercase tool names like
 * "grep" or "bash" instead of Claude Code's "Grep" / "Bash". Including
 * explicit Bash(grep:*) entries ensures those fall through to Bash even if
 * the model doesn't use the capitalised built-in names.
 */

export type ModeToolOptions = {
  useApiCommitSigning: boolean;
  gitPushWrapper: string;
  userAllowedMCPTools?: string[];
  extraTools?: string[];
};

/** Tools available in all modes regardless of config. */
export function buildBaseTools(opts: ModeToolOptions): string[] {
  const tools = new Set<string>([
    // Claude Code built-ins
    "Glob",
    "Grep",
    "LS",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "WebFetch",

    // Bash aliases for models that call lowercase/alternative names
    "Bash(grep:*)",
    "Bash(find:*)",
    "Bash(cat:*)",
    "Bash(ls:*)",
    "Bash(head:*)",
    "Bash(tail:*)",
    "Bash(echo:*)",
    "Bash(wc:*)",
    "Bash(sort:*)",
    "Bash(uniq:*)",
    "Bash(sed:*)",
    "Bash(awk:*)",
    "Bash(cut:*)",
    "Bash(jq:*)",
    "Bash(tr:*)",

    // gh CLI
    "Bash(gh pr edit:*)",
    "Bash(gh pr create:*)",
    "Bash(gh pr view:*)",
    "Bash(gh issue create:*)",
    "Bash(gh issue comment:*)",
    "Bash(gh issue view:*)",
  ]);

  // Git operations
  if (!opts.useApiCommitSigning) {
    tools.add("Bash(git add:*)");
    tools.add("Bash(git commit:*)");
    tools.add(`Bash(${opts.gitPushWrapper}:*)`);
    tools.add("Bash(git rm:*)");
    tools.add("Bash(git fetch:*)");
    tools.add("Bash(git rebase:*)");
    tools.add("Bash(git checkout:*)");
    tools.add("Bash(git diff:*)");
    tools.add("Bash(git status:*)");
    tools.add("Bash(git log:*)");
    tools.add("Bash(git stash:*)");
    tools.add("Bash(git show:*)");
    tools.add("Bash(git branch:*)");
  } else {
    tools.add("mcp__github_file_ops__commit_files");
    tools.add("mcp__github_file_ops__delete_files");
  }

  // MiniMax tools (vision + web search)
  if (process.env.MINIMAX_API_KEY) {
    tools.add("mcp__MiniMax__understand_image");
    tools.add("mcp__MiniMax__web_search");
  }

  for (const t of opts.userAllowedMCPTools ?? []) tools.add(t);
  for (const t of opts.extraTools ?? []) tools.add(t);

  return Array.from(tools);
}
