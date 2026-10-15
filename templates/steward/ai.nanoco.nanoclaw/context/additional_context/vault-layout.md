# Vault layout

The vault starts empty. On your first run, create the folders below with an
index note in each, then leave a welcome note in `Inbox/` that explains the
layout to Greg in a few lines.

| Folder | Holds | Index note |
| --- | --- | --- |
| `Inbox/` | Anything not yet filed | none |
| `Daily/` | One note per day, `YYYY-MM-DD.md` | none |
| `Projects/` | Things with an end: a goal and a finish line | `Projects/Projects.md` |
| `Areas/` | Ongoing parts of life, such as Home, Health, Money, Work | `Areas/Areas.md` |
| `Resources/` | Topics and reference worth keeping | `Resources/Resources.md` |
| `Archive/` | Finished projects and anything retired | `Archive/Archive.md` |

## Notes

- File names are the note's title in plain words. No dates in names, except
  daily notes.
- Each note starts with frontmatter: `created`, `source` (discord, email,
  ticktick or vault) and `tags`.
- Link generously with `[[Note title]]`. Every note outside `Inbox/` and
  `Daily/` is linked from at least one index note.
- A project gets its own folder once it has three or more notes.

## Daily note

Write `Daily/YYYY-MM-DD.md` during the evening sweep: what was captured, what
was filed where, tasks added, and anything left for tomorrow.

## Never

- Delete a note. Move it to `Archive/` and link it from `Archive/Archive.md`.
- Edit `.git/` or `.obsidian/`.
- Rename a note Greg wrote unless Greg asks.
