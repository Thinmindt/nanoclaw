---
name: patch-discord-attachments
description: Patch the Chat SDK bridge so attachments that arrive as a URL only (Discord) are downloaded and reach the agent with their content. Use when files sent to an agent over Discord arrive as a name with no data.
---

# Patch: Discord attachments

The Discord adapter gives each attachment a public CDN `url` and no `fetchData()`. The Chat SDK bridge
downloads attachments only through `fetchData()`, so a file sent to an agent over Discord reaches it as
a name and size with no content.

This patch adds a skill-owned helper that downloads URL-only attachments on the host, and one small block in
the bridge that calls it when `fetchData()` is absent.

**What the helper allows:** https only, Discord's CDN hosts only (`cdn.discordapp.com`,
`media.discordapp.net`), 25 MB maximum, and at most 3 redirects, each re-checked against the same rules
before it is requested. Any other attachment still reaches the agent as metadata, with a warning in the log.
The download runs on the host, outside the agent sandbox and its credential gateway, so this host check is
the boundary.

## When this patch is no longer needed

`@chat-adapter/discord` 4.33.0 and later give each attachment its own `fetchData()`, so the bridge's
existing path downloads it and the block added here never runs. Once `package.json` pins
`@chat-adapter/discord` at 4.33.0 or later, follow `REMOVE.md`. Note that the adapter's own download allows
any public https host, while this helper allows only Discord's CDN hosts.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the helper and its tests

```
.claude/skills/patch-discord-attachments/resources/attachment-url-download.ts              → src/channels/attachment-url-download.ts
.claude/skills/patch-discord-attachments/resources/attachment-url-download.test.ts         → src/channels/attachment-url-download.test.ts
.claude/skills/patch-discord-attachments/resources/attachment-url-download-wiring.test.ts  → src/channels/attachment-url-download-wiring.test.ts
```

```bash
cp .claude/skills/patch-discord-attachments/resources/attachment-url-download*.ts src/channels/
```

- `attachment-url-download-wiring.test.ts` guards the integration point in step 2. It drives a Discord-style
  message (URL, no `fetchData`) through the real bridge with only the network faked, and asserts the
  content arrives. Delete or misplace the block in step 2 and this test goes red.
- `attachment-url-download.test.ts` unit-tests the helper's own rules: hosts, http, size, redirects.

### 2. Wire the helper into the bridge

This is the skill's one integration point. In `src/channels/chat-sdk-bridge.ts`, inside `messageToInbound`,
find the attachment loop's `if (att.fetchData) { ... }` block, which ends just before `enriched.push(entry);`.
Extend it with this `else` branch, so the block reads:

```typescript
        if (att.fetchData) {
          try {
            const buffer = await att.fetchData();
            entry.data = buffer.toString('base64');
          } catch (err) {
            log.warn('Failed to download attachment', { type: att.type, err });
          }
        } else {
          // URL-only attachments (Discord): patch-discord-attachments skill.
          const { downloadAttachmentByUrl } = await import('./attachment-url-download.js');
          const data = await downloadAttachmentByUrl(att);
          if (data) entry.data = data;
        }
        enriched.push(entry);
```

If the `else` branch with the `downloadAttachmentByUrl` call is already present, leave it as it is.

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/channels/attachment-url-download.test.ts src/channels/attachment-url-download-wiring.test.ts
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

Then send the agent a small file over Discord. It should be able to open it.

## Troubleshooting

- **Agent still sees no content:** check `logs/nanoclaw.log` for "Attachment has no download path" (the URL
  isn't on a Discord CDN host) or "Failed to download attachment" (network error, HTTP error, oversized
  file, or a redirect off the allowlist).
- **Host won't start after the patch:** the upgrade tripwire; run step 4's stamp after reviewing the change.
