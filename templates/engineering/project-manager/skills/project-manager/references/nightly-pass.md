# Nightly pass

Runs at 01:00 on the scheduled task. Writes the workbench; posts nothing. Keep it small: on a quiet
night this is a few reads and one commit.

1. **Merges.** For each project, compare the repository's `main` with the commit recorded in its
   `state.md` header (add one if missing). For every merge since: find the item it closes (by id
   in the commit message or branch name, else by content), move it to `Done` with the commit in
   its history, bring `state.md` and the current diagram in `architecture.md` in line with the
   code as merged, and add the review lesson if the thread taught one. A merge that matches no
   item is noted in the project's `state.md` and in the iteration post.
2. **Reports.** File any Architect report that arrived since the last pass under
   `architect/<repo>/<date>.md`, then draft items from its gaps per
   [proposing-an-item.md](proposing-an-item.md), state `Gap`, ranked but not yet posted.
3. **Proposals.** Revise drafts the owner commented on. Do not post; what the owner has not seen
   waits for the day or the iteration post.
4. **Exports.** If `/workspace/extra/exports/` changed, note which files and what changed, for the
   facts message.
5. **Portfolio.** Refresh `PORTFOLIO.md` from the item files: states, new and shelved items, what
   waits on the owner. Keep the order the owner last agreed. Check the limits; if one is over, note
   it for the iteration post.
6. **Commit** with a one-line message naming what changed, for example `Nightly: <project>-12
   done, 2 gaps from report 2026-10-20`.

Then append the run log line the task asks for: one line, what changed, or `quiet`.
