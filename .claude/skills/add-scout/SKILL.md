---
name: add-scout
description: Add the Scout agent template to this NanoClaw install and stamp a Scout from it. Use when an Architect agent (or any agent that reads private code and has no web access) needs a separate research agent that reads the open web for it, holds nothing private, and answers with dated sources by id.
---

# Add Scout

The Scout is the web half of a split: an agent that reads private repositories must not also read
the open web, so the Architect has no web access and asks the Scout instead. The Scout holds no
code, no mounts, and no credentials beyond the model's. It answers numbered research questions
with sources it found itself, confirms books by title against publisher pages, re-checks sources
by id, and keeps a per-run source record. The design it implements is the owner's coding-agents
plan, which is kept outside this repository.

This skill ships the agent as a template under `templates/engineering/scout/` and the test that
holds the template to NanoClaw's plugin reader. Stamping, the gateway identity, and the
destination pair are operator steps on the host below. The gate on the messages it receives is a
separate skill, `/add-scout-gate`, and must be applied before the Architect gets a `scout`
destination.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the template and its test

```
.claude/skills/add-scout/payload/templates/engineering/scout/                 → templates/engineering/scout/
.claude/skills/add-scout/payload/src/templates/fork-scout-template.test.ts   → src/templates/fork-scout-template.test.ts
```

```bash
mkdir -p templates/engineering
rm -rf templates/engineering/scout
cp -R .claude/skills/add-scout/payload/templates/engineering/scout templates/engineering/scout
cp .claude/skills/add-scout/payload/src/templates/fork-scout-template.test.ts src/templates/
```

The test loads the template through the real `parseTemplate`, checks every link inside the skill
resolves, and checks the template declares no MCP server, no task, and no address to open.

### 2. Test

```bash
pnpm exec vitest run src/templates/fork-scout-template.test.ts
```

### 3. Stamp the agent

```bash
ncl groups create --template engineering/scout --name "Scout"
```

Note the group id it prints. When a Scout already exists, the same command shows the restamp
plan; add `--yes` to apply it and `ncl groups restart --id <group-id>` afterwards.

### 4. Set the model

```bash
ncl groups config update --id <group-id> --model claude-sonnet-5-5 --effort medium
ncl groups config get --id <group-id>
```

Research with sources is a reading job; the smaller model is the default. Use the same model id
family the install's other agents show.

### 5. Give it the web, and nothing else

The Scout needs a gateway identity that allows outbound GET to any public host and holds the
model credential only. No mounts: the group gets no `additional_mounts` at all. Then run
`/check-new-agent` for this group: CLI scope `group`, the identity check, and the dashboard-port
probe. The identity check there says "model credential only"; for the Scout that still holds,
with open GET added as the one egress rule.

Two things to confirm in the gateway's console before first contact:

- The identity can reach any public host with GET and HEAD, and nothing else: no POST, PUT,
  or DELETE, so a page cannot turn the Scout into a way to post.
- The identity holds no connection the owner's other agents have (no Google, no calendar, no
  mail). The Scout reads strangers' pages; whatever it holds, those pages can try to use.

### 6. Add the destination pair with the Architect

Apply `/add-scout-gate` first. Then:

```bash
ncl destinations add --agent-group-id <architect-id> --local-name scout     --target-type agent --target-id <scout-id>
ncl destinations add --agent-group-id <scout-id>     --local-name architect --target-type agent --target-id <architect-id>
```

The gate keys on the target, not on these labels: the Scout's group is named `Scout` (step 3),
and `/add-scout-gate` step 4 lists its id in `data/a2a-gate/targets` as well. Add the id there
now that you have it. `ncl destinations list --agent-group-id <scout-id>` shows one row; add no
other. The Scout answers only the Architect.

Then put the owner's tap on both directions. A message policy holds every message on a pair for
the named approver, after the gate has refused what it refuses; the card shows the text, and
nothing is delivered without the tap:

```bash
ncl policies set --from <architect-id> --to <scout-id>     --approver <owner-user-id>
ncl policies set --from <scout-id>     --to <architect-id> --approver <owner-user-id>
```

`<owner-user-id>` is the owner's row in `ncl users list` (`discord:<handle>` or the like). A
held message waits as long as it takes: a run that reaches a round overnight continues after
the morning's taps. Each round costs two taps, and a review runs up to three rounds; that is
the price of seeing every question and every answer, and the owner can remove a policy later
(`ncl policies remove`) if it turns out not to earn it. Answers that pass arrive at the
Architect as plain text under 8000 characters, with the gate's header line on top.

### 7. Wire a channel, optionally

A Discord channel with the owner as the only sender is useful for checking the Scout works
("What changed in Bun 1.2's workspace handling? Cite the changelog.") and is not needed for the
Architect's rounds. Follow `/manage-channels` if you want one.

### 8. Mark the install reviewed and restart

The host refuses to start on a checkout it has not recorded. Once the test passes and the operator
has reviewed the change, stamp the checkout and restart:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

## Updating the agent later

Edit the template under `.claude/skills/add-scout/payload/`, re-run step 1 and step 2, then
restamp: `ncl groups create --template engineering/scout` shows the plan, `--yes` applies it,
and `ncl groups restart --id <group-id>` makes it live. Restamping replaces the persona and
skills and leaves memory, run records, destinations, and wiring alone.

## Troubleshooting

- **"Not an agent plugin"** at stamp time: step 1 did not run from the project root;
  `ls templates/engineering/scout/plugin.json` must exist.
- **The Scout answers "Not found" for everything**: its gateway identity does not allow open
  GET, or search is failing; the answer's first line says which when the Scout can tell.
- **The Architect's question never arrives**: the gate refused it (the Architect gets a note
  saying why), or step 6's pair is missing.
