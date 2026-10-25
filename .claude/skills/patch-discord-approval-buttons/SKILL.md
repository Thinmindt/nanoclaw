---
name: patch-discord-approval-buttons
description: Patch the Chat SDK bridge so a click on a Discord approval or question card resolves to the button pressed. Use when every Discord approval resolves as a reject and the card footer reads like "0", newline, "0 by <user>" instead of "✅ Approved by <user>".
---

# Patch: Discord approval buttons

Approval and question cards are built with one button per option, each carrying an id
(`ncq:<questionId>:<index>`) and a value (the same index). The Discord adapter encodes a button's
custom_id as `<id>\n<value>`, so a click arrives through the Gateway as `ncq:<questionId>:0\n0`. The
bridge reads everything after `ncq:<questionId>:` as the option index, gets `0\n0`, which is not an index,
and passes it on as the selected option. The approval response handler treats anything but exactly
`approve` as a reject, so **every Approve click is recorded as a reject**, and the card footer shows the raw
`0\n0 by <user>`.

The fix reads the index from before the newline. A custom_id without the suffix is unchanged.

The card's stored render is not involved: the approval row, its title and its options are found; only the
index was misread.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the test

```
.claude/skills/patch-discord-approval-buttons/resources/discord-approval-button.test.ts → src/channels/discord-approval-button.test.ts
```

```bash
cp .claude/skills/patch-discord-approval-buttons/resources/discord-approval-button.test.ts src/channels/
```

It drives the real bridge's Gateway webhook with a real `pending_approvals` row in a test database: a click
arriving as `ncq:<id>:0\n0` must resolve to `approve` with the footer `✅ Approved by <user>`, `…:1\n1`
to `reject`, and a custom_id without the suffix still to `approve`. It goes red when the edit in step 2 is
removed.

### 2. Read the index from before the newline

This is the skill's one integration point. In `src/channels/chat-sdk-bridge.ts`, in the
`GATEWAY_INTERACTION_CREATE` branch, find where the option tail is cut from the custom_id:

```typescript
          questionId = customId.slice(4, colonIdx);
          tail = customId.slice(colonIdx + 1);
```

and change the second line so it reads:

```typescript
          questionId = customId.slice(4, colonIdx);
          // patch-discord-approval-buttons skill: the Discord adapter encodes custom_id as `<id>\n<value>`.
          tail = customId.slice(colonIdx + 1).split('\n')[0];
```

If the line already ends in `.split('\n')[0]`, leave it.

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/channels/discord-approval-button.test.ts src/channels/chat-sdk-bridge.test.ts
```

### 4. Mark the install reviewed and restart

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Then trigger a real approval card (for example an agent-to-agent message under `ncl policies set`) and
press Approve: the card's footer reads `✅ Approved by <user>`, and the log line is `Approval handled`
(with the action in its fields) rather than `Approval rejected`.

## When to remove

Upstream tracks this as nanocoai/nanoclaw#3456. Once the update you take reads the index from before the
newline itself, or stops putting the value on the button, this patch is redundant: run `REMOVE.md` and drop
it from the recipe. The test in step 1 will still pass after removal if upstream's fix is in place, which
is the signal.

## Troubleshooting

- **Clicks still record as reject:** check the log for `Approval rejected` right after an Approve tap, and
  the card footer. A footer of `0` and `0 by <user>` means step 2 is missing; rebuild and restart.
- **The host won't start after the patch:** the upgrade tripwire; run step 4's stamp after reviewing.
