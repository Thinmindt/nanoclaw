# Remove Discord

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './discord.js';
```

Then delete the copied adapter and its tests:

```bash
rm -f src/channels/discord.ts src/channels/discord-registration.test.ts src/channels/discord-sibling-bot-gate.test.ts
```

## 2. Remove credentials

Remove `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_PUBLIC_KEY` from `.env`, and, if you added a bot per agent group, `DISCORD_INSTANCES` and every `DISCORD_BOT_TOKEN_<NAME>`, `DISCORD_APPLICATION_ID_<NAME>` and `DISCORD_PUBLIC_KEY_<NAME>`.

## 3. Remove the package

```bash
pnpm uninstall @chat-adapter/discord
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
