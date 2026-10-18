---
name: patch-discord-approval-buttons
description: Patch the Chat SDK bridge so a button click on a Discord approval card resolves to the option that was pressed. Use when every approval on Discord comes back as rejected, or a card's footer reads like "0 by <name>" instead of "Approved by <name>".
---

# Patch: Discord approval buttons

The bridge builds each card button with an id (`ncq:<card>:<index>`) and a value (`<index>`). The Discord
Gateway delivers the click with both joined by a newline, as `ncq:<card>:0\n0`. The bridge decodes the
option as `0\n0`, cannot map it to an option, and passes the raw string on. The approval system treats
anything other than exactly `approve` as a rejection. So on Discord every approval card resolves as
rejected, whichever button was pressed: agent-to-agent message holds, self-modification requests and
gateway approvals alike. The card's footer then shows the raw string over two lines: `0`, then `0 by <name>`.

This patch changes one line in the bridge so only the part before the newline is decoded.

## When this patch is no longer needed

Upstream NanoClaw tracks the bug as issue #3456, with fixes proposed in PRs #4117 and #3458.
Once upstream's `resolveSelectedOption` in `src/channels/chat-sdk-bridge.ts` handles the newline itself
(the regression test below passes without this patch's line), follow `REMOVE.md`. An `/update-nanoclaw`
that brings that fix in shows one small conflict on this line; take upstream's version.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the regression test

```
.claude/skills/patch-discord-approval-buttons/resources/discord-approval-buttons.test.ts → src/channels/discord-approval-buttons.test.ts
```

```bash
cp .claude/skills/patch-discord-approval-buttons/resources/discord-approval-buttons.test.ts src/channels/
```

The test sends real Gateway clicks (`ncq:approval-card:0\n0` and `...:1\n1`) through the bridge's local
webhook, with only the network faked. It expects `approve` and `reject` and the matching card footer.
Without step 2 it goes red.

### 2. Patch the option decode

This is the skill's one integration point. In `src/channels/chat-sdk-bridge.ts`, in
`resolveSelectedOption`, replace the line

```typescript
  const candidate = eventValue ?? tail ?? '';
```

with

```typescript
  // Discord joins custom_id and value as "<index>\n<index>": patch-discord-approval-buttons skill.
  const candidate = (eventValue ?? tail ?? '').split('\n')[0];
```

If the replacement is already present, leave it as it is.

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/channels/discord-approval-buttons.test.ts src/channels/chat-sdk-bridge.test.ts
```

### 4. Mark the install reviewed and restart

The host refuses to start on a checkout it has not recorded. Once the build and tests pass, and the
operator has reviewed the change, stamp the checkout and restart:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Then trigger any approval card on Discord and press Approve. The card's footer should read
`✅ Approved by <name>`, and the held action should go ahead.

## Troubleshooting

- **Footer still shows a bare number:** the card's option list could not be found (`pending_approvals`
  row gone or without a title). That is a different fault; check `logs/nanoclaw.log` for the card id.
- **Host won't start after the patch:** the upgrade tripwire; run step 4's stamp after reviewing the change.
