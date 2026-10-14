# Life companion template

An agent that keeps a second-brain Obsidian vault, TickTick priorities and a
read-only view of Gmail, and reports in one Discord digest. The rules it follows
are in `ai.nanoco.nanoclaw/context/instructions.md`; this file is for the
operator setting it up.

The instructions are the soft layer: an agent tricked by an email could in
principle rewrite its own memory. Everything that must hold is enforced on the
host instead, by the settings below.

## What is enforced where

| Rule | Enforced by |
| --- | --- |
| Only Greg can talk to it | Wiring with `sender_scope: known` on a messaging group with `unknown_sender_policy: strict` |
| It sees only the vault | Mount allowlist (`host/mount-allowlist.json`) with one read-write root |
| No credentials in the container | The credential gateway injects tokens at request time |
| No internet except through the gateway | `NANOCLAW_EGRESS_LOCKDOWN=true` (`host/governance.env`) |
| Gmail is read-only | A `gmail.readonly` token, enforced by Google |
| TickTick writes need approval | A gateway rule holding writes to `api.ticktick.com`; reads skip the card through `NANOCLAW_GATEWAY_READ_ONLY_HOSTS` |
| Vault changes can be undone | `host/vault-sync.sh` commits and pushes on the host and never force-pushes |
| It cannot add tools or packages | Self-modification always needs an admin approval card |
| It cannot run admin commands | `cli_scope: group` (the default) |
| It runs on schedule | The four tasks in `ai.nanoco.nanoclaw/tasks/`, created paused |

## Schedules

Times are in the agent group's timezone; set it with
`ncl groups config update --id <group-id> --timezone <IANA name>`.

| Task | When |
| --- | --- |
| `morning-digest-weekday` | 6:00 Monday to Friday |
| `morning-digest-weekend` | 8:00 Saturday and Sunday |
| `evening-sweep` | 21:00 every day |
| `weekly-review` | 8:30 Sunday |

## Setup

Run these on the NanoClaw host, as the NanoClaw user, from the checkout.

1. **Governance settings.** Append `host/governance.env` to `.env`, then
   restart the service.
2. **Vault.** Clone the private vault repo to `~/vault/second-brain` with a
   deploy key that can write to that repo only. Install the mount allowlist:

   ```bash
   pnpm exec tsx setup/index.ts --step mounts --force -- --json "$(cat templates/life-companion/host/mount-allowlist.json)"
   ```

3. **Vault sync.** Install the timer so the host commits and pushes every five
   minutes:

   ```bash
   mkdir -p ~/.config/systemd/user
   cp templates/life-companion/host/vault-sync.{service,timer} ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now vault-sync.timer
   ```

4. **Stamp the agent and give it the vault.**

   ```bash
   ncl groups create --template life-companion
   ncl groups config add-mount --id <group-id> --host ~/vault/second-brain --container vault
   ncl groups config update --id <group-id> --timezone <IANA name>
   ```

5. **Wire Discord.** Add the Discord channel with `/add-discord` if it is not
   installed, then wire the private `#companion` channel to this group with
   `/manage-channels`. Choose a separate agent (not shared), set the messaging
   group's `unknown_sender_policy` to `strict`, and the wiring's `sender_scope`
   to `known`. Make Greg the owner.
6. **Credentials.** Add the TickTick and Gmail tokens to the gateway, scoped to
   this agent only, and add a rule that holds writes to `api.ticktick.com` for
   approval. The exact commands depend on the gateway; see its install skill
   (`/add-onecli`).
7. **Tools.** Wire the TickTick and Gmail MCP servers. See "Open items".
8. **Start.** Resume the four tasks with `ncl tasks resume`, send a test
   capture in `#companion`, and run one digest by hand with `ncl tasks run`.

## Open items

- The TickTick and Gmail tools were first written as Python servers that hold
  their own tokens on the host. NanoClaw's own pattern is different: the tool
  runs in the container and the gateway injects the token, and egress lockdown
  blocks containers from reaching host-run servers anyway. The tools need
  porting to that pattern before step 7.
- Gmail tokens expire hourly. Check whether the gateway can refresh a Google
  OAuth token before relying on it for Gmail.
