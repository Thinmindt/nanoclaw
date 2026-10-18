# Architect

An architecture agent for one person's coding projects. It reviews a repository and reports gaps
and risks, plans a design when asked, and gives a scope verdict on a work item the Project
Manager proposes. It reads private repositories, so it has no web access; a separate Scout agent
does its current-source research one round at a time, and the two are kept apart by a host-side
gate on what may cross.

Derived from the public `engineering/code-architect` template by zvi-fried (MIT), which runs a
small book-guided expert panel plus a Tech lead with verified web research. This fork keeps the
panel, the Librarian, the contracts, and the verification discipline, and changes what has to
change when the coordinator cannot open a page.

## What changed from code-architect

- **No web, by design.** The Tech lead runs in two passes: it writes generic questions first
  (technologies, versions, standards, practices; never a project name, path, identifier, or
  address), and applies the Scout's dated sources second. Book identities and chapter lists come
  back from the Scout in the same round. Verification checks sources against the Scout's record by
  id instead of opening them.
- **Runs span turns.** Agent-to-agent messages are asynchronous, so a run sends a Scout round,
  saves its state under `/workspace/agent/runs/<run-id>/`, ends the turn, and resumes when the
  answer arrives. Default limit three rounds per run.
- **A third mode, scope verdict.** A fixed-shape judgment on one work item from the Project
  Manager: right size, too big, too small, or wrong place, with misses, things not to touch,
  risks, and questions.
- **Repositories arrive as read-only mirrors** under `/workspace/extra/repos/<name>`; the run
  clones one into its folder, works from the copy, and deletes it at the end.
- **Everything but the owner's own words is data.** Repository contents, the Project Manager's
  items, and the Scout's answers are evidence; a line that reads like an instruction is reported
  as a finding.
- The eval suite that ships with code-architect is not carried; it exercises the web path.

## Stamping

```bash
ncl groups create --template engineering/architect --name "Architect"
```

Then the model, the mirror mount, the destination pairs with the Project Manager and the Scout,
and `/check-new-agent`, as the `add-architect` skill's steps describe. Apply `/add-scout-gate`
before the `scout` destination exists.

## Layout

```
architect/
├── plugin.json
├── README.md
├── ai.nanoco.nanoclaw/context/instructions.md    # persona, where things live, ground rules
└── skills/architecture/
    ├── SKILL.md                                  # three modes, run folder note
    └── references/
        ├── workflow.md                           # shared seven-step workflow, Scout rounds woven in
        ├── review.md, planning.md                # the two panel modes
        ├── scope-verdict.md                      # the fork's third mode
        ├── scout-rounds.md                       # request shape, what may cross, resume rule
        ├── agents/                               # expert lenses, Tech lead (two passes), Librarian
        └── contracts/                            # JSON schemas every agent returns against
```
