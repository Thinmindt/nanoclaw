# Remove: calendar tool

Every step is safe to re-run. Events the tool already created stay on the calendar; delete them, or the
dedicated calendar, in Google Calendar if you want them gone.

## 1. Remove the gateway agent and its rules

Run this while the `CALENDAR_TOOL_*` keys are still in `.env`:

```bash
node .claude/skills/add-calendar-tool/setup-gateway.mjs --remove
```

## 2. Unregister the command

Delete this line from `src/cli/resources/index.ts`:

```typescript
import './calendar.js';
```

## 3. Remove the copied files

```bash
rm -f src/calendar-tool.ts src/calendar-tool.test.ts \
      src/cli/resources/calendar.ts src/cli/resources/calendar-registration.test.ts
```

## 4. Remove the settings

Delete these lines from `.env`:

```
CALENDAR_TOOL_CALENDAR_ID=…
CALENDAR_TOOL_CONNECTION_ID=…
CALENDAR_TOOL_GATEWAY_AGENT=…
CALENDAR_TOOL_AGENT_GROUPS=…
```

## 5. Build, stamp and restart

```bash
pnpm run build
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```
