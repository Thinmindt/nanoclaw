/**
 * Read-only sites per seat, as OneCLI gateway rules. Safe to re-run.
 *
 * Reads the operator's vetted list from data/seat-sites.json:
 *
 *   { "seats": { "<agent-group-id>": { "label": "project-manager", "hosts": ["github.com"] } } }
 *
 * and, for each seat, keeps one gateway rule named `Seat sites: <label>`:
 * allow GET to exactly those hosts for that seat's gateway agent (its
 * identifier is the agent group id). Hosts are exact names: no wildcards,
 * schemes, ports, paths, IP addresses, or private names. Each redirect hop is
 * a new request through the gateway, so it is checked against the same rules.
 *
 * The seat rules sit at the top of the rule order, so an exact-host GET is
 * allowed for that seat whatever rules below would say; every other rule keeps
 * its place and its content. A seat not in the file, and every rule this
 * script does not own, is untouched; after publishing, the script re-reads
 * the published rules and fails if any of those changed.
 *
 * Default is a dry run: it prints each seat's current rules, the rule it would
 * write, and any existing rule that names one of the same hosts. `--apply`
 * writes and publishes. `--remove` deletes every `Seat sites:` rule.
 *
 * Publishing makes the gateway's whole draft live, so the script refuses while
 * the draft holds unpublished edits to rules it doesn't own, unless --force.
 *
 * Written against OneCLI 1.42's REST API (agents, policy rules), like the
 * calendar tool's gateway script.
 *
 * Usage, from the NanoClaw project root:
 *   pnpm exec tsx .claude/skills/add-seat-sites/scripts/seat-sites.ts [--apply | --remove] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';

export const RULE_PREFIX = 'Seat sites: ';

export interface Seat {
  groupId: string;
  label: string;
  hosts: string[];
}

export interface Rule {
  id?: string;
  name: string;
  action: string;
  enabled: boolean;
  requireApproval?: boolean;
  rateLimit?: number | null;
  rateLimitWindow?: string | null;
  priority?: number;
  identities: { type: string; id: string }[];
  targets: { kind: string; hostPattern?: string; pathPattern?: string; method?: string }[];
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Names that resolve inside a network, never on the public web. */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.home.arpa', '.localhost', '.corp', '.intranet'];

