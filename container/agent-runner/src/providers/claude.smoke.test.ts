/**
 * The pinned Claude CLI, driven through the runner's own SDK call in bypass
 * mode, against a stub model on loopback that records every request. A marker
 * counts as "loaded" when its text appears in a request the CLI sends to the
 * model; the controls use the same reading.
 *
 * Runs only inside the agent image, with CLAUDE_SMOKE=1 and no network.
 * CLAUDE_SMOKE_CONTROL=1 runs the same file against a runner from before the
 * change, which still hands extra mounts to the CLI as added directories.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import '../provider-contracts/index.js';
import { registerProviderMemorySessionHook } from '../provider-contracts/realize.js';
import { createProvider } from './factory.js';
import './index.js';

const control = process.env.CLAUDE_SMOKE_CONTROL === '1';
// Everything the test writes is under `root`, never a seat's /workspace/agent,
// and nothing touches the disk or the network until the gated suite's beforeAll.
const root = path.join(os.tmpdir(), `claude-smoke-${process.pid}`);
const cwd = path.join(root, 'agent');
const mount = path.join(root, 'extra', 'shared');
/** The production hook, pointed at the test's working folder instead of /workspace/agent. */
const memoryHook = { ...MEMORY_SESSION_HOOK, command: `${MEMORY_SESSION_HOOK.command} ${cwd}` };
const MEMORY_MARKER = 'MARKER_MEMORY_CONTEXT';

// ── the stub model ──

type Body = { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> };
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

let requests: string[] = [];
let script: Array<{ name: string; input: unknown }> = [];

function sse(blocks: Block[], stopReason: string): string {
  const events: unknown[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'claude-stub',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  events.push({ type: 'message_stop' });
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** The next scripted tool call is chosen by how many tool calls the conversation already holds. */
function reply(body: Body): Response {
  const toolCalls = (body.messages ?? [])
    .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m) => m.content as Array<{ type: string }>)
    .filter((b) => b.type === 'tool_use').length;
  const main = body.tools?.some((t) => t.name === 'Read');
  const step = main ? script[toolCalls] : undefined;
  const blocks: Block[] = step
    ? [{ type: 'tool_use', id: `toolu_${toolCalls}`, name: step.name, input: step.input }]
    : [{ type: 'text', text: 'done' }];
  return new Response(sse(blocks, step ? 'tool_use' : 'end_turn'), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

let server: ReturnType<typeof Bun.serve>;

function serveStub(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/messages') return Response.json({});
      const text = await request.text();
      requests.push(text);
      return reply(JSON.parse(text) as Body);
    },
  });
}

// ── the plants ──

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * An instruction file, skill, command and subagent at `dir`, each carrying
 * `MARKER_<tag>_<KIND>`, as Write tool calls: a seat plants them itself.
 */
function fourPlants(dir: string, tag: string) {
  const markers = {
    instruction: `MARKER_${tag}_INSTRUCTION`,
    skill: `MARKER_${tag}_SKILL`,
    command: `MARKER_${tag}_COMMAND`,
    subagent: `MARKER_${tag}_SUBAGENT`,
  };
  const lower = tag.toLowerCase();
  const files = [
    [path.join(dir, 'CLAUDE.md'), `${markers.instruction}\n`],
    [
      path.join(dir, '.claude', 'skills', `${lower}-skill`, 'SKILL.md'),
      `---\nname: ${lower}-skill\ndescription: ${markers.skill}\n---\n\nBody.\n`,
    ],
    [
      path.join(dir, '.claude', 'commands', `${lower}-command.md`),
      `---\ndescription: ${markers.command}\n---\n\nBody.\n`,
    ],
    [
      path.join(dir, '.claude', 'agents', `${lower}-agent.md`),
      `---\nname: ${lower}-agent\ndescription: ${markers.subagent}\n---\n\nBody.\n`,
    ],
  ];
  const writes = files.map(([file_path, content]) => ({ name: 'Write', input: { file_path, content } }));
  return { markers, writes };
}

