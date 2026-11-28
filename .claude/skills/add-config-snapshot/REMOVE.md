# Remove: config snapshot

Every step is safe to re-run. The snapshots already written stay; delete
`~/exports/nanoclaw-config` by hand if you want them gone.

## 1. Stop and remove the timer

```bash
systemctl --user disable --now nanoclaw-config-snapshot.timer
rm -f ~/.config/systemd/user/nanoclaw-config-snapshot.service ~/.config/systemd/user/nanoclaw-config-snapshot.timer
systemctl --user daemon-reload
```

## 2. Remove the copied files and rebuild

```bash
rm -rf src/config-snapshot dist/config-snapshot
pnpm run build
```
