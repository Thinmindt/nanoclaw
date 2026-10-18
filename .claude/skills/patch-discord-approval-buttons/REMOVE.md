# Remove: Discord approval buttons patch

Every step is safe to re-run.

## 1. Restore the tail line

In `src/channels/chat-sdk-bridge.ts`, in the `GATEWAY_INTERACTION_CREATE` branch, delete the comment line
`// patch-discord-approval-buttons skill: …` and change

```typescript
          tail = customId.slice(colonIdx + 1).split('\n')[0];
```

back to

```typescript
          tail = customId.slice(colonIdx + 1);
```

No-op when the line already reads that way.

## 2. Remove the copied test

```bash
rm -f src/channels/discord-approval-button.test.ts
```

## 3. Build, stamp and restart

```bash
pnpm run build
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```