const top = fourPlants(mount, 'TOP');
const down = fourPlants(path.join(mount, 'sub'), 'DOWN');
// Control (ii): loading on touch below the working directory.
const nested = { instruction: 'MARKER_NESTED_INSTRUCTION', skill: 'MARKER_NESTED_SKILL' };
const BESIDE = 'BESIDE_FILE_CONTENT';

function writeFixtures(): void {
  write(path.join(mount, 'data.txt'), 'before\n');
  write(path.join(mount, 'sub', 'data.txt'), 'down\n');
  write(path.join(cwd, 'nested', 'CLAUDE.md'), `${nested.instruction}\n`);
  write(
    path.join(cwd, 'nested', '.claude', 'skills', 'nested-skill', 'SKILL.md'),
    `---\nname: nested-skill\ndescription: ${nested.skill}\n---\n\nBody.\n`,
  );
  write(path.join(cwd, 'nested', 'beside.txt'), `${BESIDE}\n`);
  write(path.join(cwd, 'memory', 'index.md'), `# Memory Index\n\n${MEMORY_MARKER}\n`);
  write(path.join(cwd, 'memory', 'system', 'definition.md'), '# Definition\n');
}

// The session touches the nested folder, then reads, edits and writes in the
// mount and one folder down with the file tools, and views and writes with the shell.
const touchScript = [
  { name: 'Read', input: { file_path: path.join(cwd, 'nested', 'beside.txt') } },
  { name: 'Read', input: { file_path: path.join(mount, 'data.txt') } },
  { name: 'Edit', input: { file_path: path.join(mount, 'data.txt'), old_string: 'before', new_string: 'edited' } },
  { name: 'Write', input: { file_path: path.join(mount, 'written.txt'), content: 'written\n' } },
  { name: 'Read', input: { file_path: path.join(mount, 'sub', 'data.txt') } },
  {
    name: 'Edit',
    input: { file_path: path.join(mount, 'sub', 'data.txt'), old_string: 'down', new_string: 'down edited' },
  },
  { name: 'Write', input: { file_path: path.join(mount, 'sub', 'written.txt'), content: 'written\n' } },
  {
    name: 'Bash',
    input: {
      command: `cat ${mount}/data.txt ${mount}/sub/data.txt && echo shell > ${mount}/shell.txt`,
      description: 'view',
    },
  },
];

// ── one session ──

/** Settings as a seat had them before the change: the added-directory instruction switch on. */
const SEAT_SETTINGS = JSON.stringify({
  autoMemoryEnabled: false,
  env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
});

/** A seat's home: its own Claude config folder. */
function newSeat(settings = SEAT_SETTINGS): string {
  const home = fs.mkdtempSync(path.join(root, 'seat-'));
  fs.writeFileSync(path.join(home, 'settings.json'), settings);
  return home;
}

async function session(
  prompts: string[],
  steps: typeof script,
  home = newSeat(),
  continuation?: string,
): Promise<{ requests: string[]; results: Array<{ isError?: boolean }>; continuation?: string }> {
  requests = [];
  script = steps;
  const provider = createProvider('claude', {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_API_KEY: 'stub',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    // Read only by the runner from before the change.
    ...({ additionalDirectories: [mount] } as object),
  });
  const previousHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  registerProviderMemorySessionHook('claude', provider, memoryHook);
  process.env.CLAUDE_CONFIG_DIR = previousHome;

  const query = provider.query({ prompt: prompts[0], cwd, continuation });
  const results: Array<{ isError?: boolean }> = [];
  for await (const event of query.events) {
    if (event.type === 'init') continuation = event.continuation;
    if (event.type !== 'result') continue;
    results.push(event);
    if (results.length === prompts.length) break;
    query.push(prompts[results.length]);
  }
  query.end();
  query.abort();
  return { requests: [...requests], results, continuation };
}

const loaded = (bodies: string[], marker: string) => bodies.some((b) => b.includes(marker));
const occurrences = (body: string, marker: string) => body.split(marker).length - 1;
/** The first request carrying `prompt` as user text. */
const requestFor = (bodies: string[], prompt: string) => bodies.find((b) => b.includes(prompt))!;

