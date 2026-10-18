# Reference forks

NanoClaw forks and derivatives worth reading before designing a change to this fork. The Architect reads this file from its repository mirror. The list is curated for quality, so it stays short on purpose.

## Bar for inclusion

A fork is listed when it meets every point below:

- It has several active human collaborators, not one person working alone with an assistant.
- It shows real human review, such as review discussion, findings fixed before merge, and green CI.
- It has sustained activity and some outside adoption, such as stars, forks or known users.
- Its changes are delivered in a form we can learn from, such as skills, clean patches or documented design.

Backing from the company whose platform a fork adapts also qualifies on its own, for example a Discord-maintained Discord adapter, because inside knowledge of the platform signals quality. The backing must be verifiable, for example through an official organization account or a statement from the company.

Forks that were checked and fell short go under "Checked, not listed" with the date, so they are not re-checked without a reason.

## Listed

### nanocoai/nanoclaw (upstream, formerly qwibitai/nanoclaw)

- https://github.com/nanocoai/nanoclaw, including its `channels` and `providers` branches.
- This is the maintained source, with many contributors and real review. Search its open and closed PRs and issues for a problem before designing a fix. Several fork patch skills track upstream work and should be dropped when that work lands.

No outside fork meets the bar yet. Last checked 2026-10-18.

## Checked, not listed

| Fork | Checked | Reason |
|------|---------|--------|
| prathish-ks/isthmus | 2026-10-18 | It has a single author, early activity and describes itself as pre-beta. No platform-company backing. Its design is worth a look: a small Go trust kernel for guard, mount and egress decisions. Re-check if it gains contributors. |
| Daxorinator/nanoclaw | 2026-10-18 | It is a single-owner fork whose large bundled PRs merge without visible review. |
| foxey/nanoclaw | 2026-10-18 | It is a single-owner fork that edits core files directly rather than shipping skills. |
| davekim917/nanoclaw | 2026-10-18 | It is a single-owner fork with no visible review. |
