# Remove: mirror refresh

Every step is safe to re-run. The mirrors, their `.gitleaksignore` files, and the README lines stay;
delete the `last-refresh:` lines by hand if you want them gone.

## 1. Stop and remove the timer

```bash
systemctl --user disable --now nanoclaw-mirror-refresh.timer
rm -f ~/.config/systemd/user/nanoclaw-mirror-refresh.service ~/.config/systemd/user/nanoclaw-mirror-refresh.timer
systemctl --user daemon-reload
```

## 2. Restore or remove the script

If step 3 of the install kept a backup, restore it; otherwise remove the script:

```bash
ls ~/bin/refresh-mirrors.sh.bak-* 2>/dev/null
# cp -p ~/bin/refresh-mirrors.sh.bak-<date> ~/bin/refresh-mirrors.sh
# or: rm -f ~/bin/refresh-mirrors.sh
```

## 3. Remove the copied files

```bash
rm -rf scripts/mirrors
```
