---
name: add-architect
description: Add the Architect agent template to this NanoClaw install and stamp an Architect from it. Use when the owner wants an agent that reviews their repositories, plans designs, and gives scope verdicts on the Project Manager's work items through a book-guided expert panel, with no web access of its own and a separate Scout agent for current-source research.
---

# Add Architect

The Architect is a NanoClaw agent that judges code and designs for one person's coding projects:
it reviews a repository and reports gaps and risks, plans a design when asked, and gives a scope
verdict on a work item the Project Manager proposes. It never builds. It reads private
repositories, so it has no web access; the Scout agent (`/add-scout`) does its current-source
research one round at a time, behind the gate `/add-scout-gate` puts on what may cross. The
design it implements is the owner's coding-agents plan, which is kept outside this repository.

The template is derived from the public `engineering/code-architect` template by zvi-fried (MIT).
The template's README lists what changed: the Tech lead's two passes, Scout rounds across turns,
the scope-verdict mode, mirrors as the code source, and the data-not-instructions rule.

This skill ships the agent as a template under `templates/engineering/architect/` and the test
that holds the template to NanoClaw's plugin reader. Stamping, mounts, destinations, and wiring
are operator steps on the host below.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the template and its test

```
.claude/skills/add-architect/payload/templates/engineering/architect/                  → templates/engineering/architect/
.claude/skills/add-architect/payload/src/templates/fork-architect-template.test.ts    → src/templates/fork-architect-template.test.ts
```

```bash
mkdir -p templates/engineering
rm -rf templates/engineering/architect
cp -R .claude/skills/add-architect/payload/templates/engineering/architect templates/engineering/architect
cp .claude/skills/add-architect/payload/src/templates/fork-architect-template.test.ts src/templates/
```

The test loads the template through the real `parseTemplate`, checks the three modes are routed
and every link resolves, checks the contracts parse, and checks the Tech lead is sent to the
Scout rather than to a search tool. It goes red when NanoClaw's plugin reader or skill
frontmatter rules move under the template, or when a web instruction creeps back in.

### 2. Test

```bash
pnpm exec vitest run src/templates/fork-architect-template.test.ts
```

### 3. Stamp the agent

```bash
ncl groups create --template engineering/architect --name "Architect"
```

Note the group id it prints. When an Architect already exists, the same command shows the restamp
plan; add `--yes` to apply it and `ncl groups restart --id <group-id>` afterwards.

### 4. Set the model

```bash
ncl groups config update --id <group-id> --model claude-fable-5-1 --effort high
ncl groups config get --id <group-id>
```

Reviewing a repository through a panel is the heaviest job on the install; the strongest model
at high effort is the default. If that model is not offered on the owner's plan, use
`claude-opus-5-5` at high. Use the same model id family the install's other agents show.

### 5. Mount the repositories

The agent expects one mount, `/workspace/extra/repos/`, holding one read-only mirror per project
(a bare mirror or a plain clone, named as the Project Manager's `projects.md` lists them). The
owner refreshes and scans the mirrors on the host; the Architect sees snapshots. Allow the host
path once, following `/manage-mounts`, read-only, then attach it:

```bash
ncl groups config add-mount --id <group-id> --host <repos path> --container repos --ro
ncl groups restart --id <group-id>
```

No workbench mount: the Architect never sees the Project Manager's working files. No exports.

Then run `/check-new-agent` for this group: CLI scope `group`, a gateway identity with the model
credential only (no web egress rule of any kind), and the dashboard-port probe.

### 6. Add the destinations

The agent addresses the Project Manager as `project-manager` and the Scout as `scout`. Add the
Project Manager pair in both directions once that group exists:

```bash
ncl destinations add --agent-group-id <architect-id> --local-name project-manager --target-type agent --target-id <pm-id>
ncl destinations add --agent-group-id <pm-id>        --local-name architect       --target-type agent --target-id <architect-id>
```

The Scout pair is added by `/add-scout` step 6, after `/add-scout-gate` is applied; the
template addresses the Scout as `scout`, so use that name. `ncl destinations list
--agent-group-id <architect-id>` then shows two rows. Add no other: the agent's only ways out are these two
agents and its channel.

### 7. Wire a channel, optionally

A Discord channel with the owner as the only sender lets the owner ask for a review or a plan
directly and read the report there. Follow `/manage-channels`. The Project Manager's requests
need no channel; they arrive by agent message.

### 8. Mark the install reviewed and restart

The host refuses to start on a checkout it has not recorded. Once the test passes and the operator
has reviewed the change, stamp the checkout and restart:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Then, from the Architect's channel or through the Project Manager, ask for a scope verdict on a
small item. It should answer in one turn in the fixed shape. A review of one repository is the
real test: the first turn ends with "round 1 sent", the Scout answers, and the report follows.

## Updating the agent later

Edit the template under `.claude/skills/add-architect/payload/`, re-run step 1 and step 2, then
restamp: `ncl groups create --template engineering/architect` shows the plan, `--yes` applies it,
and `ncl groups restart --id <group-id>` makes it live. Restamping replaces the persona and skills
and leaves memory, run folders, mounts, destinations, and wiring alone. To pick up a newer
`code-architect` from the public registry, copy its changed files into the payload and re-apply
the fork's edits listed in the template README; the test says when a web instruction came back.

## Troubleshooting

- **"Not an agent plugin"** at stamp time: step 1 did not run from the project root;
  `ls templates/engineering/architect/plugin.json` must exist.
- **The agent says the repository is missing**: the mount in step 5 is not attached, the group
  was not restarted, or the mirror's folder name differs from the one the request used.
- **A run never finishes**: the Scout's answer did not arrive. Check `ncl sessions list` for the
  Scout, and `logs/nanoclaw.log` for an `a2a-gate` refusal; the Architect gets a note on refusal
  and should have rephrased. After three rounds the run finishes with gaps named.
- **The report cites a source with no id**: a verification lapse; ask the Architect to re-check it
  by id in a new round.
