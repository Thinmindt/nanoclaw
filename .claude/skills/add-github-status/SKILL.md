---
name: add-github-status
description: Add `ncl github pr-status` and `ncl github issue-status`, host-side commands that let chosen agents read the state of pull requests and issues on the owner's GitHub repositories, with the owner's own words on them and nothing anyone else wrote. Use when an agent that holds private material (a Project Manager with its workbench) needs to follow the lifecycle of pull requests without reading strangers' comments and without any way to post.
---

# Add GitHub status

An agent that keeps the owner's private plan needs to follow pull requests and issues on the
owner's repositories. This skill gives it host-side commands for that instead of a wider gateway
grant. What the tool controls, in the order that matters (the same order as `add-seat-sites`):

1. **Egress.** The agent never calls GitHub. The host does, through the gateway as
   `GITHUB_STATUS_GATEWAY_AGENT`, an identity whose policy allows GET on
   `api.github.com/repos/<owner>/<repo>/*` for the configured repositories and blocks everything
   else. The request shape is fixed by the tool: repository name from the configured list, a
   number, a page size. No input can turn it into a way to post, and nothing the agent holds can
   ride in a path or a query string. The agent's own identity gets GitHub only where the operator
   grants it separately, as exact paths through `add-seat-sites`; this tool adds no reach to it.
2. **Budget.** The tool identity's rule carries a rate limit (`GITHUB_STATUS_RATE_LIMIT_PER_HOUR`,
   default 300). A list of open pull requests costs one request plus two per pull request.
3. **Input.** A pull request on a public repository is stranger-written: anyone can comment there.
   So the agent sees fixed fields for every item (number, state, draft, merged, head and base
   branch, labels, dates, check counts with the names of failed checks, who approved or requested
   changes) and free text only from the owner. A title, description, comment or branch name is
   passed on only when its author is `GITHUB_STATUS_OWNER_LOGIN`; anyone else's is replaced by a
   placeholder naming the login (`[title by someone not shown]`), bots included. The owner's text
   is reduced to plain text (tags and invisible characters removed) and capped: 200 characters for
   a title, 4000 for a description, 2000 per comment, the newest 20 comments. The same reduction
   the Scout gate applies to answers, kept local so this tool stands on its own.

Also:

- **Chosen agents:** only agent groups in `GITHUB_STATUS_AGENT_GROUPS` may call it.
- **No token for public repositories.** GitHub answers unauthenticated reads at 60 requests an hour
  per address; a list of open pull requests costs one request plus two per pull request. For
  private repositories, or a higher limit, the operator assigns a fine-grained read-only token
  (pull requests and issues, read, those repositories only) to the tool identity in the gateway;
  the token never reaches the host code or any container.
- **Works under `cli_scope=group`:** the commands name no CLI resource, so the group-scope
  whitelist doesn't hide them. Access is gated by `GITHUB_STATUS_AGENT_GROUPS` instead.

The commands:

```
ncl github repos
ncl github pr-status --repo <name> [--all]
ncl github pr-status --repo <name> --pr <number>
ncl github issue-status --repo <name> [--all]
ncl github issue-status --repo <name> --issue <number>
```

`--all` includes closed and merged items (the 30 most recently updated). The single-item form
adds the owner's own description and comments and, for a pull request, whether GitHub considers it
mergeable.

Requires the OneCLI gateway (`/add-onecli`). The gateway setup in step 4 uses OneCLI 1.42's REST
API; re-check it before upgrading OneCLI past that pin.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the tool, its commands and tests

```
.claude/skills/add-github-status/resources/github-status.ts                 → src/github-status.ts
.claude/skills/add-github-status/resources/github-status.test.ts            → src/github-status.test.ts
.claude/skills/add-github-status/resources/github-status-skill-sync.test.ts → src/github-status-skill-sync.test.ts
.claude/skills/add-github-status/resources/github.ts                        → src/cli/resources/github.ts
.claude/skills/add-github-status/resources/github-registration.test.ts      → src/cli/resources/github-registration.test.ts
.claude/skills/add-github-status/resources/github-group-scope.test.ts       → src/cli/resources/github-group-scope.test.ts
```

```bash
R=.claude/skills/add-github-status/resources
cp $R/github-status.ts $R/github-status.test.ts $R/github-status-skill-sync.test.ts src/
cp $R/github.ts $R/github-registration.test.ts $R/github-group-scope.test.ts src/cli/resources/
```

- `github-registration.test.ts` guards the integration point in step 2. It imports the real
  command barrel and drives the three commands through the registry as dispatch does, with a
  stand-in `onecli` binary as the only fake; it checks every gateway call is a GET on the
  configured repository under the tool identity. Remove the barrel line and it goes red.
- `github-group-scope.test.ts` drives the commands through the real dispatch and guard as a
  `cli_scope=group` agent against a test database, so a change that hides or breaks them for
  group-scoped agents goes red.
