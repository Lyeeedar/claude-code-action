---
# Human-readable description (used as the workflow name)
description: "TODO: one-line description of what this task does"

# How often to run. Options:
#   hourly | daily | weekly | every 2 hours | every 3 hours | every 4 hours |
#   every 6 hours | every 8 hours | every 12 hours
# The compiler auto-balances the exact cron time to avoid concurrency with other tasks.
schedule: daily

# Maximum runtime in minutes (default: 30)
timeout-minutes: 30

# GitHub Actions permissions needed by this task
permissions:
  contents: write        # required for state branch commits
  issues: write          # required for steering issue + creating issues
  pull-requests: write   # if the task opens PRs

# Tools available to Claude
tools:
  bash: false            # allow arbitrary bash commands
  web-fetch: false       # allow fetching external URLs
  # git: true            # (always available for commits/push)

# Additional environment variables injected into the workflow step
# Use ${{ secrets.X }} syntax — resolved from repo secrets at workflow run time
# extra-env:
#   MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}

# GitHub issue number used for user steering.
# Leave unset on first push — the task will create the issue on first run
# and write its number back here. You can also create it manually.
# steering-issue: 42

# Set to false to disable this task without deleting it
enabled: true
---

<!--
  This is the prompt Claude receives every time this task runs.

  Available context injected automatically:
  - $AGENT_STATE_DIR  — path to a local directory backed by the
                        agent-state/<task-name> git branch. Read/write
                        JSON files here to persist information across runs.
                        Changes are committed back to the branch after each run.

  - Steering directives — if steering-issue is set, ALL comments from that
                          issue are prepended to this prompt on every run.
                          Post there to redirect the agent without redeploying.

  Tips:
  - Keep the core goal stable; use the steering issue for week-to-week direction.
  - Load state early: read $AGENT_STATE_DIR/state.json to resume from last run.
  - Save state before finishing: write updated state.json to $AGENT_STATE_DIR/.
  - Use the GitHub MCP tools to open issues/PRs for findings.
-->

## Goal

TODO: describe the task's objective.

## Instructions

1. Load your state from `$AGENT_STATE_DIR/state.json` (create it if absent).
2. TODO: describe what to do each run.
3. Save updated state back to `$AGENT_STATE_DIR/state.json` before finishing.

## State schema

```json
{
  "lastRunAt": "ISO timestamp",
  "cursor": "whatever position you were at last time"
}
```
