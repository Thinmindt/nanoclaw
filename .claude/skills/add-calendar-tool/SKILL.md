---
name: add-calendar-tool
description: Add `ncl calendar create-event`, a host-side tool that lets chosen agents create events on one Google calendar with no way to add guests or send invitations. Use when an agent should be able to put things on a calendar but must not be able to invite anyone.
---

# Add calendar tool

Agents read Google Calendar through the credential gateway, but the gateway's rules match only host, path
and method. A rule that lets an agent create events also lets it add `attendees`, and an event with an
outside attendee lands on that person's calendar, description included. That is a leak path for
prompt-injected content.

This skill adds a host-side command, `ncl calendar create-event`, as the only way to write events:

- **No guests possible:** it accepts title, start/end (or all-day), location, description and popup
  reminders only. Guest-like and unknown fields are refused, and the request body never carries attendees
  or conference data. It always posts with `sendUpdates=none`.
- **One calendar, chosen agents:** it writes only to `CALENDAR_TOOL_CALENDAR_ID`, and only for agent groups
  in `CALENDAR_TOOL_AGENT_GROUPS`.
- **Its own gateway identity:** it calls Google through OneCLI as `CALENDAR_TOOL_GATEWAY_AGENT`. That
  identity holds no stored secrets, has exactly one app connection, and a policy that allows only POST to
  that calendar's events. The agents' own gateway identities keep Calendar writes blocked, so the tool can't
  be bypassed.
- **Bounds:** events last at most 14 days, can't start in the past, and start at most a year ahead. Text
  lengths are capped, with at most 5 reminders. For all-day events, `--end` is the last day, inclusive.
  Events are tagged `createdBy: nanoclaw-calendar-tool`.
- **Rate limit:** the gateway allows at most `CALENDAR_TOOL_RATE_LIMIT_PER_HOUR` (default 20) event
  creations an hour, enforced outside the agent.
- **Works under `cli_scope=group`:** the command names no CLI resource, so the group-scope whitelist doesn't
  hide it. Access is gated by `CALENDAR_TOOL_AGENT_GROUPS` instead.

**Keep the calendar private.** Titles, descriptions and locations are written by the agent, and may be
shaped by content it read (an email, a web page). If the calendar is shared with anyone, or published
through a public or secret iCal link, the tool becomes a way to show that text to them. Use a dedicated
calendar that is shared with no one.

Requires the OneCLI gateway (`/add-onecli`) and a Google Calendar connection in it. The gateway setup in
step 4 uses OneCLI 1.42's REST API. OneCLI 1.43+ removes the agent secret-assignment API it relies on, so
re-check step 4 before upgrading OneCLI past that pin.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the tool, its command and tests

```
.claude/skills/add-calendar-tool/resources/calendar-tool.ts                  → src/calendar-tool.ts
.claude/skills/add-calendar-tool/resources/calendar-tool.test.ts             → src/calendar-tool.test.ts
.claude/skills/add-calendar-tool/resources/calendar-tool-skill-sync.test.ts  → src/calendar-tool-skill-sync.test.ts
.claude/skills/add-calendar-tool/resources/calendar.ts                       → src/cli/resources/calendar.ts
.claude/skills/add-calendar-tool/resources/calendar-registration.test.ts     → src/cli/resources/calendar-registration.test.ts
.claude/skills/add-calendar-tool/resources/calendar-group-scope.test.ts      → src/cli/resources/calendar-group-scope.test.ts
```

```bash
R=.claude/skills/add-calendar-tool/resources
cp $R/calendar-tool.ts $R/calendar-tool.test.ts $R/calendar-tool-skill-sync.test.ts src/
cp $R/calendar.ts $R/calendar-registration.test.ts $R/calendar-group-scope.test.ts src/cli/resources/
```

- `calendar-registration.test.ts` guards the integration point in step 2. It imports the real command
  barrel and drives `calendar-create-event` through the registry as dispatch does, with a stand-in
  `onecli` binary as the only fake. Remove the barrel line and it goes red.
- `calendar-group-scope.test.ts` drives the command through the real dispatch and guard as a
  `cli_scope=group` agent against a test database, so a change that hides or breaks it for group-scoped
  agents goes red.
- `calendar-tool-skill-sync.test.ts` fails if a file in `src/` and its copy in `resources/` differ, so an
  edit made on one side only can't be lost on the next rebuild.
- `calendar-tool.test.ts` unit-tests the tool's own rules: refusing guests, bounds, and the exact gateway call.

### 2. Register the command

