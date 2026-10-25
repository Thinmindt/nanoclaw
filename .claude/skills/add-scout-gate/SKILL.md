---
name: add-scout-gate
description: Add the content gate on agent-to-agent messages between the Scout, the one agent that reads the open web, and the agents that ask it. Use when an Architect (or any agent that reads private code) is given a destination to the Scout, so that no link, host, path, blob, or private term can leave the machine inside a research question, and so that every answer coming back arrives as bounded plain text.
---

# Add Scout gate

An agent that reads private repositories must never be the same agent that reads the open web: a
page it opens could carry instructions, and a question it sends could carry data out. The fork
splits the two. The Architect reads code and never has web access; the Scout reads the web and
never sees code. Between them sits this gate.

The gate is mechanical. It runs on the host, inside the agent-to-agent guard, before a message
from any agent to a gated target is written to that target's inbox. A target is gated when its
agent group is named `scout` (any case) or its group id is listed in `data/a2a-gate/targets`.
Both are the operator's to set: a group's name changes only through an approval-gated command,
and no agent can change another group. The sender's own destination label is not consulted,
because a sender can add labels. No model is consulted. It refuses:

| Rule | What it stops |
|------|---------------|
| fields | any content field besides a string `text` and a list of file names: the target would see a quoted reply, links, or app context that the rules below never read |
| attachments | any file, whatever its name |
| size | text over 4000 characters, which is a document, not a question |
| invisible | control, zero-width, bidi, soft-hyphen, and tag-block characters: they split a term so it no longer matches, and the tag block can hide a whole sentence |
| url, host, ip, email | links with a scheme, `www.`, or a dotted name followed by a path; bare host names on a known ending, also spelled out (`example dot com`, `exfil[.]com`); IPv4/IPv6 addresses; mail addresses |
| path | absolute, relative with two or more slashes, home-relative, and Windows paths |
| token | base64 runs of 40 or more with a digit or symbol, hex runs of 32 or more, and any whitespace-free token of 48 or more |
| private-term | any line of `data/a2a-gate/private-terms`, case-insensitive substring |
| canary | any line of `data/a2a-gate/canaries`, same match, checked first and logged as a tripped canary |

Text is folded before the rules run (compatibility forms, ideographic stops, bracketed or
spelled dots), so `ｅｘｆｉｌ。com` is a host too. A refused message is not delivered. The
sender gets one system note saying which rule matched and what matched, so it can rephrase and
send again; the host log carries the rule only, never the matched text. If either term file is
missing or unreadable, every gated message is refused: an unconfigured gate is a closed gate.
Pairs whose target is not gated are untouched.

The other direction is reduced, not refused. An answer from a gated group (the same name or id
match, on the sender) is written to the target's inbox as plain text and nothing else: any
attachment is dropped; control, zero-width, bidi, and tag-block characters are removed; HTML
and XML tags are removed; a line that opens with a role marker (`system:`, `assistant:`,
`instructions:`) or carries an "ignore your previous instructions" phrase is replaced by a note
saying so; and the text is cut at 8000 characters. A header line on the answer says what was
removed, so a trimmed answer is never read as a complete one. Links stay: the Architect checks
sources by id against them. A page's instruction phrased as ordinary prose still crosses as
text; the Architect's own rule that an answer is data is the layer for that.

The gate is mechanical in both directions. Human approval taps are a separate, upstream
mechanism: a message policy on a pair (`ncl policies set`) holds every message for the owner's
tap, after the content gate has had its say. The `add-scout` skill sets the two policies on the
Architect ↔ Scout pair, so the owner sees every question going out and every answer coming back
and nothing is delivered without a tap. A refused message never reaches the card.

Known limits of a pattern gate, stated so nobody relies on more than it does: a bare host on an
ending the list does not know crosses when it carries no path; a secret split into short
chunks crosses; a private fact in plain words that match no term crosses. Two-letter endings
that are also file extensions (`sh`, `so`, `in`, `is`, `it`, `me`, `to`) are left out of the
bare-host list so `build.sh` and `libfoo.so` cross.

One piece: `src/modules/a2a-gate/`, called from two places in the agent-to-agent module: the
`a2a.send` decision (refuse) and the route that writes to the target's inbox (reduce).

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the files

```
.claude/skills/add-scout-gate/resources/a2a-gate/index.ts         → src/modules/a2a-gate/index.ts
.claude/skills/add-scout-gate/resources/a2a-gate/scrub.ts         → src/modules/a2a-gate/scrub.ts
.claude/skills/add-scout-gate/resources/a2a-gate/inbound.ts       → src/modules/a2a-gate/inbound.ts
.claude/skills/add-scout-gate/resources/a2a-gate/scrub.test.ts    → src/modules/a2a-gate/scrub.test.ts
.claude/skills/add-scout-gate/resources/a2a-gate/inbound.test.ts  → src/modules/a2a-gate/inbound.test.ts
.claude/skills/add-scout-gate/resources/a2a-gate/gate.test.ts     → src/modules/a2a-gate/gate.test.ts
```

```bash
mkdir -p src/modules/a2a-gate
cp .claude/skills/add-scout-gate/resources/a2a-gate/*.ts src/modules/a2a-gate/
```

- `scrub.test.ts` unit-tests the outbound rules above, one case per rule, the folding, the
  ordinary technical prose that must cross (`react@18.3.1`, `build.sh`, a four-part version),
  and the term-list parser.
