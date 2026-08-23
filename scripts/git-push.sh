#!/usr/bin/env bash
set -euo pipefail

# Wrapper around `git push` that only allows `origin <ref>` with no flags.
# Defends against --receive-pack / --exec RCE and arbitrary-remote exfiltration
# (H1 #3556799). `git push:*` in allowedTools permits `git push --receive-pack='sh -c ...' ext::sh`
# which runs arbitrary shell on the Actions runner. This wrapper closes that.
#
# Usage:
#   git-push.sh origin HEAD
#   git-push.sh origin claude/issue-123-20260304

if [[ $# -ne 2 ]]; then
  echo "Error: exactly two arguments required: origin <ref>" >&2
  exit 1
fi

for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    echo "Error: flags are not allowed (got: $arg)" >&2
    exit 1
  fi
done

if [[ "$1" != "origin" ]]; then
  echo "Error: remote must be 'origin' (got: $1)" >&2
  exit 1
fi

REF="$2"
if [[ "$REF" != "HEAD" ]] && ! git check-ref-format --branch "$REF" >/dev/null 2>&1; then
  echo "Error: invalid ref: $REF" >&2
  exit 1
fi

# A Stop hook is advisory until Claude tries to finish. Enforce the comment
# policy here as well so a violating commit cannot reach the remote first.
POLICY_CHECKER="${GITHUB_ACTION_PATH:?GITHUB_ACTION_PATH is required}/base-action/src/comment-policy.ts"
if ! POLICY_OUTPUT="$(bun "$POLICY_CHECKER")"; then
  echo "Error: code comment policy check could not run" >&2
  exit 1
fi
if [[ -n "$POLICY_OUTPUT" ]]; then
  echo "$POLICY_OUTPUT" >&2
  exit 1
fi

exec git push origin "$REF"