(process.env.CLAUDE_SMOKE === '1' ? describe : describe.skip)('pinned Claude CLI through the runner', () => {
  const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR;
  beforeAll(() => {
    writeFixtures();
    server = serveStub();
    // Compaction archives the conversation; keep that under `root` too.
    process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(root, 'conversations');
  });
  afterAll(() => {
    if (conversationsDir === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
    else process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    server.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads nothing from an extra mount; files there are still read, edited and written (3a)', async () => {
    // The planting seat writes the eight plants with its own Write tool.
    const planter = newSeat();
    const planted = await session(['PLANT'], [...top.writes, ...down.writes], planter);
    expect(planted.results[0].isError).toBeFalsy();
    expect(fs.readFileSync(path.join(mount, 'CLAUDE.md'), 'utf-8')).toBe(`${top.markers.instruction}\n`);

    for (const [seat, home] of [
      ['another seat', newSeat()],
      ['the planting seat, next session', planter],
    ]) {
      const { requests: bodies, results } = await session(['LAUNCH'], touchScript, home);
      expect(results[0].isError).toBeFalsy();
      const launch = requestFor(bodies, 'LAUNCH');
      const afterTouch = bodies.slice(bodies.indexOf(requestFor(bodies, BESIDE)));

      // (ii) the touch control: absent at launch, loaded once the session reads beside them.
      for (const marker of Object.values(nested)) {
        expect([seat, marker, loaded([launch], marker), loaded(afterTouch, marker)]).toEqual([
          seat,
          marker,
          false,
          true,
        ]);
      }
      // (i) the control loads the four at the top at launch; (iii) with the change, no request carries them.
      for (const [kind, marker] of Object.entries(top.markers)) {
        expect([seat, kind, loaded(control ? [launch] : bodies, marker)]).toEqual([seat, kind, control]);
      }
      // (iv) one folder down: recorded under the control, none loaded with the change.
      for (const [kind, marker] of Object.entries(down.markers)) {
        if (control) console.log(`control, one folder down, ${kind}: loaded=${loaded(bodies, marker)}`);
        else expect([seat, kind, loaded(bodies, marker)]).toEqual([seat, kind, false]);
      }
      // (v) the file tools and the shell reached the mount with no denial.
      expect(bodies.some((b) => b.includes('"is_error":true'))).toBe(false);
      expect(fs.readFileSync(path.join(mount, 'data.txt'), 'utf-8')).toBe('edited\n');
      expect(fs.readFileSync(path.join(mount, 'written.txt'), 'utf-8')).toBe('written\n');
      expect(fs.readFileSync(path.join(mount, 'shell.txt'), 'utf-8')).toBe('shell\n');
      expect(loaded(bodies, 'down\\n')).toBe(true);
      expect(fs.readFileSync(path.join(mount, 'sub', 'data.txt'), 'utf-8')).toBe('down edited\n');
      fs.writeFileSync(path.join(mount, 'data.txt'), 'before\n');
      fs.writeFileSync(path.join(mount, 'sub', 'data.txt'), 'down\n');
    }
  }, 180_000);

  // In production /clear is the runner dropping the continuation, so the next
  // query is a startup. /compact dispatches only as a resumed query's first
  // input, the way the poll loop sends it.
  it('brings memory context once at startup and once after compaction (criterion 1)', async () => {
    const home = newSeat();
    const first = await session(['FIRST_PROMPT'], [], home);
    expect(occurrences(requestFor(first.requests, 'FIRST_PROMPT'), MEMORY_MARKER)).toBe(1);

    const { requests: bodies } = await session(['/compact', 'AFTER_COMPACT'], [], home, first.continuation);
    const after = requestFor(bodies, 'AFTER_COMPACT');
    expect(after.includes('FIRST_PROMPT')).toBe(false);
    expect(occurrences(after, MEMORY_MARKER)).toBe(1);
  }, 180_000);

  it('completes a turn with a corrupt user settings file (criterion 2)', async () => {
    const { results } = await session(['CORRUPT'], [], newSeat('{"hooks":'));
    expect(results[0].isError).toBeFalsy();
  }, 120_000);
});
