---
name: add-project-manager
description: Add the Project Manager agent template to this NanoClaw install and stamp a Project Manager agent from it. Use when the owner wants an agent that keeps the plan for their coding projects (workbench docs, work items with acceptance criteria, a fixed-length iteration, an optional form exchange with the owner's Steward agent) without building anything itself.
---

# Add Project Manager

The Project Manager is a NanoClaw agent that keeps the plan for one person's coding projects and
never builds: it owns a private workbench of state and design docs, turns an Architect agent's
findings into agreed work items with acceptance criteria, runs a fixed-length iteration with one
item in progress at a time, and can exchange a fixed form each iteration with the owner's Steward
(life) agent. The design it implements is the owner's "Coding agents: target design" plan.

This skill ships the agent as a template under `templates/engineering/project-manager/` and the
test that holds the template to NanoClaw's plugin reader. Stamping, mounts, destinations, and
wiring are operator steps on the host below.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the template and its test

```
.claude/skills/add-project-manager/payload/templates/engineering/project-manager/        → templates/engineering/project-manager/
.claude/skills/add-project-manager/payload/src/templates/fork-project-manager-template.test.ts → src/templates/fork-project-manager-template.test.ts
```

```bash
mkdir -p templates/engineering
rm -rf templates/engineering/project-manager
cp -R .claude/skills/add-project-manager/payload/templates/engineering/project-manager templates/engineering/project-manager
cp .claude/skills/add-project-manager/payload/src/templates/fork-project-manager-template.test.ts src/templates/
```

The test loads the template through the real `parseTemplate`, prepares its tasks through the real
scheduling validation, checks every link inside the skill resolves, and runs the form parser on a
sample form. It goes red when NanoClaw's plugin reader, task format, or skill frontmatter rules move
under the template.

### 2. Test

```bash
pnpm exec vitest run src/templates/fork-project-manager-template.test.ts
```

### 3. Stamp the agent

```bash
ncl groups create --template engineering/project-manager --name "Project Manager"
```

Note the group id it prints. When a Project Manager already exists, the same command shows the
restamp plan; add `--yes` to apply it and `ncl groups restart --id <group-id>` afterwards.

### 4. Set the model

```bash
ncl groups config update --id <group-id> --model claude-opus-5-5 --effort medium
ncl groups config get --id <group-id>
```

Use the same model id family the install's other agents show in `ncl groups config get`. The
provider stays the install default.

### 5. Mount the workbench, the repositories, and the exports

The agent expects three mounts under `/workspace/extra/`. On the host, create the workbench as an
empty git repository the owner can read over their share, a folder of read-only repository copies
(clones or bare mirrors, one subfolder per project, named as the owner will list them in the
workbench's `projects.md`), and the folder the owner's apps export into. The exports folder may
stay empty.

Allow the three host paths once, following `/manage-mounts`: the workbench read-write, the other
two read-only. Then attach them to the group:

```bash
ncl groups config add-mount --id <group-id> --host <workbench path> --container workbench
ncl groups config add-mount --id <group-id> --host <repos path>     --container repos --ro
ncl groups config add-mount --id <group-id> --host <exports path>   --container exports --ro
ncl groups restart --id <group-id>
```

Then run `/check-new-agent` for this group: CLI scope `group`, a gateway identity with the model
credential only, and the dashboard-port probe. Those three hold for every agent on the install,
so they live in that one skill rather than here.

### 6. Add the destinations

The agent addresses the Architect as `architect` and the owner's Steward (life) agent as
`steward`. Destinations are named by role, whatever the agent behind them calls itself. Add each
pair in both directions once those groups exist; the Steward pair is optional, and without it the
form exchange simply does not happen.

```bash
ncl destinations add --agent-group-id <pm-id>        --local-name architect       --target-type agent --target-id <architect-id>
ncl destinations add --agent-group-id <architect-id> --local-name project-manager --target-type agent --target-id <pm-id>
ncl destinations add --agent-group-id <pm-id>        --local-name steward         --target-type agent --target-id <steward-id>
ncl destinations add --agent-group-id <steward-id>   --local-name project-manager --target-type agent --target-id <pm-id>
```

`ncl destinations list --agent-group-id <pm-id>` shows the result. Add no other destination: the
agent's only way out is its channel and these two agents.

### 7. Wire the channel

Give the agent its own Discord channel, with the owner as the only sender, following
`/manage-channels` (or `ncl wirings create --messaging-group-id <mg-id> --agent-group-id <pm-id>`).
First contact runs the template's `welcome` skill: a two-line hello, a mount check, then the first
iteration, which fills in the project list, orders what is already in flight, confirms the cadence
and limits in `process.md`, and resumes the two scheduled tasks once the owner confirms. The tasks ship paused; `ncl tasks list --group <pm-id> --status paused`
shows them, `ncl tasks resume <task-id> --group <pm-id>` turns one on by hand.

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

Edit the template under `.claude/skills/add-project-manager/payload/`, re-run step 1 and step 2,
then restamp: `ncl groups create --template engineering/project-manager` shows the plan,
`--yes` applies it, and `ncl groups restart --id <group-id>` makes it live. Restamping replaces
the persona, skills, and task definitions (prompt and schedule) and leaves memory, the workbench,
mounts, destinations, wiring, and task pause state alone. A schedule changed with `ncl tasks
update` goes back to the template's on restamp, so a lasting change to a run time is made in the
task file's `schedule:` line as well.

## Troubleshooting

- **"Not an agent plugin"** at stamp time: step 1 did not run from the project root; `ls
  templates/engineering/project-manager/plugin.json` must exist.
- **The agent says the workbench is missing**: the mount in step 5 is not attached or the group
  was not restarted; `ncl groups config get --id <group-id>` lists `additional_mounts`.
- **`send_message` to `architect` drops with "unknown destination"**: step 6 was not run for
  this pair, or the target group id is wrong.
- **The tasks never fire**: they ship paused; the first iteration resumes them when the owner
  confirms the order, or resume them by hand as in step 7.
