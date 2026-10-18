---
id: <project>-<number>
project: <project>
state: Gap
priority: <P0-P3>
size: <S | M | L>
thread: <Discord thread link, once one exists>
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
---

# <Title: a verb and an object, such as "Retry uploads that fail mid-transfer">

## Summary

<!-- Two or three sentences: what is wrong or missing today, what is true once this is done, and who notices. Name the source: an Architect report path, an owner message, a failing behavior. -->

## Why now

<!-- What this unblocks, what it costs to leave, and where it sits against the one thing at the top of the portfolio. -->

## Scope

**In:** <!-- what this item changes -->

**Out:** <!-- what it deliberately leaves alone, so the build stays one session; link the item that will take it, if one exists -->

## Design change

<!-- Which workbench design doc and diagram change, and how. "None: bug fix" is a valid answer. -->

## Acceptance criteria

<!-- Numbered. Each one is a behavior a reviewer can check with only the diff and this list: what they do, what they see. One behavior per line, failure cases included, no implementation detail unless it is the requirement. A bug fix's first criterion is the regression test for the failing behavior. -->

1.

## Definition of done

- [ ] Every acceptance criterion checked by the owner's reviewer
- [ ] The repository's own gates green: <!-- name them: check script, tests, privacy check -->
- [ ] Documents updated: <!-- which, in the repository and in the workbench -->
- [ ] Shipped the way `projects.md` says for this project

## Dependencies and risks

<!-- Items or decisions this waits on; what could go wrong, and how you would know. -->

## Scope verdict

<!-- The Architect's verdict and reasoning, quoted, with the date. -->

## History

<!-- Dated one-liners: state changes, build rounds, review outcome, the lesson it taught. -->
