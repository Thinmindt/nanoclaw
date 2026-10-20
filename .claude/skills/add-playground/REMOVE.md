# Remove add-playground

Run from the NanoClaw project root. Every step is safe to re-run.

## 1. Remove the command and the files

Delete the line `import './playground.js';` from `src/cli/resources/index.ts`, then:

```bash
rm -f src/playground-tool.ts src/playground-tool.test.ts src/playground-skill-sync.test.ts
rm -f src/cli/resources/playground.ts src/cli/resources/playground-group-scope.test.ts
rm -rf container/playground
```

## 2. Build, stamp and restart

```bash
pnpm run build
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

## 3. Operator leftovers

Delete the `PLAYGROUND_*` lines from `.env` and the image (`docker image rm nanoclaw-playground:latest`).
Each agent's `playground/` folder of past runs is its own; leave it or delete it by hand.
