#!/usr/bin/env bash
# Commit whatever Steward changed in the vault and sync it with GitHub.
# Runs on the host, so the GitHub deploy key never enters an agent container.
# It never force-pushes, so history on GitHub can only grow.
set -euo pipefail

VAULT="${VAULT:-$HOME/vault/second-brain}"
cd "$VAULT"

git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "steward: $(date -u +%Y-%m-%dT%H:%MZ)"
fi

# Take Greg's edits from Greg's devices first; on a conflict, stop and leave it
# for a human rather than guessing.
if ! git pull -q --rebase origin main; then
  git rebase --abort || true
  echo "vault-sync: rebase conflict, needs a person" >&2
  exit 1
fi
git push -q origin HEAD:main
