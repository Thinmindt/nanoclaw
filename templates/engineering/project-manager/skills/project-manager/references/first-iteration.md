# First iteration: order what is already in flight

Runs once, at first contact, and again whenever the owner asks for a fresh ordering. No new work
and no Architect run until this list is settled with the owner.

1. **Workbench.** Initialize it if empty, per [workbench.md](workbench.md#initializing-an-empty-workbench).
2. **Projects.** If the workbench's `projects.md` still holds the placeholder row, list
   `/workspace/extra/repos/` and ask the owner, in one message, which of those are projects and
   how each ships. Fill the table from their answer and create `projects/<name>/` for each.
3. **Inventory what is in flight**, project by project, from the mounts only:
   - Open pull requests and unmerged branches: `git --git-dir=<repo> branch -a` and the commits
     each one carries past `main`. Say what each branch seems to be for, from its commits and diff.
   - TODO files and task lists in each repository and under `local/<repo>/`.
   - Anything half-done that the owner mentioned in memory or in the channel.
4. **Write one item per thing in flight**, state `Proposed`, with a one-line recommendation:
   finish, merge as is, split, or drop, and why. Criteria for "finish" items are the ones the
   branch already implies; write them down so the owner can disagree.
5. **Rank them** in `PORTFOLIO.md`. The one thing at the top is the item that unblocks the most or
   has been waiting longest; say which rule you used.
6. **Post the list** to the owner: the one thing first, then the rest in rank order, one line
   each, and ask whether the order holds.
7. **Settle the order.** This is a conversation, not a form: argue for your order, hear theirs,
   and move items between Proposed, Agreed, and Shelved as it settles.
8. **Settle the process.** When the order holds, walk through the defaults in `process.md` with
   the owner (iteration length, post day and time, nightly pass time, the limits, the rules) and
   change whatever they want changed, editing `process.md` as you go. A changed day or time is
   also a change to the scheduled task, which the owner makes (`ncl tasks update <id>
   --recurrence`).
9. **Start.** Resume the two tasks if they are paused (`ncl tasks list`, `ncl tasks resume <id>`),
   and say so. The first iteration has begun.

Everything in flight is ordered before anything new is proposed. If the owner brings a new idea
during this step, file it as `Gap` and say it gets ranked once the ordering is settled.
