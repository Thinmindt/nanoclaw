#!/usr/bin/env node
// Configure the OneCLI gateway for the GitHub status tool. Safe to re-run.
//
// Reads ONECLI_URL and the GITHUB_STATUS_* keys from the project's .env, then:
//   1. ensures a gateway agent with identifier GITHUB_STATUS_GATEWAY_AGENT exists,
//   2. makes it selective (it never gets the whole vault) with no app connections,
//   3. publishes its policy rules: allow GET on api.github.com under
//      /repos/<owner>/<repo>/ for each configured repository, rate-limited to
//      GITHUB_STATUS_RATE_LIMIT_PER_HOUR (default 300), then block everything else.
//
// It never touches the identity's secret list: public repositories need no token, and for private
// ones the operator assigns a read-only GitHub token to this identity in the OneCLI dashboard.
//
// Publishing makes the gateway's whole draft live, so the script refuses to run while the draft holds
// edits to rules it doesn't own (someone's unpublished dashboard work). Publish or discard those first,
// or pass --force to publish them along with this change.
//
// Written against OneCLI 1.42's REST API (agents, connections, policy).
//
// Usage, from the NanoClaw project root:  node .claude/skills/add-github-status/setup-gateway.mjs [--force]
// Undo:                                   node .claude/skills/add-github-status/setup-gateway.mjs --remove [--force]
import fs from 'node:fs';

const env = Object.fromEntries(
  fs
    .readFileSync('.env', 'utf-8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^['"]|['"]$/g, '')]),
);
const need = ['ONECLI_URL', 'GITHUB_STATUS_REPOS', 'GITHUB_STATUS_GATEWAY_AGENT'];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}
const base = env.ONECLI_URL.replace(/\/+$/, '');
const identifier = env.GITHUB_STATUS_GATEWAY_AGENT;

const repos = env.GITHUB_STATUS_REPOS.split(',')
  .map((e) => e.trim())
  .filter(Boolean)
  .map((e) => {
    const full = e.includes('=') ? e.slice(e.indexOf('=') + 1).trim() : e;
    const m = full.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/);
    if (!m) {
      console.error(`GITHUB_STATUS_REPOS entry "${e}" is not name=owner/repo`);
      process.exit(1);
    }
    return `${m[1]}/${m[2]}`;
  });
if (repos.length === 0) {
  console.error('GITHUB_STATUS_REPOS names no repository');
  process.exit(1);
}

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

const ALLOW = 'GitHub status tool: allow reading the configured repositories';
const DENY = 'GitHub status tool: default-deny everything else';
const OWN = new Set([ALLOW, DENY]);
const rateLimit = Number(env.GITHUB_STATUS_RATE_LIMIT_PER_HOUR || 300);
if (!Number.isInteger(rateLimit) || rateLimit < 1) {
  console.error('GITHUB_STATUS_RATE_LIMIT_PER_HOUR must be a whole number of at least 1');
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
  console.log(`removed the GitHub status tool's rules${agent ? ` and gateway agent ${identifier}` : ''}`);
  process.exit(0);
}

if (!agent) {
  await call('POST', '/v1/agents', { name: 'GitHub status tool', identifier });
  agent = (await listAgents()).find((a) => a.identifier === identifier);
  if (!agent) throw new Error(`gateway agent ${identifier} was not created`);
  console.log(`created gateway agent ${identifier}`);
}
await call('PATCH', `/v1/agents/${agent.id}/secret-mode`, { mode: 'selective' });
await call('PUT', `/v1/agents/${agent.id}/connections`, { connections: [] });
console.log(`agent ${identifier}: selective, no app connections (secrets left as assigned in the dashboard)`);

const identity = [{ type: 'agent', id: agent.id }];
const targets = repos.flatMap((r) =>
  ['GET'].map((method) => ({
    kind: 'network',
    hostPattern: 'api.github.com',
    pathPattern: `/repos/${r}/*`,
    method,
  })),
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
  targets,
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
  `published rules for ${identifier}: GET api.github.com /repos/{${repos.join(',')}}/* (max ${rateLimit}/hour); everything else blocked`,
);
