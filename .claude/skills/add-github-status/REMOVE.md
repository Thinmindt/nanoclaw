# Remove: GitHub status tool

Every step is safe to re-run. The tool wrote nothing anywhere, so there is nothing to clean up on
GitHub.

## 1. Remove the gateway agent and its rules

Run this while the `GITHUB_STATUS_*` keys are still in `.env`:

```bash
node .claude/skills/add-github-status/setup-gateway.mjs --remove
```

If it stops because of unpublished dashboard edits to other rules, publish or discard those, or
add `--force`. A GitHub token assigned to the identity goes with the identity; revoke it on GitHub
as well if it is no longer needed.

## 2. Unregister the commands

Delete this line from `src/cli/resources/index.ts`:

```typescript
import './github.js';
```

## 3. Remove the copied files

```bash
rm -f src/github-status.ts src/github-status.test.ts src/github-status-skill-sync.test.ts \
      src/cli/resources/github.ts src/cli/resources/github-registration.test.ts \
      src/cli/resources/github-group-scope.test.ts
```

## 4. Remove the settings

Delete these lines from `.env`:

```
GITHUB_STATUS_OWNER_LOGIN=…
GITHUB_STATUS_REPOS=…
GITHUB_STATUS_GATEWAY_AGENT=…
GITHUB_STATUS_AGENT_GROUPS=…
GITHUB_STATUS_RATE_LIMIT_PER_HOUR=…
```

Then remove the note about the tool from the agent's memory or instructions.

## 5. Build, stamp and restart

```bash
pnpm run build
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```
