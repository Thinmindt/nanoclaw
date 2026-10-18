# Remove add-scout-gate

Reverses every change the skill's apply steps made. Run from the NanoClaw project root. Every
step is safe to re-run.

## 1. Remove the two calls from the agent-to-agent module

In `src/modules/agent-to-agent/guard.ts`, inside `a2aSend`'s `decide`, delete the four lines
that start with the comment `// add-scout-gate skill: a content check that can refuse, never
allow.` and end with `if (veto) return DENY(veto);`. The line `if (isSelf) return
ALLOW('self-send');` is then followed directly by the `getMessagePolicy` lookup, as before the
skill.

In `src/modules/agent-to-agent/agent-route.ts`, at the top of `performAgentRoute`, delete the
three lines that start with the comment `// add-scout-gate skill: an answer from a gated agent
arrives as bounded plain text.` and end with the `msg = { ...msg, ... }` assignment.

## 2. Remove the copied files

```bash
rm -rf src/modules/a2a-gate
```

## 3. Build, stamp and restart

```bash
pnpm run build
pnpm exec vitest run src/modules/agent-to-agent src/guard
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Messages to the Scout then pass with only the structural checks and the message policies, and
its answers arrive as sent. Remove the Architect's `scout` destination first if the Scout still
has web access:

```bash
ncl destinations remove --agent-group-id <architect-id> --local-name scout
```

The term lists under `data/a2a-gate/` and the message policies are the operator's; delete them
by hand (`ncl policies remove --from <id> --to <id>`).
