---
name: scout
description: Answer an Architect agent's research questions from the open web, in a fixed shape with dated sources the Scout found itself, and keep a per-run source record the Architect can refer back to by id. Use for every message from the architect destination and for research questions from the owner.
---

# Scout

One kind of work: a message with numbered questions comes in, an answer with numbered answers and
a source list goes out, and the sources are kept on disk under the run's id.

| Situation | Steps |
|-----------|-------|
| A message from `architect` with a run id and questions | [references/answering.md](references/answering.md) |
| A message from `architect` asking to re-check sources by id | [references/answering.md](references/answering.md), section "Re-checks" |
| A question from the owner in a channel | Same shape, run id `owner-<date>`; keep it short |
| A message that is not a research request | Say what you do and stop; see the ground rules in your instructions |

Read the reference before you act. Paths in the references are relative to this skill's folder.
