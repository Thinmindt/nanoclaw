---
name: add-config-snapshot
description: Write a dated, secret-free snapshot of the live config that decides who can reach whom (agent-to-agent policies, wirings, destinations, mounts, the mount allowlist, the gateway's agents and published rules) to an exports folder every hour with a systemd user timer, refusing any snapshot that holds an unlisted key or a credential-shaped value. Use when an agent that plans the project (the Project Manager) should read the live setup without being given CLI access to change it.
---

# Add config snapshot

A Project Manager agent's CLI is scoped to its own group, so it cannot read the live config that
decides who can reach whom, and widening that scope would let it change the config. This skill
gives it a read-only copy instead: once an hour a host script writes the config to a folder the
agent already reads.

- **What it holds:** the agent groups; agent-to-agent policies (from, to, approver); every wiring
  with all its columns; each messaging group's `unknown_sender_policy`; destinations; each group's
  additional mounts and `cli_scope`; the mount allowlist's roots with their read-write flag, decided
  the way the host decides it (`allowReadWrite`, else not `readOnly`, else read-only); the env
  flags that decide which groups may use a host tool (`CALENDAR_TOOL_AGENT_GROUPS`,
  `GITHUB_STATUS_AGENT_GROUPS`, `PLAYGROUND_AGENT_GROUPS`, each a list of group ids); the gateway's
  agents (id, identifier, name, and the ids of the secrets and connections each holds);
  and the gateway's published rules exactly as its list endpoint returns them.
- **What it reads:** the central DB, opened read-only; the mount allowlist; the gateway's agent
  list, each agent's secret and connection ids, and its published rule list; the add-onecli skill's
  `versions.json` for the gateway pin; and the env file through `readEnvFile`, which parses the whole
  file but returns only those three flags, so the gateway key it also holds is never returned to,
  kept or written by the script. Never the gateway's secrets or connections lists, never
  `container_configs.mcp_servers` (its headers are free-form). Secret and connection names live
  only in those lists, so the snapshot carries ids.
- **The check, on every write:** every key must be on the allow-list in `snapshot.ts`
  (`ALLOWED_KEYS`), and no value may match the repo's credential detector (`looksLikeCredential`,
  `src/drivers/types.ts`). Either failure refuses the whole snapshot and writes nothing; the error
  names the key path, never the value. A field picked by name that its source no longer returns, or
  a gateway answer other than 2xx, fails the run the same way.
- **The files:** `<out>/<UTC date>.json` and `<out>/latest.json`, each written to a temporary file
  and renamed into place, so a refused or failed run leaves the last good copy. The first line
  carries the write time and the gateway pin: `{"written":"<ISO time>","gatewayPin":"1.42.0",`.
  The file is JSON throughout.
- **Schedule:** its own systemd user timer, hourly at :40 like the mirror refresh. It is not chained
  to the refresh, which exits non-zero on a secret-scan hit and would stop the snapshot with it.

The script runs from the built host (`dist/`), so the install's build must include it. Nothing in
the running host process changes, so applying this needs no service restart.

Requires: systemd with user lingering on for the account that runs NanoClaw (its own user units
already need it), and a folder the reading agent has mounted. The service writes to
`~/exports/nanoclaw-config` and reads the gateway at `http://172.17.0.1:10254`; change both in the
service unit for another layout.

## Steps

Run every step from the NanoClaw project root, as the account that runs NanoClaw. Each step is safe
to re-run.

### 1. Copy the script and tests, test and build

```bash
mkdir -p src/config-snapshot
cp -p .claude/skills/add-config-snapshot/resources/*.ts src/config-snapshot/
pnpm exec vitest run src/config-snapshot
pnpm run build
```

- `snapshot.test.ts` drives the real script against a migrated scratch DB and a stand-in gateway: a
  full write (an env file with a planted gateway key that must not appear), the rename, the
  read-only DB open, the allowlist flags agreeing with the host's own loader, and a failed run
  (unknown key, credential-shaped value, missing field, gateway error) leaving the last good copy.
- `skill-sync.test.ts` fails if a file in `src/config-snapshot/` and its copy in `resources/` differ.
  `resources/` is the canonical copy.

### 2. Install and start the timer

```bash
mkdir -p ~/exports/nanoclaw-config
install -D -m 644 -t ~/.config/systemd/user \
  .claude/skills/add-config-snapshot/resources/nanoclaw-config-snapshot.service \
  .claude/skills/add-config-snapshot/resources/nanoclaw-config-snapshot.timer
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-config-snapshot.timer
```

### 3. Run it once and check

```bash
systemctl --user start nanoclaw-config-snapshot.service
journalctl --user -u nanoclaw-config-snapshot.service -n 20 --no-pager
head -c 80 ~/exports/nanoclaw-config/latest.json; echo
systemctl --user list-timers nanoclaw-config-snapshot.timer
```

The journal shows `config snapshot written: <path>`, the first line of `latest.json` shows this
run's time and the gateway pin, and the timer lists its next run at :40.

Optionally, tell the agent that reads it, for example in its memory:

> The live config (who can reach whom) is `nanoclaw-config/latest.json` in exports, refreshed hourly;
> its first line says when. If it is more than a few hours old, the snapshot is being refused: say so.

## Tuning

The cadence is a default. To change it, override the timer and reload:

```bash
systemctl --user edit nanoclaw-config-snapshot.timer
# [Timer]
# OnCalendar=
# OnCalendar=*-*-* 00/4:40:00
```

## Troubleshooting

- **"snapshot refused, nothing written: unknown key …":** a migration added a column or a new gateway
  version returns a new field. Look at what the field holds; if it is safe for the reading agent,
  add its path to `ALLOWED_KEYS` in both `resources/snapshot.ts` and `src/config-snapshot/snapshot.ts`,
  then build. Moving the gateway past the pinned version is the likeliest cause.
- **"missing field …":** a gateway past the pinned version, or a changed allowlist format, no longer
  returns a field the snapshot picks by name. Read the new shape and update the pick in both copies.
- **"GET … → HTTP 5xx":** the gateway answered but failed. Read `docker logs onecli`; the next hourly
  run retries.
- **"GET … → HTTP 401" or "404":** the gateway no longer serves that call the way the pinned version
  did (a moved endpoint, or auth now required). Compare the running image with
  `.claude/skills/add-onecli/versions.json` and update the call in both copies of `snapshot.ts`.
- **"fetch failed":** the gateway is down or not at the URL in the service unit. Check `docker ps`
  and the unit's URL.
- **"credential-shaped value at …":** a value at that path looks like a token. Find and remove it at
  its source; do not widen the check.
- **`systemctl --user` fails with "Failed to connect to bus":** the shell has no user session. Log in
  as the user, or set `XDG_RUNTIME_DIR=/run/user/$(id -u)`.
- **`skill-sync.test.ts` fails:** make the same edit on both sides; `resources/` is the canonical copy.
