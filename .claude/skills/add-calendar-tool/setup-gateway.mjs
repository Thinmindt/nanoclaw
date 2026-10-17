#!/usr/bin/env node
// Configure the OneCLI gateway for the calendar tool. Safe to re-run.
//
// Reads ONECLI_URL and the CALENDAR_TOOL_* keys from the project's .env, then:
//   1. ensures a gateway agent with identifier CALENDAR_TOOL_GATEWAY_AGENT exists,
//   2. makes it selective with no stored secrets (it never needs the model key),
//   3. assigns it exactly one app connection: CALENDAR_TOOL_CONNECTION_ID,
//   4. publishes two policy rules for it: allow POST to the configured calendar's
//      events (path with the id raw and URL-encoded), then block everything else.
//
// Usage, from the NanoClaw project root:  node .claude/skills/add-calendar-tool/setup-gateway.mjs
// Undo:                                   node .claude/skills/add-calendar-tool/setup-gateway.mjs --remove
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
console.log(`published rules for ${identifier}: POST ${paths.join(' | ')}; everything else blocked`);
