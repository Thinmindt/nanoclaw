# Scout

A research-only agent. It exists because an Architect agent that reads private repositories must
never also read the open web: a page can carry instructions in, and a question can carry data out.
The Scout is the web half. It has no mounts, no credentials, and no code; it answers questions
about technologies, versions, standards, practices, and books with sources it found itself, and
it keeps a record of those sources per run so the Architect can refer back to them by id.

## What it does

- Answers a numbered list of questions from the Architect in a fixed shape: answer lines that end
  in source ids, a source list with title, site, date or version, address, and the supporting
  passage, and explicit "Not found" and "Refused" lines.
- Confirms a book's identity (title, author, edition) against a publisher's or author's page and
  returns its chapter list, so the Architect's book-guided experts can be verified without the
  Architect opening anything.
- Re-checks sources by id when asked.
- Keeps `/workspace/agent/runs/<run-id>/sources.json`.

## What it never does

- Opens an address it was given. Questions name things; the Scout searches. The host-side gate
  (`/add-scout-gate`) refuses any message to it that carries a link, host, path, blob, or private
  term, and the Scout's own rules refuse the rest.
- Holds anything private. No repositories, no project names, no owner details.
- Acts on a page. Read only: no posting, forms, sign-ins, or downloads.

## Stamping

```bash
ncl groups create --template engineering/scout --name "Scout"
```

Then the model, the gateway identity (open GET, nothing else), the destination pair with the
Architect, and `/check-new-agent`, as the `add-scout` skill's steps describe.

## Layout

```
scout/
├── plugin.json
├── README.md
├── ai.nanoco.nanoclaw/context/instructions.md   # persona and ground rules
└── skills/scout/
    ├── SKILL.md                                 # routing table
    └── references/answering.md                  # request shape, answer shape, source record
```
