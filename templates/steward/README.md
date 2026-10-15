# Steward template

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
| Only the owner can talk to it | Wiring with `sender_scope: known` on a messaging group with `unknown_sender_policy: strict` |
| It sees only the vault | Mount allowlist (`host/mount-allowlist.json`) with one read-write root |
| No credentials in the container | The credential gateway injects tokens at request time |
| No internet except through the gateway | `NANOCLAW_EGRESS_LOCKDOWN=true` (`host/governance.env`) |
| Gmail is read-only | A `gmail.readonly` grant, enforced by Google, plus a gateway rule blocking every method but GET to `gmail.googleapis.com` |
| TickTick writes need approval | A gateway rule holding writes to `api.ticktick.com`; reads skip the card through `NANOCLAW_GATEWAY_READ_ONLY_HOSTS` |
| TickTick tasks are never deleted or completed | A gateway rule blocking DELETE and `.../complete` on `api.ticktick.com` |
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
   pnpm exec tsx setup/index.ts --step mounts --force -- --json "$(cat templates/steward/host/mount-allowlist.json)"
   ```

3. **Vault sync.** Install the timer so the host commits and pushes every five
   minutes:

   ```bash
   mkdir -p ~/.config/systemd/user
   cp templates/steward/host/vault-sync.{service,timer} ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now vault-sync.timer
   ```

4. **Stamp the agent and give it the vault.**

   ```bash
   ncl groups create --template steward
   ncl groups config add-mount --id <group-id> --host ~/vault/second-brain --container vault
   ncl groups config update --id <group-id> --timezone <IANA name>
   ```

5. **Wire Discord.** Add the Discord channel with `/add-discord` if it is not
   installed, then wire the private `#steward` channel to this group with
   `/manage-channels`. Choose a separate agent (not shared), set the messaging
   group's `unknown_sender_policy` to `strict`, and the wiring's `sender_scope`
   to `known`. Make yourself the owner.
6. **Credentials.** In the gateway, connect TickTick (OAuth app with scopes
   `tasks:read tasks:write`) and Gmail (scope `gmail.readonly` only), each
   scoped to `api.ticktick.com` or `gmail.googleapis.com`, injected as the
   `Authorization` header, and granted to this agent only. Then add the rules
   from the table above: block non-GET to Gmail, block DELETE and complete on
   TickTick, and hold other TickTick writes for approval. The exact commands
   depend on the gateway; see its install skill (`/add-onecli`).
7. **Tools.** Nothing to do: `mcp.json` starts the TickTick and Gmail servers
   in `servers/` with the container's own Bun when the agent starts.
8. **Start.** Resume the four tasks with `ncl tasks resume`, send a test
   capture in `#steward`, and run one digest by hand with `ncl tasks run`.

## Tools

`servers/ticktick.ts` and `servers/gmail.ts` are small MCP servers with no
dependencies. They run inside the agent's container and send every request
with `Authorization: Bearer placeholder` through the gateway's proxy
(`HTTPS_PROXY` and the gateway CA, which NanoClaw puts in the container's
environment). The gateway swaps in the real token, so no token is ever in the
container.

| Server | Tools |
| --- | --- |
| `ticktick` | `list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`; `complete_task` only with `TICKTICK_ALLOW_COMPLETE=1` in `mcp.json`. No delete. |
| `gmail` | `search_mail`, `read_message`, `read_thread`. GET only; email bodies come back marked as untrusted. |

The limits in the servers keep the agent on the right path, but they are not
the fence: the agent also has a shell and could call either API directly
through the same proxy. The gateway rules in step 6 are what hold.

Tests run with Bun and use fake APIs:

```bash
cd templates/steward/servers && bun test
```

## Open items

- The servers have only been tested against fake APIs. The TickTick endpoints
  and date format were written from the public Open API docs and need one real
  run.
- Gmail tokens expire hourly. Check that the gateway refreshes the Google OAuth
  token before relying on it for the digest.
