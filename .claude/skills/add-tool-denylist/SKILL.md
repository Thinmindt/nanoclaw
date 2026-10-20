---
name: add-tool-denylist
description: Switch off built-in agent tools per agent group, for tools no gateway rule can stop (Claude's WebSearch runs on the model provider's side). Use when an agent's rules forbid a tool and the agent should not hold it at all, for example an agent that reads private code and must never search the web.
---

# Add tool denylist

Every NanoClaw agent gets the same built-in tool list. Most tools that reach the network go
through the credential gateway, where a rule can refuse them. WebSearch does not: the model
provider runs the search, so the request never passes the gateway and no egress rule can block
it. An agent whose rules forbid searching then holds a capability that matters only if it is ever
talked into breaking them.

This skill gives the operator a per-group list of tools to switch off. The list lives on the host
in `data/tool-denylist.json`, which no agent can reach:

```json
{ "<agent-group-id>": ["WebSearch"] }
```

On every container spawn the host writes the group's entry into its `container.json` (a
read-only mount) as `disallowedTools`, and the agent-runner adds those names to the SDK's
disallowed list. A disallowed tool is removed from the model's tool list and refused if called,
in subagents too. Names are bare built-in tool names (`WebSearch`, `WebFetch`) or MCP tool names
and patterns (`mcp__server__tool`, `mcp__server__*`); scoped forms like `Bash(git push:*)` are
refused.

The list fails closed. A missing file switches nothing off. A file that is unreadable, is not
valid JSON, or holds anything but lists of bare tool names stops **every** group's containers
from starting, since the file is one document; the reason is in the host log. A listed group
whose provider is not Claude (the only provider that passes the list on) does not start either,
so switching a group's provider cannot quietly hand the tool back.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the files

```
.claude/skills/add-tool-denylist/resources/tool-denylist/index.ts       → src/modules/tool-denylist/index.ts
.claude/skills/add-tool-denylist/resources/tool-denylist/index.test.ts  → src/modules/tool-denylist/index.test.ts
.claude/skills/add-tool-denylist/resources/agent-runner/claude.disallowed-tools.test.ts → container/agent-runner/src/providers/claude.disallowed-tools.test.ts
```

```bash
mkdir -p src/modules/tool-denylist
cp .claude/skills/add-tool-denylist/resources/tool-denylist/*.ts src/modules/tool-denylist/
cp .claude/skills/add-tool-denylist/resources/agent-runner/claude.disallowed-tools.test.ts container/agent-runner/src/providers/
```

### 2. Write the list into container.json

In `src/container-config.ts`, in `materializeContainerJson`, replace the lines from
`const config = configFromDb(row, group);` through the `fs.writeFileSync(p, ...)` call with:

```ts
  const config = configFromDb(row, group);
  // add-tool-denylist skill: built-in tools the operator switched off for this group.
  const { toolDenylistFor } = await import('./modules/tool-denylist/index.js');
  const disallowedTools = toolDenylistFor(agentGroupId, config.provider);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(disallowedTools.length ? { ...config, disallowedTools } : config, null, 2) + '\n');
```

A group with no entry gets the same `container.json` as before.

### 3. Read it in the agent-runner

`container/agent-runner/src/config.ts`: add to `RunnerConfig`, after `speed`:

```ts
  /** Tools the operator switched off for this group (add-tool-denylist skill). */
  disallowedTools: string[];
```

and to the object `runnerConfigFromRaw` returns, after `speed: readSpeed(raw),`:

```ts
    disallowedTools: Array.isArray(raw.disallowedTools)
      ? raw.disallowedTools.filter((t): t is string => typeof t === 'string' && t !== '')
      : [],
```

`container/agent-runner/src/providers/types.ts`: add to `ProviderOptions`, after `speed`:

```ts
  /**
   * Tools the operator switched off for this group, added to the provider's own
   * disallowed list (add-tool-denylist skill). Providers without a tool list ignore it.
   */
  disallowedTools?: string[];
```

`container/agent-runner/src/index.ts`: in the `createProvider(providerName, { ... })` call, add
`disallowedTools: config.disallowedTools,` after `speed: config.speed,`.

`container/agent-runner/src/providers/claude.ts`, in `ClaudeProvider`:

- add the field `private groupDisallowedTools: string[];` after `additionalDirectories`;
- in the constructor, after `this.additionalDirectories = options.additionalDirectories;`, add
  `this.groupDisallowedTools = options.disallowedTools ?? [];`;
- in the SDK query options, change `disallowedTools: [...this.executionPolicy.disallowedTools],` to
  `disallowedTools: [...this.executionPolicy.disallowedTools, ...this.groupDisallowedTools],`.

### 4. Test

```bash
pnpm run build
pnpm exec vitest run src/modules/tool-denylist
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/providers/claude.disallowed-tools.test.ts src/config.test.ts)
```

The host test goes red if step 2's call is removed; the runner test goes red if step 3 is.

### 5. Write the list

Create `data/tool-denylist.json` with one entry per group whose rules forbid a tool (group ids
from `ncl groups list`), then check it parses before anything spawns with it:

```bash
pnpm exec tsx -e "import('./src/modules/tool-denylist/index.js').then(m => { for (const id of process.argv.slice(1)) console.log(id, m.toolDenylistFor(id)); })" <group-id> ...
```

Each id prints its list. An error here would stop every container from starting; fix the file
first.

### 6. Mark the install reviewed, restart, and check

The agent-runner source is a shared read-only mount, so no image rebuild is needed. The host
refuses to start on a checkout it has not recorded:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

A restart drops chat messages sent while the host is down on channels that do not replay them;
warn the owner first. Running containers keep their old tool list until they restart:
`ncl groups restart --id <group-id>` for each listed group. After its next start,
`groups/<folder>/container.json` shows `disallowedTools`, and asking the agent to list its tools
shows the switched-off ones gone.

Changing the list later is step 5 plus `ncl groups restart --id <group-id>`; no host restart.

## Removing

See `REMOVE.md`.
