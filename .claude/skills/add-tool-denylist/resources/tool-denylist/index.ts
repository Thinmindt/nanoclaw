/**
 * tool-denylist module — built-in agent tools switched off per agent group.
 *
 * Some tools never pass through the credential gateway: Claude's WebSearch
 * runs on the model provider's side, so no egress rule can stop it. An agent
 * whose rules forbid such a tool should not hold it at all. The operator lists
 * the tools per agent group in `data/tool-denylist.json`:
 *
 *   { "<agent-group-id>": ["WebSearch"] }
 *
 * `toolDenylistFor` is read by `materializeContainerJson` on every spawn and
 * written into the group's `container.json` (a read-only mount) as
 * `disallowedTools`; the agent-runner adds those names to the SDK's
 * disallowed list, which removes them from the model's tool list. Agents
 * cannot reach `data/`, so only the operator can change the list.
 *
 * A missing file means no tools are switched off. A file that cannot be read
 * or parsed, or that holds anything but bare tool names, throws for every
 * group (the file is one document), and a listed group on a provider that
 * cannot honor the list throws too: a container does not start rather than
 * start with a tool its operator meant to remove.
 * Installed by the add-tool-denylist skill.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

const DENYLIST_PATH = path.join(DATA_DIR, 'tool-denylist.json');
/** A built-in tool name (`WebSearch`) or an MCP tool name or pattern (`mcp__server__tool`, `mcp__server__*`). */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*(\*)?$/;
/** Providers whose agent-runner passes the list to their SDK. */
const HONORING_PROVIDERS = new Set(['claude']);

/** Parse and validate the denylist file's contents. Throws on anything but `{ groupId: [toolName, ...] }`. */
export function parseToolDenylist(text: string): Record<string, string[]> {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('tool-denylist.json must be an object of agent group id → tool names');
  }
  const out: Record<string, string[]> = {};
  for (const [groupId, tools] of Object.entries(raw)) {
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string' && TOOL_NAME_RE.test(t))) {
      throw new Error(`tool-denylist.json: entry for ${groupId} must be a list of tool names`);
    }
    out[groupId] = [...new Set(tools as string[])];
  }
  return out;
}

/**
 * The tools switched off for one agent group; `[]` when the file is absent or the group is not
 * listed. `provider` is the group's provider (absent means the default, Claude).
 */
export function toolDenylistFor(agentGroupId: string, provider?: string, file = DENYLIST_PATH): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`tool-denylist.json is unreadable: ${(err as Error).message}`, { cause: err });
  }
  const tools = parseToolDenylist(text)[agentGroupId] ?? [];
  const effective = provider || 'claude';
  if (tools.length && !HONORING_PROVIDERS.has(effective)) {
    throw new Error(
      `tool-denylist.json lists tools for ${agentGroupId}, but its provider ${effective} cannot switch them off`,
    );
  }
  return tools;
}