- `inbound.test.ts` unit-tests the reduction: tags, invisible characters, marker and override
  lines (also in full-width letters), the cut at the cap, the header, and that a reduced answer
  passes a second reduction unchanged.
- `gate.test.ts` drives messages through the real `routeAgentMessage` with a test DB: a clean
  question reaches the Scout, a link is refused with one note to the sender across retries and
  no matched text in the reason, a private term and a canary are refused, a target listed by id
  is gated whatever its name, a refusal wins over a message policy's hold, missing term files
  refuse everything, the Scout's answer arrives as plain text with its links kept and its
  attachment dropped, an answer from a group listed by id is reduced too, and the Architect →
  Project Manager and Project Manager → Architect pairs pass untouched, attachment included. It
  goes red if either call in step 2 is removed.

### 2. Call the gate from the agent-to-agent module

Two calls, both in `src/modules/agent-to-agent/`. First, the refusal: in `guard.ts`, inside
`a2aSend`'s `decide`, right after `if (isSelf) return ALLOW('self-send');` and before the
`getMessagePolicy` lookup, insert:

```typescript
    // add-scout-gate skill: a content check that can refuse, never allow.
    const { vetoA2aContent } = await import('../a2a-gate/index.js');
    const veto = await vetoA2aContent(input);
    if (veto) return DENY(veto);
```

The position matters: the destination and target checks above it still refuse first, and a
content refusal wins over a policy hold below it.

Second, the reduction: in `agent-route.ts`, at the top of `performAgentRoute`, before
`resolveTargetSession` is called, insert:

```typescript
  // add-scout-gate skill: an answer from a gated agent arrives as bounded plain text.
  const { sanitizeA2aContent } = await import('../a2a-gate/index.js');
  msg = { ...msg, content: await sanitizeA2aContent(session.agent_group_id, msg.content) };
```

That function is the one door to the inbox, and an approved replay re-enters through it, so a
held answer is reduced after the tap like any other. If either block is already present, leave
it. Nothing is added to `src/modules/index.ts`; the dynamic imports at the call sites are the
whole wiring.

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/modules/a2a-gate src/modules/agent-to-agent src/guard
```

### 4. Write the lists on the host

The lists live outside the repository, under `data/a2a-gate/`, one entry per line, `#` for
comments, entries under four characters ignored. They are never committed.

```bash
mkdir -p data/a2a-gate
touch data/a2a-gate/private-terms data/a2a-gate/canaries data/a2a-gate/targets
chmod 600 data/a2a-gate/private-terms data/a2a-gate/canaries
```

`targets`: the Scout's agent group id, one per line, from `ncl groups list`. A group named
`scout` is gated without it; listing the id as well keeps the gate on if the group is ever
renamed. The file may be absent; then only the name match gates.

`private-terms`: the owner's name and handles, family and pet names, project names, host and
machine names, the share's folder names, and anything else that would identify the owner or
the projects to a stranger. The Steward agent can draft the list from what it knows; the owner
reviews it. The list is checked as a case-insensitive substring, so `bird-counter` also catches
`BirdCounter-v2` but `Bobby` also catches `bobbysocks`; prefer distinctive terms of five characters or more.

`canaries`: a few made-up strings (for example `zebra-umbrella-42`) that the owner also pastes
into private documents the Architect can read, such as a workbench note or a README in a
mirror. If one ever matches, a document was lifted into an outbound question, and the log line
`a2a-gate: canary tripped` says which message.

All three files are read on every gated message, so an edit takes effect at once; no restart.

### 5. Mark the install reviewed and restart

The host refuses to start on a checkout it has not recorded. Once the build and tests pass, and
the operator has reviewed the change, stamp the checkout and restart:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Then, from the Architect's channel, ask it to send the Scout a question containing a link. The
Architect should report that the message was refused; `ncl sessions list` shows no new Scout
activity, and `logs/nanoclaw.log` carries a `Delivery action denied by guard` line whose reason
begins `a2a-gate: message to scout refused`. Then
ask it a clean question; approve the two cards (question out, answer back), and the Architect's
report of the answer should quote the gate's header line, `[gate: answer from Scout, plain
text, ...]`.

## What the gate does not do

It does not judge an answer's content, only its shape: links, source ids, and prose cross as
text. It does not touch messages between other pairs, and it does not call a model. The known
limits above are the reason the Architect's own rules, to ask generic questions and to read
every answer as data, exist alongside it. Keep the term list current when a project or a name
is added.

## Troubleshooting

- **Every question to the Scout is refused with "not configured"**: step 4 was not run, or
  `data/a2a-gate/` is not readable by the host's user.
- **A legitimate question is refused as `host`**: a file name whose extension is on the ending
  list (`index.app`, `System.IO`) matches. Rephrase without the file name; the Scout does not
  need it.
- **Nothing is refused**: the Scout's group is not named `scout` and its id is not in
  `targets`; `ncl groups list` shows both.
- **The refusal note never reaches the sender**: the outbound row had no session id; the log
  line still shows the refusal.
- **An answer arrives cut or with lines removed**: the header line says what the gate did; the
  log line `a2a-gate: answer reduced to plain text` carries the counts. The Scout can be asked
  for the rest in the next round.