Append this line to `src/cli/resources/index.ts`, after the last `import`, unless it is already there:

```typescript
import './calendar.js';
```

### 3. Choose the calendar and add the settings

Create a dedicated calendar for the agent in Google Calendar, so everything it adds is easy to find, hide
or delete. Then copy its **Calendar ID** from its settings ("Integrate calendar"); it ends in
`@group.calendar.google.com`.

Find the gateway connection id for the Google account that owns that calendar:

```bash
curl -s "$(grep ^ONECLI_URL= .env | cut -d= -f2-)/api/connections" | node -e 'for (const c of JSON.parse(require("fs").readFileSync(0))) if (c.provider === "google-calendar") console.log(c.id, c.label)'
```

Find the agent group id(s) that may use the tool with `ncl groups list`.

Add to `.env`, replacing the placeholders. Set each key once, and change existing values rather than
adding duplicates:

```
CALENDAR_TOOL_CALENDAR_ID=<calendar id>@group.calendar.google.com
CALENDAR_TOOL_CONNECTION_ID=<google-calendar connection id>
CALENDAR_TOOL_GATEWAY_AGENT=calendar-event-tool
CALENDAR_TOOL_AGENT_GROUPS=<agent group id>[,<another>]
# optional, default 20
CALENDAR_TOOL_RATE_LIMIT_PER_HOUR=20
```

### 4. Configure the gateway

```bash
node .claude/skills/add-calendar-tool/setup-gateway.mjs
```

This creates the `calendar-event-tool` gateway agent if needed, makes it selective with no stored secrets,
assigns it only `CALENDAR_TOOL_CONNECTION_ID`, and publishes its two rules: allow POST to the calendar's
events (rate-limited), block everything else. It never changes other agents' rules. Re-run it after changing
the calendar, connection or rate limit in `.env`.

Publishing makes the gateway's whole policy draft live, so the script stops if the draft holds unpublished
edits to other rules (for example half-finished work in the OneCLI dashboard). Publish or discard those
first, or re-run with `--force` to publish them as well.

### 5. Build and test

```bash
pnpm run build
pnpm exec vitest run src/calendar-tool.test.ts src/calendar-tool-skill-sync.test.ts \
  src/cli/resources/calendar-registration.test.ts src/cli/resources/calendar-group-scope.test.ts
```

### 6. Mark the install reviewed and restart

The host refuses to start on a checkout it has not recorded. Once the build and tests pass, and the
operator has reviewed the change, stamp the checkout and restart:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

### 7. Try it

```bash
ncl calendar create-event --title "Calendar tool check" --start <tomorrow>T09:00 --end <tomorrow>T09:15
```

The event appears on the chosen calendar; delete it afterwards. Then tell the agent the tool exists, for
example in its memory or instructions:

> Create calendar events with `ncl calendar create-event --title … --start 2026-10-20T15:00 [--end …]
> [--all-day] [--location …] [--description …] [--reminders 60,1440]`. For an all-day event, `--start` and
> `--end` are dates and `--end` is the last day, inclusive. It writes to one calendar and can't
> add guests or send invitations. It is the only way to add events: never ask the operator to loosen the
> gateway's Calendar rules. If the tool fails, report the error, and offer a Google Calendar add link
> (`https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=…&location=…&details=…`) the
> operator can open and save themselves.

Until the tool is installed, give the agent only the last instruction: offer the add link, and never ask
for Calendar write rules to be loosened.

## Troubleshooting

- **"The calendar tool is not configured":** one of the four `CALENDAR_TOOL_*` keys is missing from `.env`.
- **"This agent group is not allowed":** add its id to `CALENDAR_TOOL_AGENT_GROUPS`.
- **HTTP 401 from the calendar:** the gateway agent isn't getting the Google credential. Re-run step 4,
  and check that `CALENDAR_TOOL_CONNECTION_ID` is a `google-calendar` connection.
- **HTTP 403 `blocked_by_policy`:** the calendar id in `.env` and in the published rule differ. Re-run step 4.
- **HTTP 404:** the calendar id is wrong, or the connected Google account can't write to that calendar.
- **HTTP 429 or a rate-limit block:** more than `CALENDAR_TOOL_RATE_LIMIT_PER_HOUR` events in the last hour.
- **"unpublished changes to other rules" from step 4:** see step 4; publish or discard the dashboard edits.
- **`calendar-tool-skill-sync.test.ts` fails:** a file in `src/` and its copy in `resources/` differ. Make
  the same edit on both sides; `resources/` is the canonical copy.
