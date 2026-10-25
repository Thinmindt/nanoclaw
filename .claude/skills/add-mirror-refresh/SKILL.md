---
name: add-mirror-refresh
description: Refresh the coding agents' read-only repository mirrors every hour with a systemd user timer, secret-scan new history before it reaches them, and keep a last-refresh line per mirror in the mirrors README. Use when agents read code from bare mirrors on the host (the Architect, the Project Manager) and should always see current code.
---

# Add mirror refresh

The Architect and the Project Manager read code from bare mirrors under one host folder (default
`~/repos`), mounted read-only. This skill keeps those mirrors current without letting unscanned
history reach an agent:

- **Scan before update:** each mirror with an origin URL is fetched into a scratch copy first. The
  commits that are new since the last refresh are scanned with gitleaks; the mirror is updated only
  when that scan is clean. On a hit, or any failure, the mirror stays as it was.
- **Reviewed false positives:** fingerprints in `<mirror>/.gitleaksignore` are skipped. After
  reviewing a hit, the owner baselines it with `refresh-mirrors.sh --accept <name>`. Only run that
  by hand; the timer never accepts anything.
- **Freshness the agents can see:** after a clean refresh, the mirrors README (`~/repos/README.md`)
  gets one line per mirror, replaced in place, every other line kept:

  ```
  last-refresh: <name> <local time, ISO 8601> <branch>@<short sha>
  ```

  A failed refresh leaves the line as it was, so a stale date is the signal.
- **Push-fed mirrors:** a mirror with no origin URL is fed by the owner's pushes. It is not fetched
  or scanned here; its line shows the time of its newest commit, marked `(push-fed: time of newest
  commit)`.
- **Schedule:** a systemd user timer runs the refresh every hour at :40, so a run finishes shortly
  before an agent's pass on the hour. `Persistent=true` catches up on a run missed while the machine
  was off. Runs never overlap (a second one exits at once).

Nothing in the NanoClaw host process changes, so applying this needs no build or service restart.

Requires: `git`, `flock` (util-linux), gitleaks 8.16 or newer on the host, systemd with user
lingering on for the account that owns the mirrors (the NanoClaw service's user units already need
it), and the mirrors as bare repositories directly under one folder.

## Steps

Run every step from the NanoClaw project root, as the account that owns the mirrors. Each step is
safe to re-run.

### 1. Copy the script, units and tests

```bash
mkdir -p scripts/mirrors
cp -p .claude/skills/add-mirror-refresh/resources/* scripts/mirrors/
pnpm exec vitest run scripts/mirrors
```

- `refresh-mirrors.test.ts` drives the script against throwaway repositories, with a stand-in
  gitleaks as the only fake: a clean refresh, a refused one, `--accept`, a push-fed mirror, and the
  lock.
- `mirror-refresh-skill-sync.test.ts` fails if a file in `scripts/mirrors/` and its copy in
  `resources/` differ. `resources/` is the canonical copy.

### 2. Check the prerequisites

```bash
gitleaks version
loginctl show-user "$USER" -p Linger      # must print Linger=yes
systemctl --user is-system-running        # running or degraded is fine
```

If lingering is off, an admin turns it on with `loginctl enable-linger <user>`; without it the
timer stops when the user's last session ends.

### 3. Install the script

If a refresh script is already installed, compare it first and keep a copy:

```bash
[ -f ~/bin/refresh-mirrors.sh ] && diff ~/bin/refresh-mirrors.sh scripts/mirrors/refresh-mirrors.sh
[ -f ~/bin/refresh-mirrors.sh ] && cp -p ~/bin/refresh-mirrors.sh ~/bin/refresh-mirrors.sh.bak-$(date +%Y%m%d)
```

Stop and ask the owner if the old script does something this one doesn't (another mirrors folder,
other scan rules or flags). Existing `<mirror>/.gitleaksignore` files keep working as they are.

```bash
install -D -m 755 scripts/mirrors/refresh-mirrors.sh ~/bin/refresh-mirrors.sh
```

The script uses `~/repos` unless `MIRRORS_DIR` is set; for another folder, add
`Environment=MIRRORS_DIR=<path>` to the service in step 4.

### 4. Install and start the timer

```bash
install -D -m 644 -t ~/.config/systemd/user \
  scripts/mirrors/nanoclaw-mirror-refresh.service scripts/mirrors/nanoclaw-mirror-refresh.timer
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-mirror-refresh.timer
```

### 5. Run it once and check

```bash
systemctl --user start nanoclaw-mirror-refresh.service
journalctl --user -u nanoclaw-mirror-refresh.service -n 30 --no-pager
grep '^last-refresh:' ~/repos/README.md
systemctl --user list-timers nanoclaw-mirror-refresh.timer
```

Every mirror has a `last-refresh:` line, and the timer lists its next run at :40. A refusal shows in
the journal with the finding's fingerprint; review it, then baseline it with
`~/bin/refresh-mirrors.sh --accept <name>` or deal with the secret upstream.

Optionally, tell the agents that read the mirrors, for example in their memory:

> Each mirror's freshness is the `last-refresh:` line for it in the mirrors README. If a line is
> more than a few hours old, say so in your report: that mirror's last refresh failed.

## Tuning

The cadence is a default. To change it, override the timer and reload:

```bash
systemctl --user edit nanoclaw-mirror-refresh.timer
# [Timer]
# OnCalendar=
# OnCalendar=*-*-* 00/4:40:00
```

## Troubleshooting

- **`systemctl --user` fails with "Failed to connect to bus":** the shell has no user session (for
  example after `su`). Log in as the user, or set `XDG_RUNTIME_DIR=/run/user/$(id -u)`.
- **The timer stops after logout or a restart:** lingering is off; see step 2.
- **"gitleaks found possible secrets":** the mirror was not updated. Read the fingerprint
  (`<commit>:<file>:<rule>:<line>`), look at that commit, and either baseline it with `--accept` or
  get the secret out of the source repository.
- **"gitleaks failed … without a report":** gitleaks itself failed (too old, missing, or crashed);
  run the `gitleaks detect` line from the script by hand to see why.
- **A mirror never gets a line:** it is not a bare repository directly under the mirrors folder.
- **`mirror-refresh-skill-sync.test.ts` fails:** make the same edit on both sides; `resources/` is
  the canonical copy.
