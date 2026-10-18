# Remove: Discord approval buttons patch

Every step is safe to re-run.

## 1. Restore the option decode

In `src/channels/chat-sdk-bridge.ts`, in `resolveSelectedOption`, replace the two lines

```typescript
  // Discord joins custom_id and value as "<index>\n<index>": patch-discord-approval-buttons skill.
  const candidate = (eventValue ?? tail ?? '').split('\n')[0];
```

with

```typescript
  const candidate = eventValue ?? tail ?? '';
```

Skip this step when upstream has replaced the function with its own fix. No-op when the comment line is
absent.

## 2. Remove the copied test

```bash
rm -f src/channels/discord-approval-buttons.test.ts
```

Keep it instead if upstream's fix is in, as a guard on that fix.

## 3. Build, stamp and restart

```bash
pnpm run build
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Without upstream's fix, every Discord approval card then resolves as rejected again.
