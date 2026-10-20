# Reference forks

A short, curated list of NanoClaw forks worth reading when this install wants an idea, a pattern or a second
opinion on a change. It is not a list of popular forks: most of the 12,000+ forks are untouched copies, and
star counts follow promotion more than quality.

Checked on 2026-10-18 against the GitHub API. Re-check before relying on a fork: these drift fast.

## What gets a fork onto the list

A fork qualifies on either of two grounds:

1. **Many people, real review.** Several human contributors of its own (upstream's inherited history does
   not count), work landing through reviewed pull requests, and a commit history that is mostly not
   machine-generated.
2. **Vendor backing.** It is published by the company whose product it adapts NanoClaw to. The vendor knows
   its own platform's behaviour from the inside, which counts for more than headcount.

A fork with one author and mostly AI co-authored commits does not qualify, however good its README reads.

How it is measured: the fork's own commits are the ones `compare/main...<fork>` reports as ahead of
upstream. Contributor counts on a fork's front page include everyone who ever committed upstream, so they
say nothing about the fork itself.

## On the list

### thenvoi/nanoclaw-thenvoi

- **Ground:** vendor backing, and several humans. Published by Thenvoi, with commits from at least four of
  its staff accounts; work lands through pull requests (34 merges among 98 own commits); about a fifth of
  the commits carry an AI co-author trailer.
- **What it adds:** a channel adapter for the Thenvoi platform.
- **Read it for:** how a vendor wires a new channel into NanoClaw, and a worked CI setup on a fork.
- **Caution:** last pushed 2026-05; about 2,300 commits behind upstream, so it predates much of v2. Read it
  for the adapter's shape, not for current host internals.

### boxlite-ai/agentlite

- **Ground:** vendor backing. Published by BoxLite under its own organization, adapting NanoClaw to run
  agents in BoxLite VMs. One author, but that author is the vendor; work lands through pull requests
  (64 merges among 178 own commits).
- **What it adds:** NanoClaw recast as an SDK, with a VM backend in place of containers and a choice of
  agent backend.
- **Read it for:** a second isolation model beside Docker, and how the host splits once it is a library.
- **Caution:** last pushed 2026-04 and far behind upstream. It diverges in shape, so nothing in it ports
  over as a patch.

## Watching, not yet on the list

### prathish-ks/isthmus

A hardened NanoClaw distribution: security- and liveness-critical host decisions re-implemented in a Go
"trust kernel" that mediates every Docker, filesystem and network call, with egress lockdown and CI
against live infrastructure. Its subject is the closest of any project here to this install's own
concerns (the egress lockdown, the a2a gate, the OneCLI admin block).

It does not meet the bar yet: one author, about three in four recent commits AI co-authored, created
2026-09, two stars, and by its own account verified on one operator's machine and one channel. It is not a
GitHub fork, so it cannot be compared against upstream commit by commit.

Re-check when it has outside contributors or testers. Until then, read its threat model and design docs
for ideas; do not lift its code.

## Looked at and left off

| Fork | Why not |
| --- | --- |
| taylorwalton/talon | Most-starred fork (SOC analyst agent). One main author; about 60% of its own commits AI co-authored. |
| anagrambuild/solclaw | Two humans and reviewed PRs, but a crypto-trading agent: off this install's path, and stale since 2026-04. |
| OpenRouterTeam/nanoclaw | Vendor-owned, but no commits of its own: a plain fork. |
| MedClaw-Org/MedClaw | No meaningful contributor base of its own. |
| Rlin1027/NanoGemClaw, tobalo/bunclaw and similar | Single-author rewrites onto another model or runtime. |
| phj1081/EJClaw | Single-author carry layer, not a GitHub fork; not verifiable commit by commit. |
| Discord-specific forks (gunabot/nanoclaw, jaypyles/nanoclaw-discord, thmtz/nanoclaw-fleet and others) | Single authors, low activity. None is backed by Discord. |

No fork backed by Discord itself turned up. For Discord behaviour the better references are upstream's own
issues and pull requests: the approval-button custom_id bug this fork patches is tracked as
nanocoai/nanoclaw#3456, and #4117, #2899, #3185 and #3458 carry the same or alternative fixes.

The upstream organization's own variant repositories (`nanocoai/nanoclaw-docker-sandbox`,
`nanocoai/nanoclaw-signal`) currently match upstream main and add nothing to read separately.

## Keeping the list honest

- Add a fork only with the measurement written down: own-commit count, distinct human authors, share of
  AI co-authored commits, merges, last push.
- Drop a fork that falls a year behind upstream or loses the ground it was listed on.
- This file is a reading list. Nothing here is installed or trusted by the host.
