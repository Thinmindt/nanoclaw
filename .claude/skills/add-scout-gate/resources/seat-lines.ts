/**
 * `ncl seat-lines`: every seat-to-seat line and what the a2a.send guard does with it. Installed by the
 * add-scout-gate skill. Operator-only, and read-only: it reads the lines, the message policies and the
 * Scout gate's own gated test, and writes nothing.
 *
 * The guard (`src/modules/agent-to-agent/guard.ts`) decides on a whole message, so the listing cannot call
 * it. It calls the same two lookups instead, `getMessagePolicy` and the gate's `gatedGroup`, and puts them
 * together itself. `seat-lines.test.ts` puts each case through both; it is the alarm if the
 * two drift apart.
 */
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { gatedGroup } from '../../modules/a2a-gate/index.js';
import { getMessagePolicy } from '../../modules/agent-to-agent/db/agent-message-policies.js';
import { register } from '../registry.js';

interface LineFacts {
  self: boolean;
  targetExists: boolean;
  policy: boolean;
  gated: boolean;
}

export interface SeatLine {
  from: string;
  to: string;
  decision: string;
}

/**
 * The decision on a pair that has a line: self first, then missing target, policy, gated target. The guard
 * checks a missing target before self; the outcome is the same, since a line's source is always a seat
 * (agent_destinations.agent_group_id references agent_groups).
 */
function lineDecision(facts: LineFacts): string {
  if (facts.self) return 'free flow, self';
  if (!facts.targetExists) return 'refused, no such seat';
  if (facts.policy) return 'held';
  if (facts.gated) return 'refused';
  return 'free flow';
}

/** One row per from/to pair with an agent line, by seat name; the folder where names repeat, the raw id where there is no seat. */
export async function listSeatLines(): Promise<SeatLine[]> {
  const groups = new Map((await getAllAgentGroups()).map((g) => [g.id, g]));
  const named = new Map<string, number>();
  for (const g of groups.values()) named.set(g.name, (named.get(g.name) ?? 0) + 1);
  const label = (id: string) => {
    const g = groups.get(id);
    if (!g) return id;
    return named.get(g.name)! > 1 ? `${g.name} (${g.folder})` : g.name;
  };

  const pairs = await getDb().all<{ from_id: string; to_id: string }>(
    "SELECT DISTINCT agent_group_id AS from_id, target_id AS to_id FROM agent_destinations WHERE target_type = 'agent'",
  );
  const lines: SeatLine[] = [];
  for (const { from_id, to_id } of pairs) {
    const decision = lineDecision({
      self: from_id === to_id,
      targetExists: groups.has(to_id),
      policy: (await getMessagePolicy(from_id, to_id)) !== undefined,
      gated: (await gatedGroup(to_id)).gated,
    });
    lines.push({ from: label(from_id), to: label(to_id), decision });
  }
  return lines.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

register({
  name: 'seat-lines',
  access: 'open',
  hostOnly: true,
  description:
    'Every seat-to-seat line, one row per from/to pair: from, to, decision (held, refused, or free flow). ' +
    '"held" on a line into the Scout means held if the message passes the Scout gate\'s content check; with ' +
    "the gate's term lists unreadable, every message on that line is refused. " +
    'A policy with no line is not listed; that pair cannot send. `ncl policies list` shows it. Operator-only.',
  parseArgs: (raw) => raw,
  handler: async () => listSeatLines(),
  formatHuman: (rows) =>
    ['from\tto\tdecision', ...(rows as SeatLine[]).map((r) => `${r.from}\t${r.to}\t${r.decision}`)].join('\n'),
});
