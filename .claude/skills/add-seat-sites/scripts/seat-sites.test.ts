/**
 * The seat-sites script against a fake OneCLI policy API: the list is
 * validated strictly, a dry run writes nothing, --apply puts one exact-host
 * GET rule per seat first in the order and leaves every other rule alone, and
 * --remove takes only its own rules out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hostProblem, main, parseSeats, patternCovers, type Rule } from './seat-sites.js';

describe('hostProblem', () => {
  it('accepts exact public host names', () => {
    for (const h of ['github.com', 'api.github.com', 'en.wikipedia.org', 'www.example.co.uk']) {
      expect(hostProblem(h)).toBeNull();
    }
  });

  it('refuses wildcards, URLs, ports, IPs, private names, and odd spellings', () => {
    for (const h of [
      '*.github.com',
      'github.*',
      'https://github.com',
      'github.com/x',
      'github.com:443',
      '10.0.0.1',
      '192.168.1.10',
      '::1',
      'nas.local',
      'printer.lan',
      'router.home.arpa',
      'localhost',
      'GitHub.com',
      ' github.com',
      'github',
      '',
      7,
    ]) {
      expect(hostProblem(h), String(h)).not.toBeNull();
    }
  });
});

describe('patternCovers', () => {
  it('matches exact names and * runs, nothing else', () => {
    expect(patternCovers('github.com', 'github.com')).toBe(true);
    expect(patternCovers('*.github.com', 'api.github.com')).toBe(true);
    expect(patternCovers('*.github.com', 'github.com')).toBe(false);
    expect(patternCovers('github.com', 'githubXcom')).toBe(false);
  });
});

describe('parseSeats', () => {
  it('reads seats, dedupes and sorts hosts', () => {
    expect(parseSeats('{"seats":{"ag-1":{"label":"pm","hosts":["b.org","a.org","b.org"]}}}')).toEqual([
      { groupId: 'ag-1', label: 'pm', hosts: ['a.org', 'b.org'] },
    ]);
  });

  it('refuses the whole file on any bad entry, naming each problem', () => {
    expect(() =>
      parseSeats('{"seats":{"ag-1":{"label":"pm","hosts":["*.org"]},"ag-2":{"label":"pm","hosts":[]}}}'),
    ).toThrow(/ag-1.*wildcards[\s\S]*ag-2: label pm is used twice[\s\S]*ag-2: hosts must be/);
    expect(() => parseSeats('{"ag-1":{}}')).toThrow();
  });
});

// A fake OneCLI 1.42 policy API: draft and published rule sets, agents, publish.
function fakeGateway(initial: Rule[]) {
  let draft: Rule[] = initial.map((r, i) => ({ ...r, id: r.id ?? `r${i}`, priority: i }));
  let published: Rule[] = structuredClone(draft);
  let next = 100;
  const agents = [
    { id: 'gw-pm', identifier: 'ag-pm', name: 'Project Manager' },
    { id: 'gw-scout', identifier: 'ag-scout', name: 'Scout' },
  ];
  const handler = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (v: unknown) => new Response(v === null ? '' : JSON.stringify(v), { status: 200 });
    const method = init?.method ?? 'GET';
    if (method === 'GET' && u.pathname === '/v1/agents') return ok(agents);
    if (method === 'GET' && u.pathname === '/v1/policy/rules') {
      return ok(structuredClone(u.searchParams.get('status') === 'draft' ? draft : published));
    }
    if (method === 'POST' && u.pathname === '/v1/policy/rules') {
      draft.push({ ...body, id: `r${next}`, priority: next++ });
      return ok(null);
    }
    if (method === 'DELETE' && u.pathname.startsWith('/v1/policy/rules/')) {
      draft = draft.filter((r) => r.id !== u.pathname.split('/').pop());
      return ok(null);
    }
    if (method === 'PUT' && u.pathname === '/v1/policy/rules/order') {
      draft = (body.orderedIds as string[]).map((id, i) => ({ ...draft.find((r) => r.id === id)!, priority: i }));
      return ok(null);
    }
    if (method === 'POST' && u.pathname === '/v1/policy/publish') {
      published = structuredClone(draft);
      return ok(null);
    }
    return new Response('nope', { status: 404 });
  };
  return {
    handler,
    get published() {
      return published;
    },
    editDraft: (f: (d: Rule[]) => void) => f(draft),
  };
}

const steward: Rule = {
  name: 'Steward: block everything else',
  action: 'block',
  enabled: true,
  identities: [{ type: 'agent', id: 'gw-steward' }],
  targets: [{ kind: 'network', hostPattern: '*' }],
};
const scoutOpen: Rule = {
  name: 'Scout: open GET',
  action: 'allow',
  enabled: true,
  identities: [{ type: 'agent', id: 'gw-scout' }],
  targets: [{ kind: 'network', hostPattern: '*', method: 'GET' }],
};
const pmDeny: Rule = {
  name: 'PM: block everything else',
  action: 'block',
  enabled: true,
  identities: [{ type: 'agent', id: 'gw-pm' }],
  targets: [{ kind: 'network', hostPattern: '*' }],
};

let root: string;
let gw: ReturnType<typeof fakeGateway>;
const lines: string[] = [];
const run = (...argv: string[]) => main(argv, root, (l) => lines.push(l));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-sites-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, '.env'), 'ONECLI_URL=http://gw.test/\n');
  fs.writeFileSync(
    path.join(root, 'data', 'seat-sites.json'),
    JSON.stringify({ seats: { 'ag-pm': { label: 'project-manager', hosts: ['github.com', 'en.wikipedia.org'] } } }),
  );
  gw = fakeGateway([scoutOpen, steward, pmDeny]);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => gw.handler(url, init)),
  );
  lines.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

const names = () => [...gw.published].sort((a, b) => a.priority! - b.priority!).map((r) => r.name);

describe('seat-sites main', () => {
  it('dry run prints the plan and writes nothing', async () => {
    const before = structuredClone(gw.published);
    await run();
    expect(gw.published).toEqual(before);
    const out = lines.join('\n');
    expect(out).toContain('plan: allow "Seat sites: project-manager": GET en.wikipedia.org, GET github.com');
    expect(out).toContain('now:  block "PM: block everything else"');
    expect(out).toContain('Untouched: Scout');
    expect(out).toContain('Dry run');
  });

  it('--apply puts the seat rule first and leaves the other rules as they were', async () => {
    await run('--apply');
    expect(names()).toEqual([
      'Seat sites: project-manager',
      'Scout: open GET',
      'Steward: block everything else',
      'PM: block everything else',
    ]);
    const mine = gw.published.find((r) => r.name === 'Seat sites: project-manager')!;
    expect(mine.identities).toEqual([{ type: 'agent', id: 'gw-pm' }]);
    expect(mine.targets).toEqual([
      { kind: 'network', hostPattern: 'en.wikipedia.org', method: 'GET' },
      { kind: 'network', hostPattern: 'github.com', method: 'GET' },
    ]);
    const scout = gw.published.find((r) => r.name === 'Scout: open GET')!;
    expect(scout.targets).toEqual(scoutOpen.targets);
  });

  it('re-running replaces its own rule rather than adding a second', async () => {
    await run('--apply');
    await run('--apply');
    expect(names().filter((n) => n.startsWith('Seat sites:'))).toEqual(['Seat sites: project-manager']);
  });

  it('refuses while the draft holds unpublished edits to other rules', async () => {
    gw.editDraft((d) => d.push({ ...steward, id: 'x', name: 'half-finished', priority: 50 }));
    await expect(run('--apply')).rejects.toThrow(/unpublished changes/);
    expect(names()).not.toContain('Seat sites: project-manager');
  });

  it('--force publishes pending edits to other rules along with its own, without a false alarm', async () => {
    gw.editDraft((d) => d.push({ ...steward, id: 'x', name: 'half-finished', priority: 50 }));
    await run('--apply', '--force');
    expect(names()).toContain('half-finished');
    expect(names()[0]).toBe('Seat sites: project-manager');
  });

  it('notes an existing rule whose wildcard covers a seat host', async () => {
    gw.editDraft((d) =>
      d.push({
        ...pmDeny,
        id: 'w',
        name: 'PM: no wiki',
        priority: 60,
        targets: [{ kind: 'network', hostPattern: '*.wikipedia.org' }],
      }),
    );
    await run('--apply', '--force');
    lines.length = 0;
    await run();
    expect(lines.join('\n')).toContain('NOTE: shadows for GET: block "PM: no wiki"');
  });

  it('refuses a seat whose group has no gateway agent', async () => {
    fs.writeFileSync(
      path.join(root, 'data', 'seat-sites.json'),
      JSON.stringify({ seats: { 'ag-missing': { label: 'steward', hosts: ['en.wiktionary.org'] } } }),
    );
    await expect(run('--apply')).rejects.toThrow(/no gateway agent/);
  });

  it('--remove deletes only its own rules', async () => {
    await run('--apply');
    await run('--remove');
    expect(names()).toEqual(['Scout: open GET', 'Steward: block everything else', 'PM: block everything else']);
  });
});
