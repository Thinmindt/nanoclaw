# The workbench

`/workspace/extra/workbench/` is a private git repository. You are its only writer. The owner reads
it over a share; the Architect and the Steward never see it. Commit after every pass.

## Layout

| Path | Holds | Template |
|------|-------|----------|
| `PORTFOLIO.md` | The one thing, the ranked backlog across all projects, what waits on the owner, what is shelved. The owner's order, given in chat, wins; the nightly pass keeps it. | [PORTFOLIO.md](../templates/PORTFOLIO.md) |
| `process.md` | Cadence, states, limits, rules. Changed when you and the owner agree, wherever that happens; the commit is the record. | [process.md](../templates/process.md) |
| `projects.md` | Every project, its mount, how it ships. Confirmed with the owner in the first iteration. | [projects.md](../templates/projects.md) |
| `review-lessons.md` | One rule per closed review thread. Applied to every later proposal. Starts empty. | [review-lessons.md](../templates/review-lessons.md) |
| `projects/<name>/state.md` | What the program does today: modules, boundaries, interfaces. | [state.md](../templates/project/state.md) |
| `projects/<name>/architecture.md` | Current and intended design, in Mermaid. | [architecture.md](../templates/project/architecture.md) |
| `projects/<name>/goals.md` | Roadmap and non-goals in the owner's words. Changed only on their word. | [goals.md](../templates/project/goals.md) |
| `projects/<name>/decisions.md` | Dated decisions with reasons. Append only. | [decisions.md](../templates/project/decisions.md) |
| `projects/<name>/items/<id>.md` | One file per item: gap, design change, criteria, scope verdict, state, thread link, history. | [item.md](../templates/item.md) |
| `architect/<repo>/<date>.md` | Filed Architect reports, verbatim, with a one-line header on what was asked. | none |
| `local/<repo>/` | The local files moved out of each repository (notes, TODO lists, private terms). You keep the live copy; nothing here goes back into a repository. | none |

## Repositories

`ls /workspace/extra/repos/` is the truth about mounts; the workbench's `projects.md` says which
mount is which project and how it ships, so criteria and "done" match reality. A mounted
repository that is not in the table is a question for the owner; a project whose mount is missing
gets a line in the iteration post and no items until it is back. A bare mirror is read with
`git --git-dir=<path> log`, `show`, and `ls-tree`.

## Two sets of documents

A repository's own documents (its README, design document, roadmap) are the public, reviewed
statement of the project: simplified, changed with a code change, read by strangers. The
workbench's `projects/<name>/` documents are your working model: as detailed as the work needs,
changed by you in the nightly pass with no reviewer in the loop. They serve different purposes
and are not copies of each other. The repository says what was decided and shipped; the
workbench says what you currently understand and intend, in enough detail to write acceptance
criteria from. When the two disagree, the code decides and the gap is a finding for the owner.
An item's design change is drafted in the workbench's intended diagram first and reaches the
repository's documents when the owner lands the change.

## How each file is kept

- **Item ids** are `<project>-<number>`, numbered per project, never reused. The id is the file
  name and the thread title.
- **States** live in the item's frontmatter and nowhere else; the nightly pass refreshes
  `PORTFOLIO.md` from the item files (states, sections, new and shelved items), so the two cannot
  disagree for long. The backlog's order is the one the owner last agreed; the refresh keeps it.
- **State docs** change in the nightly pass after a merge, from the code, not from the item's
  intent. If the code does not match what the item promised, that is a finding for the owner.
- **Reports** are filed as they arrived. Your reading of a report goes in the items you make from
  it, not into the report.
- **Local files** are read when a project needs them. A fact from a local file that changes a
  plan is copied into the project's docs with its source named.
- **Dates** are `YYYY-MM-DD`, in the owner's time zone.

## Initializing an empty workbench

When `/workspace/extra/workbench/` has no `process.md`:

1. Copy `PORTFOLIO.md`, `process.md`, `projects.md`, and `review-lessons.md` from the templates.
2. Create `projects/<name>/` for each project in the workbench's `projects.md`, with the four
   project templates, `items/` empty. (On first contact the table is still the placeholder; the
   first iteration fills it, then creates the folders.)
3. Create `architect/` and `local/` empty, with a `.gitkeep` each.
4. `git init` if there is no `.git`, then commit: `Initialize workbench`.

Never overwrite a file that exists. If the mount is missing or read-only, stop and tell the owner;
nothing works without it.
