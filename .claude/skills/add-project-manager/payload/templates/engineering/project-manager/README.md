# Project Manager agent template

A NanoClaw agent that keeps the plan for one person's coding projects. It never builds. It keeps a
private workbench of state and design docs, turns an Architect agent's findings into agreed work
items with acceptance criteria, runs a fixed-length iteration with one item in progress at a time,
and, when the owner has a Steward (life) agent, exchanges a fixed form with it each iteration.

## Layout

```
project-manager/
├── plugin.json                         # Agent Plugins manifest
├── ai.nanoco.nanoclaw/
│   ├── context/instructions.md         # persona + the ground rules
│   └── tasks/                          # created PAUSED; the first iteration resumes them
│       ├── nightly-pass.md             #   01:00 daily by default, workbench only
│       └── iteration-post.md           #   Sunday 10:00 by default, the one post + the facts message
├── skills/
│   ├── welcome/SKILL.md                # first contact: hello, mount check, first iteration
│   └── project-manager/
│       ├── SKILL.md                    # router
│       ├── references/                 # one file per situation
│       ├── templates/                  # the workbench's starting files (process, projects, ...)
│       └── scripts/parse-form.mjs      # the Steward's form, parsed deterministically
└── README.md
```

No `mcp.json`, no packages. Everything it reads is a mount; everything it sends is a message.

## What it expects

| Mount (container path) | Mode | Holds |
|------------------------|------|-------|
| `/workspace/extra/workbench` | read-write | Its private git repository |
| `/workspace/extra/repos/<name>` | read-only | One per project: a clone or a bare mirror |
| `/workspace/extra/exports` | read-only | Whatever the owner's apps export for it; may be empty |

| Destination | Target |
|-------------|--------|
| the owner's channel | the wired channel |
| `architect` | the Architect agent group |
| `steward` | the owner's Steward (life) agent group, optional |

Destinations are named by role. Whatever an agent calls itself, the Project Manager addresses it
by the destination name.

## Stamp it

```bash
ncl groups create --template engineering/project-manager --name "Project Manager"
```

Then set its model, add the mounts and destinations, wire the channel, and let first contact run
the first iteration, which confirms the projects and the process and resumes the two tasks. The
fork skill `/add-project-manager` walks through every step.

## Making it yours

The template ships one way of working: a one-week iteration closed by a Sunday post, a nightly
pass, the limits 4 / 3 / 1, scrum-like states. Those are defaults, not the design. The agent
states them in the first iteration and asks whether they fit; what the owner wants different
lives in two places:

- **The process** (iteration length, post day, limits, states, rules): the workbench's
  `process.md`. Either side proposes changes whenever they come up; once agreed, the agent edits
  the file, and the workbench copy wins over the template's. The references are written as
  defaults the agent applies with judgment; only the five ground rules in `instructions.md` and
  the form parser are fixed.
- **The run times**: the two scheduled tasks. NanoClaw stamps a template's `tasks/*.md` into the
  agent group as paused scheduled tasks, so after stamping they are ordinary tasks the owner
  changes with `ncl tasks update <id> --recurrence "<cron>"` (times follow the group's
  timezone). A restamp of the template puts the template's schedule back, so a lasting change
  goes into the task file's `schedule:` line in the local `templates/` copy as well.
- **The projects**: the workbench's `projects.md`, filled with the owner in the first iteration.
- **The Steward exchange**: optional. With no `steward` destination the form and the facts message
  simply do not happen. The form's fields are in `references/steward-form.md` and
  `scripts/parse-form.mjs`; both change together.