/** Why a host is refused, or null when it is an exact public host name. */
export function hostProblem(host: unknown): string | null {
  if (typeof host !== 'string') return 'not a string';
  if (host !== host.trim().toLowerCase()) return 'must be lowercase with no spaces';
  if (host.includes('*')) return 'wildcards are not allowed; name each host';
  if (/[/:@?#]/.test(host)) return 'a host name only: no scheme, port, path, or user';
  if (/^[0-9.]+$/.test(host)) return 'IP addresses are not allowed';
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return 'private network names are not allowed';
  if (!HOST_RE.test(host)) return 'not a valid public host name';
  return null;
}

/** Parse and validate data/seat-sites.json. Throws with every problem found. */
export function parseSeats(text: string): Seat[] {
  const raw = JSON.parse(text) as unknown;
  const seats = (raw as { seats?: unknown })?.seats;
  if (typeof seats !== 'object' || seats === null || Array.isArray(seats)) {
    throw new Error('seat-sites.json must be { "seats": { "<agent-group-id>": { "label": ..., "hosts": [...] } } }');
  }
  const problems: string[] = [];
  const out: Seat[] = [];
  const labels = new Set<string>();
  for (const [groupId, entry] of Object.entries(seats)) {
    const { label, hosts } = (entry ?? {}) as { label?: unknown; hosts?: unknown };
    if (typeof label !== 'string' || !LABEL_RE.test(label))
      problems.push(`${groupId}: label must be a short lowercase name`);
    else if (labels.has(label)) problems.push(`${groupId}: label ${label} is used twice`);
    else labels.add(label);
    if (!Array.isArray(hosts) || hosts.length === 0) {
      problems.push(`${groupId}: hosts must be a non-empty list`);
      continue;
    }
    for (const h of hosts) {
      const p = hostProblem(h);
      if (p) problems.push(`${groupId}: ${JSON.stringify(h)}: ${p}`);
    }
    out.push({ groupId, label: String(label), hosts: [...new Set(hosts as string[])].sort() });
  }
  if (problems.length) throw new Error(`seat-sites.json refused:\n  ${problems.join('\n  ')}`);
  return out;
}

/** The one rule a seat gets: allow GET to its hosts, for its gateway agent only. */
export function seatRule(seat: Seat, gatewayAgentId: string): Rule {
  return {
    name: RULE_PREFIX + seat.label,
    action: 'allow',
    enabled: true,
    requireApproval: false,
    identities: [{ type: 'agent', id: gatewayAgentId }],
    targets: seat.hosts.map((h) => ({ kind: 'network', hostPattern: h, method: 'GET' })),
  };
}

export const isOwned = (r: Rule): boolean => r.name.startsWith(RULE_PREFIX);

/** Everything that defines the effect of the rules this script does not own, in rule order. */
export function foreignFingerprint(rules: Rule[]): string {
  return JSON.stringify(
    [...rules]
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .filter((r) => !isOwned(r))
      .map((r) => [
        r.name,
        r.action,
        r.enabled,
        r.requireApproval,
        r.rateLimit,
        r.rateLimitWindow,
        r.identities,
        r.targets,
      ]),
  );
}

/** Rule order with the seat rules first (in seat order), every other rule after them in its old order. */
export function orderWithSeatsFirst(rules: Rule[], seatRuleNames: string[]): string[] {
  const sorted = [...rules].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const mine = seatRuleNames.map((n) => sorted.find((r) => r.name === n)).filter((r): r is Rule => !!r);
  const rest = sorted.filter((r) => !mine.includes(r));
  return [...mine, ...rest].map((r) => r.id as string);
}

/** Whether a rule's host pattern (`*` is any run of characters) covers a host. */
export function patternCovers(pattern: string, host: string): boolean {
  const escaped = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`, 'i').test(host);
}

/**
 * Existing rules for this agent (or for every agent) that cover one of the seat's hosts, and that
 * the seat rule, placed first, would override for GET. A bare `*` (the seat's catch-all) is expected
 * and not listed.
 */
export function overlapping(rules: Rule[], seat: Seat, gatewayAgentId: string): Rule[] {
  return rules.filter(
    (r) =>
      !isOwned(r) &&
      (r.identities.length === 0 || r.identities.some((i) => i.id === gatewayAgentId)) &&
      r.targets.some(
        (t) => t.hostPattern && t.hostPattern !== '*' && seat.hosts.some((h) => patternCovers(t.hostPattern!, h)),
      ),
  );
}

const describe = (r: Rule): string =>
  `${r.action}${r.enabled ? '' : ' (disabled)'} "${r.name}": ` +
  r.targets.map((t) => `${t.method ?? 'ANY'} ${t.hostPattern ?? '?'}${t.pathPattern ?? ''}`).join(', ');

function readEnv(root: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(root, '.env'), 'utf-8')
      .split('\n')
      .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2].trim().replace(/^['"]|['"]$/g, '')]),
  );
}

export async function main(argv: string[], root = '.', log: (line: string) => void = console.log): Promise<void> {
  const apply = argv.includes('--apply');
  const remove = argv.includes('--remove');
  const force = argv.includes('--force');
  const base = readEnv(root).ONECLI_URL?.replace(/\/+$/, '');
  if (!base) throw new Error('ONECLI_URL is missing from .env');

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  // OneCLI lists are a bare array or wrapped in { data: [...] }.
  const list = <T>(raw: unknown): T[] => (Array.isArray(raw) ? raw : ((raw as { data?: T[] })?.data ?? [])) as T[];
  const rules = async (status: 'draft' | 'published') =>
    list<Rule>(await call('GET', `/v1/policy/rules?status=${status}`));

  const published = await rules('published');
  const draftForeign = foreignFingerprint(await rules('draft'));
  if (!force && draftForeign !== foreignFingerprint(published)) {
    throw new Error(
      'The gateway policy has unpublished changes to other rules. Publishing would make them live too.\n' +
        'Publish or discard them in the OneCLI dashboard first, or re-run with --force to publish them as well.',
    );
  }
  // What the other rules must look like once published: as they are now, or, with --force, as drafted.
  const before = draftForeign;

  const publishAndCheck = async () => {
    await call('POST', '/v1/policy/publish', {});
    if (foreignFingerprint(await rules('published')) !== before) {
      throw new Error('Rules this script does not own changed after publishing. Check the OneCLI dashboard now.');
    }
  };

  if (remove) {
    for (const r of (await rules('draft')).filter(isOwned)) await call('DELETE', `/v1/policy/rules/${r.id}`);
    await publishAndCheck();
    log('removed every "Seat sites:" rule; other rules unchanged');
    return;
  }

  const seats = parseSeats(fs.readFileSync(path.join(root, 'data', 'seat-sites.json'), 'utf-8'));
  const agents = list<{ id: string; identifier: string; name?: string }>(await call('GET', '/v1/agents'));

  const planned: Rule[] = [];
  for (const seat of seats) {
    const agent = agents.find((a) => a.identifier === seat.groupId);
    if (!agent)
      throw new Error(`${seat.label}: no gateway agent with identifier ${seat.groupId}; has the group started once?`);
    const rule = seatRule(seat, agent.id);
    planned.push(rule);
    log(`\n== ${seat.label} (${seat.groupId}, gateway agent ${agent.name ?? agent.id})`);
    const current = published.filter((r) => r.identities.some((i) => i.id === agent.id));
    log(
      current.length ? current.map((r) => `   now:  ${describe(r)}`).join('\n') : '   now:  no rules name this agent',
    );
    log(`   plan: ${describe(rule)} (first in the rule order)`);
    for (const r of overlapping(published, seat, agent.id)) log(`   NOTE: shadows for GET: ${describe(r)}`);
  }
  const untouched = agents.filter((a) => !seats.some((s) => s.groupId === a.identifier));
  log(
    `\nUntouched: ${untouched.map((a) => a.name ?? a.identifier).join(', ') || 'none'}; no rule outside "Seat sites:" changes.`,
  );

  if (!apply) {
    log('\nDry run. Re-run with --apply to write and publish.');
    return;
  }
  try {
    for (const r of (await rules('draft')).filter(isOwned)) await call('DELETE', `/v1/policy/rules/${r.id}`);
    for (const r of planned) await call('POST', '/v1/policy/rules', r);
    const ids = orderWithSeatsFirst(
      await rules('draft'),
      planned.map((r) => r.name),
    );
    await call('PUT', '/v1/policy/rules/order', { orderedIds: ids });
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\nNothing was published, but the draft's "Seat sites:" rules may be half-written. ` +
        'Re-run with --apply to rewrite them, or discard the draft in the OneCLI dashboard.',
      { cause: err },
    );
  }
  await publishAndCheck();
  log(`\npublished ${planned.length} seat rule(s); other rules unchanged`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
