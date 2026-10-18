# Proposing an item

How a gap becomes agreed work. Each step is a state change in the item file; the Discord thread is
where the owner and you settle it.

## Gap

A gap comes from an Architect report, the owner's message, a failing behavior you can point at, or
a merge that left the docs behind. Create `projects/<name>/items/<id>.md` from the item template,
fill in **Summary** with the source named, and rank it in `PORTFOLIO.md`. Say where it landed if
the owner brought it. A gap can stay a gap for a long time; only what is worth the owner's
attention moves on.

## Proposed

1. **Summary and why now.** What is wrong today, what is true when this is done, who notices,
   and what it unblocks or costs to leave. If you cannot say why now, it stays a gap.
2. **Scope, in and out.** Name what the item leaves alone as carefully as what it changes; the
   "out" list is what keeps the build to one session and the review to one question.
3. **Design change first.** For a feature, refactor, or boundary change, edit the project's
   intended diagram in `architecture.md` and the relevant workbench design doc to the intended
   state, and describe the change in the item. A bug fix skips this: its design change is "None:
   bug fix" and its first criterion is the regression test for the failing behavior.
4. **Acceptance criteria.** Numbered. Each one is a behavior a reviewer can check with only the
   diff and the list: what they do, what they see. One behavior per line; failure cases are
   criteria too ("an upload cut off mid-transfer is retried once, then reported"); no
   implementation detail unless it is the requirement. Include the repository's own gates (its
   check script, its tests, its privacy check) by name. Apply every rule in `review-lessons.md`.
   A criterion you cannot word as something observable is a sign the scope is not settled.
5. **Definition of done.** Tick the item's checklist in advance: criteria, gates, documents, and
   how it ships per `projects.md`. If a box cannot be ticked for this project, say why.
6. **Size.** S fits in part of a build session, M fills one, L is split into linked items before
   it goes further. Dependencies and risks are written down, not remembered.
7. **Scope verdict.** Send the item file's content to `architect` and ask for a scope verdict: is
   the change the right size and in the right place, what does it miss, what should it not touch.
   Chat until the verdict is clear; there is no limit on rounds. If you disagree, say so and settle
   it; the item quotes the final verdict and records each side's final position. A bug fix with a
   clear regression test may skip the verdict; the item says so.
8. **Post it** in a new Discord thread titled with the item id: the item file's content, and ask
   whether it is agreed or what changes. Then talk it through in the thread until the owner says
   agreed or sends it back; update the item file as the thread settles things, so the file always
   says what was agreed. While the thread is open the item is `Proposed` and counts against the
   waiting limit in `process.md`.

## Agreed and ToDo

When the owner says agreed, the item is `Agreed`. It enters `ToDo` when ToDo has room (the limit in `process.md`) or
when the owner names it as high priority, in which case it bumps the lowest-ranked ToDo item back to
`Agreed`; say which one. Record the thread link in the item.

## In progress and after

The owner moves an item to `In progress` by starting to build it; they tell you, or you see the
branch. Only one item is In progress; if the owner starts a second, say so once and record both.
`In review` when the PR is open; `Done` when the merge lands and the nightly pass confirms the
code matches the criteria. If it does not, the item stays In review with the mismatch named.

## Shelved

The owner's word moves the item to `Shelved`, with the reason in its history. Shelved items stay listed at the bottom of `PORTFOLIO.md`.
