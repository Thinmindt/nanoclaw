# Remove add-tool-denylist

Reverses every change the skill's apply steps made. Run from the NanoClaw project root. Every
step is safe to re-run.

## 1. Undo the core edits

- `src/container-config.ts`, `materializeContainerJson`: delete the comment
  `// add-tool-denylist skill: ...` and the two lines after it (the import and
  `const disallowedTools = ...`), and change the `fs.writeFileSync` call back to
  `fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');`.
- `container/agent-runner/src/config.ts`: delete `disallowedTools` from `RunnerConfig` and from
  `runnerConfigFromRaw`.
- `container/agent-runner/src/providers/types.ts`: delete `disallowedTools` from `ProviderOptions`.
- `container/agent-runner/src/index.ts`: delete `disallowedTools: config.disallowedTools,` from the
  `createProvider` call.
- `container/agent-runner/src/providers/claude.ts`: delete the `groupDisallowedTools` field and its
  constructor line, and change the query option back to
  `disallowedTools: [...this.executionPolicy.disallowedTools],`.

## 2. Remove the copied files

```bash
rm -rf src/modules/tool-denylist
rm -f container/agent-runner/src/providers/claude.disallowed-tools.test.ts
```

## 3. Build, stamp and restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Every group gets the full tool list back on its next container start. `data/tool-denylist.json`
is the operator's; delete it by hand.
