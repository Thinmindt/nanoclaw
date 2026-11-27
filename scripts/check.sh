#!/usr/bin/env bash
# The local bar before a pull request: CI's test and skill-pins jobs in one
# command, stopping at the first failing step with that step's exit status.
#
#   bash scripts/check.sh
#
# The runner typecheck and the Bun suite run inside the agent image, since the
# host has no Bun. The image is the one container/build.sh builds for
# NANOCLAW_PROJECT_ROOT (default: this checkout); from a worktree, set it to the
# install whose image to use. CONTAINER_RUNTIME is honored as build.sh does.
#
# Not run here, and why (scripts/check-sh.test.ts reads these "skip:" lines):
# skip: pnpm install --frozen-lockfile (never installs; it checks against the node_modules already in place)
# skip: iron-front job (needs Go 1.26.1 and fetches stock Iron over the network)
# skip: verify-agent-image workflow (needs ECR and GitHub OIDC)
# skip: registry-skills workflow (reads the registry branches from local git refs)
# skip: Node 22/24 matrix (one local Node, whichever is on PATH)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "== Format check"
pnpm run format:check
echo "== Typecheck host"
pnpm exec tsc --noEmit
echo "== Host tests"
pnpm exec vitest run
echo "== Lint"
pnpm run lint

runtime="${CONTAINER_RUNTIME:-docker}"
NANOCLAW_PROJECT_ROOT="${NANOCLAW_PROJECT_ROOT:-$root}"
source "$root/setup/lib/install-slug.sh"
image="$(container_image_base):latest"

# CI runs bun install; here the image's baked /app/node_modules stand in, so the
# image must have been built from this checkout's bun.lock (build.sh labels it)
# and package.json (CI's frozen install fails when the two disagree). A stale
# image passing the Bun suite would be a false green.
echo "== Agent image $image"
own_image="Build this checkout's own image (container/build.sh, NANOCLAW_PROJECT_ROOT unset) and rerun without NANOCLAW_PROJECT_ROOT."
lock="$(shasum -a 256 container/agent-runner/bun.lock | cut -d' ' -f1)"
label="$("$runtime" image inspect --format '{{index .Config.Labels "dev.nanoclaw.agent-runner-lock-sha256"}}' "$image")" || {
  echo "check.sh: cannot read the agent image $image: $runtime is missing or not running, or the image is not built (container/build.sh), or NANOCLAW_PROJECT_ROOT should name the install whose image to use." >&2
  exit 1
}
if [ "$label" != "$lock" ]; then
  echo "check.sh: $image was built from another container/agent-runner/bun.lock (image: $label, checkout: $lock). $own_image" >&2
  exit 1
fi
"$runtime" run --rm --entrypoint cat "$image" /app/package.json | cmp -s - container/agent-runner/package.json || {
  echo "check.sh: container/agent-runner/package.json is not the image's. $own_image" >&2
  exit 1
}

# The runner's tests read host files by relative path, so the Bun steps run in a
# repo-shaped copy of the checkout's tracked files (as CI sees them, so a new
# file counts once it is added), with the runner's node_modules the image's.
git ls-files -z \
  | tar --null -T - -cf - \
  | "$runtime" run --rm -i --init --network none --entrypoint bash "$image" -c '
      set -euo pipefail
      mkdir /tmp/repo
      tar -C /tmp/repo -xf -
      ln -s /app/node_modules /tmp/repo/container/agent-runner/node_modules
      cd /tmp/repo/container/agent-runner
      echo "== Typecheck container (in the image)"
      node_modules/.bin/tsc -p tsconfig.json --noEmit
      echo "== Container tests (in the image)"
      bun run test
    '

echo "== Skill pins"
pnpm run skill-pins:check

echo "check.sh: every step passed"
