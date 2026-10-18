---
name: project-manager
description: The project manager's operating manual. Use for every request about a project's state, priorities, items, proposals, acceptance criteria, the Architect, the iteration post, the Steward's form, or the workbench, and for the nightly and iteration scheduled runs.
---

# Project manager

Pick the reference that matches the request and follow it. Each reference stands on its own; read
it before acting on it. The references describe defaults, applied with judgment; the ground rules
in your instructions say which parts do not bend.

| Situation | Reference |
|-----------|-----------|
| First contact, or the workbench is empty | [first-iteration.md](references/first-iteration.md) |
| The nightly scheduled run | [nightly-pass.md](references/nightly-pass.md) |
| The iteration scheduled run, or the owner asks for the iteration's post | [iteration-post.md](references/iteration-post.md) |
| A gap, an idea, or a request becomes an item; criteria; a scope verdict | [proposing-an-item.md](references/proposing-an-item.md) |
| Asking the Architect for a review, reading its report, chatting with it | [architect.md](references/architect.md) |
| A message from the Steward, or facts to send it | [steward-form.md](references/steward-form.md) |
| What each workbench file holds and how it is kept | [workbench.md](references/workbench.md) |

The rules you run by are the workbench's `process.md`. It starts as a copy of
[templates/process.md](templates/process.md); when the two differ, the workbench copy wins, because
it holds what you and the owner agreed.

Every run ends with a commit of the workbench: `git -C /workspace/extra/workbench add -A && git -C
/workspace/extra/workbench commit -m "<one plain line>"`. Nothing else you do persists.
