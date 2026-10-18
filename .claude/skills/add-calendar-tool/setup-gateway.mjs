#!/usr/bin/env node
// Configure the OneCLI gateway for the calendar tool. Safe to re-run.
//
// Reads ONECLI_URL and the CALENDAR_TOOL_* keys from the project's .env, then:
//   1. ensures a gateway agent with identifier CALENDAR_TOOL_GATEWAY_AGENT exists,
//   2. makes it selective with no stored secrets (it never needs the model key),
//   3. assigns it exactly one app connection: CALENDAR_TOOL_CONNECTION_ID,
//   4. publishes two policy rules for it: allow POST to the configured calendar's
//      events (path with the id raw and URL-encoded), rate-limited to
//      CALENDAR_TOOL_RATE_LIMIT_PER_HOUR (default 20), then block everything else.
//
// Publishing makes the gateway's whole draft live, so the script refuses to run while the draft holds
// edits to rules it doesn't own (someone's unpublished dashboard work). Publish or discard those first,
// or pass --force to publish them along with this change.
//
// Written against OneCLI 1.42's REST API (agents, secrets, connections, policy). OneCLI 1.43+ removes the
// agent secret-assignment API, so re-check this script before upgrading OneCLI past the pin.
//
// Usage, from the NanoClaw project root:  node .claude/skills/add-calendar-tool/setup-gateway.mjs [--force]
// Undo:                                   node .claude/skills/add-calendar-tool/setup-gateway.mjs --remove [--force]
import fs from 'node:fs';

const env = Object.fromEntries(
  fs
    .readFileSync('.env', 'utf-8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^['"]|['"]$/g, '')]),
);
const need = ['ONECLI_URL', 'CALENDAR_TOOL_CALENDAR_ID', 'CALENDAR_TOOL_CONNECTION_ID', 'CALENDAR_TOOL_GATEWAY_AGENT'];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}
const base = env.ONECLI_URL.replace(/\/+$/, '');
const calendarId = env.CALENDAR_TOOL_CALENDAR_ID;
const identifier = env.CALENDAR_TOOL_GATEWAY_AGENT;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const listAgents = async () => {
  const d = await call('GET', '/v1/agents');
  return Array.isArray(d) ? d : (d.data ?? []);
};

const ALLOW = 'Calendar tool: allow creating events on the configured calendar';
const DENY = 'Calendar tool: default-deny everything else';
const OWN = new Set([ALLOW, DENY]);
const rateLimit = Number(env.CALENDAR_TOOL_RATE_LIMIT_PER_HOUR || 20);
if (!Number.isInteger(rateLimit) || rateLimit < 1) {
  console.error('CALENDAR_TOOL_RATE_LIMIT_PER_HOUR must be a whole number of at least 1');
  process.exit(1);
}

// Everything that defines a rule's effect, in rule order, for rules this script doesn't own.
async function foreignRules(status) {
  const rules = (await call('GET', `/v1/policy/rules?status=${status}`)).sort((a, b) => a.priority - b.priority);
  return JSON.stringify(
    rules
      .filter((r) => !OWN.has(r.name))
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
if (!process.argv.includes('--force') && (await foreignRules('draft')) !== (await foreignRules('published'))) {
  console.error(
    'The gateway policy has unpublished changes to other rules. Publishing would make them live too.\n' +
      'Publish or discard them in the OneCLI dashboard first, or re-run with --force to publish them as well.',
  );
  process.exit(1);
}

let agent = (await listAgents()).find((a) => a.identifier === identifier);

if (process.argv.includes('--remove')) {
  const rules = await call('GET', '/v1/policy/rules?status=draft');
  for (const r of rules.filter((r) => r.name === ALLOW || r.name === DENY)) {
    await call('DELETE', `/v1/policy/rules/${r.id}`);
  }
  await call('POST', '/v1/policy/publish', {});
  if (agent) await call('DELETE', `/v1/agents/${agent.id}`);
  console.log(`removed the calendar tool's rules${agent ? ` and gateway agent ${identifier}` : ''}`);
  process.exit(0);
}

if (!agent) {
  await call('POST', '/v1/agents', { name: 'Calendar event tool', identifier });
  agent = (await listAgents()).find((a) => a.identifier === identifier);
  if (!agent) throw new Error(`gateway agent ${identifier} was not created`);
  console.log(`created gateway agent ${identifier}`);
}
await call('PATCH', `/v1/agents/${agent.id}/secret-mode`, { mode: 'selective' });
await call('PUT', `/v1/agents/${agent.id}/secrets`, { secretIds: [] });
await call('PUT', `/v1/agents/${agent.id}/connections`, {
  connections: [{ appConnectionId: env.CALENDAR_TOOL_CONNECTION_ID }],
});
console.log(`agent ${identifier}: selective, no secrets, one connection`);

const identity = [{ type: 'agent', id: agent.id }];
const paths = [...new Set([calendarId, encodeURIComponent(calendarId)])].map(
  (c) => `/calendar/v3/calendars/${c}/events`,
);

const draft = await call('GET', '/v1/policy/rules?status=draft');
for (const r of draft.filter((r) => r.name === ALLOW || r.name === DENY)) {
  await call('DELETE', `/v1/policy/rules/${r.id}`);
}
await call('POST', '/v1/policy/rules', {
  name: ALLOW,
  action: 'allow',
  enabled: true,
  requireApproval: false,
  rateLimit,
  rateLimitWindow: 'hour',
  identities: identity,
  targets: paths.map((p) => ({ kind: 'network', hostPattern: 'www.googleapis.com', pathPattern: p, method: 'POST' })),
});
await call('POST', '/v1/policy/rules', {
  name: DENY,
  action: 'block',
  enabled: true,
  requireApproval: false,
  identities: identity,
  targets: [{ kind: 'network', hostPattern: '*' }],
});

// The allow must sit above the deny; keep every other rule where it was.
const ordered = (await call('GET', '/v1/policy/rules?status=draft')).sort((a, b) => a.priority - b.priority);
const mine = [ALLOW, DENY].map((n) => ordered.find((r) => r.name === n));
const rest = ordered.filter((r) => !mine.includes(r));
await call('PUT', '/v1/policy/rules/order', { orderedIds: [...rest, ...mine].map((r) => r.id) });
await call('POST', '/v1/policy/publish', {});
console.log(
  `published rules for ${identifier}: POST ${paths.join(' | ')} (max ${rateLimit}/hour); everything else blocked`,
);
