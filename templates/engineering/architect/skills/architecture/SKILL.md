---
name: architecture
description: Plan or review software architecture through a small expert panel, or give a scope verdict on a proposed work item. Use when the Project Manager or the owner asks for an architecture review, a system health review, a design, a technology choice, a migration plan, or a verdict on whether an item is the right size and in the right place. Do not use for ordinary PR review, debugging, or implementation.
---

# Architecture

Choose the mode from the request:

| Mode | Request | Instructions |
|------|---------|--------------|
| Review | Assess an existing repository or a proposed design for strengths, gaps, and risks. | [references/review.md](references/review.md) |
| Planning | Design a new system, feature, refactor, migration, or technology choice. | [references/planning.md](references/planning.md) |
| Scope verdict | Judge one work item from the Project Manager: right size, right place, what it misses. | [references/scope-verdict.md](references/scope-verdict.md) |

Review and planning run the [shared workflow](references/workflow.md) end to end, with the mode
supplying scope inputs, the expert output contract, verification checks, and report sections. A
scope verdict is lighter: no panel, usually no Scout round, one fixed shape.

Every run keeps its working data under `/workspace/agent/runs/<run-id>/` and may span several
turns, because current-source research goes through the Scout agent one round at a time;
[references/scout-rounds.md](references/scout-rounds.md) holds the request shape, what may
cross, and how a run resumes. Read it before the first round of any run.

All resources ship inside this skill. Follow links relative to the file that contains them.
Assignment `output_contract` paths are relative to this skill's `references/` directory, as
defined in the [assignment contract](references/contracts/expert-assignment.json).

Stay read-only. Deliver the coordinator's verified report as prose; expert JSON stays in the run
folder.