- `github-status-skill-sync.test.ts` fails if a file in `src/` and its copy in `resources/`
  differ, so an edit made on one side only can't be lost on the next rebuild.
- `github-status.test.ts` unit-tests the tool's own rules: the owner-only text filter, the
  placeholders, the caps, check and review summaries, the request shape, and the rate-limit
  message.

### 2. Register the commands

Append this line to `src/cli/resources/index.ts`, after the last `import`, unless it is already
there:

```typescript
import './github.js';
```

### 3. Name the owner, the repositories and the agents

Find the agent group id(s) that may use the tool with `ncl groups list`. Add to `.env`, replacing
the placeholders. Set each key once, and change existing values rather than adding duplicates:

```
GITHUB_STATUS_OWNER_LOGIN=<the owner's GitHub login>
GITHUB_STATUS_REPOS=<name>=<owner>/<repo>[,<name>=<owner>/<repo>...]
GITHUB_STATUS_GATEWAY_AGENT=github-status-tool
GITHUB_STATUS_AGENT_GROUPS=<agent group id>[,<another>]
# optional, default 300
GITHUB_STATUS_RATE_LIMIT_PER_HOUR=300
```

`<name>` is the short name the agent will use with `--repo`; for a Project Manager, use the names
its `projects.md` lists, which are also its mirror folder names. The repository list lives only in
`.env`, never in the repository.

### 4. Configure the gateway

```bash
node .claude/skills/add-github-status/setup-gateway.mjs
```

This creates the `github-status-tool` gateway agent if needed, makes it selective with no app
connections, and publishes its two rules: allow GET on `api.github.com` under
`/repos/<owner>/<repo>/` for each configured repository (rate-limited), block everything else.
It never changes other agents' rules and never touches this identity's secret list. Re-run it
after changing the repositories or the rate limit in `.env`.

For private repositories, or to lift GitHub's unauthenticated limit, create a fine-grained
personal access token on GitHub limited to those repositories with read-only permission on pull
requests and issues (metadata comes with it), store it in OneCLI as a secret for `api.github.com`,
and assign it to the `github-status-tool` identity in the dashboard. Nothing else gets it.

Publishing makes the gateway's whole policy draft live, so the script stops if the draft holds
unpublished edits to other rules. Publish or discard those first, or re-run with `--force` to
publish them as well.

### 5. Build and test

```bash
pnpm run build
pnpm exec vitest run src/github-status.test.ts src/github-status-skill-sync.test.ts \
  src/cli/resources/github-registration.test.ts src/cli/resources/github-group-scope.test.ts
```

### 6. Mark the install reviewed and restart

The host refuses to start on a checkout it has not recorded. Once the build and tests pass, and
the operator has reviewed the change, stamp the checkout and restart:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

### 7. Try it, then tell the agent

```bash
ncl github repos
ncl github pr-status --repo <name>
ncl github pr-status --repo <name> --pr <number>
```

The first prints the configured names; the second one line per open pull request; the third adds
the owner's own description and comments. Then tell the agent the tool exists, for example in its
memory or instructions:

> Read pull request and issue state with `ncl github pr-status --repo <name>` (`--pr <number>` for
> one, with my own description and comments; `--all` to include closed and merged ones) and
> `ncl github issue-status --repo <name>` (`--issue <number>`, `--all`). `ncl github repos` lists
> the names. It shows numbers, states, checks, reviews and dates for every item, and text only
> where I wrote it; what anyone else wrote appears as a placeholder, and that is by design: never
> ask for it. It is the only way to read GitHub, and there is no way to write to it; never ask the
> operator to loosen the gateway's GitHub rules.

## Troubleshooting

- **"The GitHub status tool is not configured":** one of the four `GITHUB_STATUS_*` keys is missing
  from `.env`, or `GITHUB_STATUS_REPOS` has no valid entry.
- **"This agent group is not allowed":** add its id to `GITHUB_STATUS_AGENT_GROUPS`.
- **"unknown repo":** the name is not in `GITHUB_STATUS_REPOS`; `ncl github repos` lists them.
- **"GitHub's rate limit is used up":** more than 60 unauthenticated requests this hour from the
  host's address. Wait, or assign a read-only token to the tool identity (step 4).
- **HTTP 403 `blocked_by_policy`:** the repository is not in the published allow rule. Re-run
  step 4 after editing `GITHUB_STATUS_REPOS`.
- **HTTP 404:** the repository is misspelled, or it is private and the identity holds no token
  for it.
- **A title shows as `[title by … not shown]`:** the author is not `GITHUB_STATUS_OWNER_LOGIN`.
  That is the filter working; check the login's spelling if it should have matched (case does not
  matter).
- **"unpublished changes to other rules" from step 4:** see step 4; publish or discard the
  dashboard edits.
- **`github-status-skill-sync.test.ts` fails:** a file in `src/` and its copy in `resources/`
  differ. Make the same edit on both sides; `resources/` is the canonical copy.
