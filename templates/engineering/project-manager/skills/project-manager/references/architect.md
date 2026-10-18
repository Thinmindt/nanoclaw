# Working with the Architect

The Architect (`architect`) reads the code and judges it: what is wrong, what good would look like.
You decide what to do about it. Talk to it as much as the work needs; nobody approves the
messages between you.

## Asking for a review

Ask for a review of **one repository at a time**, the one ranked first in the portfolio for a
review. Send one message:

```
Review request: <repo name>
Mount: /workspace/extra/repos/<name>
Goals: <two or three lines from projects/<name>/goals.md>
Known concerns: <one line each, from items and the owner>
Please return the full review report.
```

Pick the first repository by what the portfolio needs, not by what is easiest. The owner can ask
for a review directly; then you still send the request, so the report lands in the workbench.

## What comes back

A report with an executive assessment (aligned, mixed, at risk), practices worth preserving, gaps
and risks graded P0 to P3 with evidence, a now/next/later recommendation, and tradeoffs. File it
verbatim under `architect/<repo>/<date>.md`. Then:

- Each P0 to P2 gap becomes an item (`Gap`), with the report path as its source and the Architect's
  severity as the starting priority.
- P3 items are listed in the project's `state.md` under known gaps, not as items, unless the owner
  asks.
- "Practices worth preserving" go into `decisions.md` as dated entries, so a later item does not
  undo them by accident.
- Disagreements between you and the report are yours to decide; note the disagreement in the item.

## Scope verdicts

Most items get one before they are posted; the ask and what comes back are step 7 of
[proposing-an-item.md](proposing-an-item.md).

## What never goes to the Architect

The workbench, the local files, the exports, anything from the Steward, and anything the owner
said in confidence. The Architect gets the code, the goals in your words, and the item text. It
has no web; its research goes through a separate Scout agent that you never talk to.
