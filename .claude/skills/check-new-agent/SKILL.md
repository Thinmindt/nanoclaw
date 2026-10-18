---
name: check-new-agent
description: Check a freshly stamped NanoClaw agent group before its first contact. Covers the three things every new agent on this install must have right whatever template it came from: an explicit `group` CLI scope (never `global`), a gateway identity holding the model credential only, and a probe showing the gateway's dashboard API does not answer from the agents' egress network. Use after `ncl groups create` for any agent, before wiring its channel, and again after a restamp or a gateway change. Does not cover mounts, destinations, or model choice; the agent's own install skill does those.
---

# Check a new agent

Three checks, run from the NanoClaw project root with the new group's id. Each is safe to re-run.
The agent's own install skill (`/add-project-manager` and the like) sets the model, mounts, and
destinations; this skill is what every agent needs regardless of template.

### 1. CLI scope is `group`, explicitly

```bash
ncl groups config update --id <group-id> --cli-scope group
ncl groups config get --id <group-id>
```

`cli_scope` must read `group`: the agent then sees only its own group, sessions, destinations,
members, and tasks through `ncl`, and cannot read or run tasks for any other agent. A stamped
group gets `group` by default; setting it explicitly makes a later change show up as a diff.
Never give an agent `global` without the owner's word. The setup wizard gives the
install's first agent `global`, so check every agent the new one shares destinations with the
same way and move it to `group` unless the owner wants otherwise.

### 2. The gateway identity holds the model credential only

Open the installed gateway's console and find the identity the new group uses. It needs the
model credential and nothing else: no Google connection, no other secret. An identity with more
than the agent's job needs is a way out for anything the agent reads.

### 3. The dashboard port does not answer from the agents' network

Every agent container sits on the one egress network (`nanoclaw-egress` unless
`NANOCLAW_EGRESS_NETWORK` says otherwise), with the gateway attached as `host.docker.internal`.
Whatever that network can reach, every agent can reach. With OneCLI, the gateway's dashboard API
(port 10254) must not answer from that network, only the proxy port the agents use. Probe from
the agents' own vantage point:

```bash
docker run --rm --network "${NANOCLAW_EGRESS_NETWORK:-nanoclaw-egress}" curlimages/curl \
  -s -o /dev/null -m 5 -w '%{http_code}\n' http://host.docker.internal:10254/v1/health
```

This must fail to connect or time out (`000`), not print `200`. If it prints `200`, the dashboard
API is open to every agent; fix that at the network (a rule keyed on the egress network's bridge,
which then covers every present and future agent container) before first contact. A rule keyed on
one container's address covers only that container.

## Removing

This skill is instructions only; delete `.claude/skills/check-new-agent/` and nothing else changes.
