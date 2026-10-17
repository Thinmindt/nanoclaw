# Remove: Discord attachments patch

Every step is safe to re-run.

## 1. Remove the bridge block

In `src/channels/chat-sdk-bridge.ts`, inside the attachment loop of `messageToInbound`, delete the whole
`else { ... }` branch that follows `if (att.fetchData) { ... }`. That's the five lines from
`} else {` through the `if (data) entry.data = data;` line, with its comment. Keep the closing `}` of the
`if (att.fetchData)` block, so it reads:

```typescript
        if (att.fetchData) {
          try {
            const buffer = await att.fetchData();
            entry.data = buffer.toString('base64');
          } catch (err) {
            log.warn('Failed to download attachment', { type: att.type, err });
          }
        }
        enriched.push(entry);
```

No-op when the branch is absent.

## 2. Remove the copied files

```bash
rm -f src/channels/attachment-url-download.ts \
      src/channels/attachment-url-download.test.ts \
      src/channels/attachment-url-download-wiring.test.ts
```

## 3. Build, stamp and restart

```bash
pnpm run build
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Files sent over Discord then reach the agent as metadata only.
