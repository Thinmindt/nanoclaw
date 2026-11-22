import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type AppServer,
  type JsonRpcNotification,
  initializeCodexAppServer,
  killCodexAppServer,
  sendCodexRequest,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  writeCodexConfigToml,
} from './codex-app-server.js';

const cwd = '/workspace/agent';

/** Spawn the app-server, start a thread and a turn, and return the sources of the hooks that ran. */
async function hooksRunAtFirstTurn(): Promise<string[]> {
  const server = spawnCodexAppServer();
  try {
    const hookSources: string[] = [];
    const firstItem = new Promise<void>((resolve) => {
      server.notificationHandlers.push((n: JsonRpcNotification) => {
        if (n.method === 'hook/started') hookSources.push((n.params?.run as { sourcePath: string }).sourcePath);
        if (n.method === 'item/started') resolve();
      });
    });

    await initializeCodexAppServer(server);
    const threadId = await startOrResumeCodexThread(server, undefined, { cwd });
    await startCodexTurn(server, { threadId, inputText: 'hello', cwd });
    await firstItem;
    return hookSources;
  } finally {
    killCodexAppServer(server);
  }
}

// The workflow runs this file twice: on the image as built, which pins these switches off
// (codex-requirements.toml), and with codex-requirements.control.toml mounted over the pin.
const control = Boolean(process.env.CODEX_SMOKE_CONTROL);
const PINNED = [
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_full_cdp_access',
  'browser_use_external',
  'computer_use',
  'memories',
];
const pinnedOf = (values: Record<string, unknown>) => Object.fromEntries(PINNED.map((key) => [key, values[key]]));
const allOff = Object.fromEntries(PINNED.map((key) => [key, false]));
// A value the runner's own config sets to 32768, so 31337 reads back only from a planted file.
const MARKER = 'project_doc_max_bytes = 31337';
// Where Codex calls the ChatGPT apps server, under chatgpt_base_url.
const APPS_PATH = '/backend-api/ps/mcp';
// How long a case watches for that call after its first turn starts. The control's
// calls came about 30 ms after the start on the first runs.
const CALL_WAIT_MS = 5_000;

async function request(server: AppServer, method: string, params: Record<string, unknown>): Promise<any> {
  const response = await sendCodexRequest(server, method, params);
  if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
  return response.result;
}

/** Codex's own enablement of every feature for the thread, all pages read. */
async function enabledFeatures(server: AppServer, threadId: string): Promise<Record<string, boolean>> {
  const features: Array<{ name: string; enabled: boolean }> = [];
  let cursor: string | null = null;
  do {
    const page = await request(server, 'experimentalFeature/list', { threadId, cursor });
    features.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  const enabled = Object.fromEntries(features.map((f) => [f.name, f.enabled]));
  // A feature known to be on, so a read that lists nothing cannot pass for "off".
  if (enabled.image_generation !== true) throw new Error(`image_generation is not on in ${JSON.stringify(features)}`);
  return enabled;
}

/**
 * Start a new conversation in a fresh Codex home, with `planted` as the project config file
 * of the working folder or of the folder above it, through the start of the first turn, and
 * read back what Codex made of it. A ChatGPT login of made-up tokens, with chatgpt_base_url
 * pointed at a local stub, lets the apps call be seen offline.
 */
async function startConversation(planted: string | null, folder: 'working' | 'above' = 'working') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-case-'));
  const session = path.join(root, 'session');
  const workdir = path.join(session, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  if (planted) {
    // Codex reads a project file above the working folder only up to a repository root.
    if (folder === 'above') execFileSync('git', ['init', '-q', session]);
    const projectDir = path.join(folder === 'working' ? workdir : session, '.codex');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'config.toml'), planted);
  }

  const calls: string[] = [];
  const stub = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      calls.push(new URL(req.url).pathname);
      return new Response('{}', { status: 404 });
    },
  });
  const home = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  writeCodexConfigToml({});
  const codexHome = path.join(process.env.HOME, '.codex');
  const config = path.join(codexHome, 'config.toml');
  fs.writeFileSync(
    config,
    `chatgpt_base_url = "http://127.0.0.1:${stub.port}/backend-api/"\n${fs.readFileSync(config, 'utf8')}`,
  );
  const token = [{ alg: 'none' }, { exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: `${token}.x`, access_token: `${token}.x`, refresh_token: 'x', account_id: 'acct' },
      last_refresh: new Date().toISOString(),
    }),
  );

  const server = spawnCodexAppServer();
  try {
    const warnings: string[] = [];
    server.notificationHandlers.push((n: JsonRpcNotification) => {
      if (n.method === 'configWarning') warnings.push(n.params?.summary as string);
    });
    await initializeCodexAppServer(server);
    const threadId = await startOrResumeCodexThread(server, undefined, { cwd: workdir });
    await startCodexTurn(server, { threadId, inputText: 'hello', cwd: workdir });
    await new Promise((resolve) => setTimeout(resolve, CALL_WAIT_MS));

    const { config: read } = await request(server, 'config/read', { cwd: workdir });
    const result = {
      marker: read.project_doc_max_bytes,
      enabled: await enabledFeatures(server, threadId),
      requirements: (await request(server, 'configRequirements/read', {})).requirements?.featureRequirements,
      warnings,
      appsCalls: calls.filter((p) => p === APPS_PATH).length,
    };
    // The record for the ticket. config/read is recorded, not asserted: under the pin it
    // still reports most planted switches on.
    const run = control ? 'control' : 'pinned';
    const record = { ...result, enabled: pinnedOf(result.enabled), configRead: pinnedOf(read.features) };
    console.log(JSON.stringify({ run, folder, planted, ...record }));
    return result;
  } finally {
    killCodexAppServer(server);
    stub.stop();
    process.env.HOME = home;
  }
}

// Runs the pinned codex binary, so only inside the agent image, with CODEX_SMOKE=1
// (.github/workflows/codex-smoke.yml). No network or login needed: SessionStart
// hooks run at the first turn, before its model request.
(process.env.CODEX_SMOKE ? describe : describe.skip)('pinned codex app-server', () => {
  it('starts a thread and runs only the image hook', async () => {
    const agentHooks = path.join(os.homedir(), '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(agentHooks), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    // A corrupt hooks file the agent left in its Codex home stops neither the
    // config write nor the next spawn.
    fs.writeFileSync(agentHooks, '{');
    writeCodexConfigToml({});
    expect(await hooksRunAtFirstTurn()).toEqual(['/etc/codex/hooks.json']);

    // A hook of the agent's own there does not run.
    fs.writeFileSync(
      agentHooks,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }),
    );
    expect(await hooksRunAtFirstTurn()).toEqual(['/etc/codex/hooks.json']);
  }, 60_000);

  it('runs the image hook again after a compaction', async () => {
    // Codex's own provider compacts remotely, so offline the compaction fails and
    // no hook runs. Against a provider on localhost Codex compacts locally; this
    // stub answers every request, the turn and the summary, with one reply.
    const reply = [
      { type: 'response.created', response: { id: 'resp' } },
      {
        type: 'response.output_item.done',
        item: { type: 'message', role: 'assistant', id: 'msg', content: [{ type: 'output_text', text: 'ok' }] },
      },
      { type: 'response.completed', response: { id: 'resp' } },
    ]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('');
    const stub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(reply, { headers: { 'content-type': 'text/event-stream' } }),
    });

    writeCodexConfigToml({});
    const config = path.join(os.homedir(), '.codex', 'config.toml');
    fs.writeFileSync(
      config,
      `model_provider = "stub"\n${fs.readFileSync(config, 'utf8')}\n` +
        `[model_providers.stub]\nname = "stub"\nbase_url = "http://127.0.0.1:${stub.port}/v1"\nwire_api = "responses"\n`,
    );

    const server = spawnCodexAppServer();
    try {
      const hookSources: string[] = [];
      let turnCompleted = () => {};
      server.notificationHandlers.push((n: JsonRpcNotification) => {
        if (n.method === 'hook/started') hookSources.push((n.params?.run as { sourcePath: string }).sourcePath);
        if (n.method === 'turn/completed') turnCompleted();
      });
      async function untilTurnCompleted(start: () => Promise<unknown>): Promise<void> {
        const completed = new Promise<void>((resolve) => (turnCompleted = resolve));
        await start();
        await completed;
      }

      await initializeCodexAppServer(server);
      const threadId = await startOrResumeCodexThread(server, undefined, { cwd });
      await untilTurnCompleted(() => startCodexTurn(server, { threadId, inputText: 'hello', cwd }));
      await untilTurnCompleted(() => sendCodexRequest(server, 'thread/compact/start', { threadId }));
      // SessionStart with source compact runs at the turn after the compaction;
      // a turn with no compaction before it runs no hook.
      await untilTurnCompleted(() => startCodexTurn(server, { threadId, inputText: 'again', cwd }));
      expect(hookSources).toEqual(['/etc/codex/hooks.json', '/etc/codex/hooks.json']);
    } finally {
      killCodexAppServer(server);
      stub.stop();
    }
  }, 60_000);

  it('reads apps, plugins, browser and computer use and memory as off, image generation as on', () => {
    writeCodexConfigToml({});
    const listed = execFileSync('codex', ['features', 'list'], { encoding: 'utf8' });
    const enabled = Object.fromEntries(
      listed
        .trim()
        .split('\n')
        .map((line) => [line.split(/\s+/)[0], line.endsWith('true')]),
    );
    expect(enabled).toMatchObject({
      apps: false,
      plugins: false,
      remote_plugin: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      computer_use: false,
      memories: false,
      image_generation: true,
    });
  });

  it('refuses the web search the agent asks for', async () => {
    writeCodexConfigToml({});
    const config = path.join(os.homedir(), '.codex', 'config.toml');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('web_search = "disabled"', 'web_search = "live"'));

    const server = spawnCodexAppServer();
    try {
      // Every warning through thread start: the control's made-up key raises one of its own.
      const warnings: string[] = [];
      server.notificationHandlers.push((n: JsonRpcNotification) => {
        if (n.method === 'configWarning') warnings.push(n.params?.summary as string);
      });
      await initializeCodexAppServer(server);
      await startOrResumeCodexThread(server, undefined, { cwd });
      expect(warnings.join('\n')).toContain(
        '`Live` is not in the allowed set [Disabled] (set by /etc/codex/requirements.toml)',
      );
    } finally {
      killCodexAppServer(server);
    }
  }, 60_000);

  it('starts a conversation with nothing planted, every pinned switch off', async () => {
    const read = await startConversation(null);
    console.log(`experimentalFeature/list, nothing planted: ${JSON.stringify(read.enabled)}`);
    expect(pinnedOf(read.enabled)).toEqual(allOff);
    if (control) {
      expect(read.requirements).toEqual({ not_a_codex_feature: true });
      expect(read.warnings).toEqual([
        'Ignoring unknown `features` requirement `not_a_codex_feature` from /etc/codex/requirements.toml',
      ]);
    } else {
      expect(read.requirements).toEqual(allOff);
      expect(read.warnings.filter((w) => w.includes('/etc/codex/requirements.toml'))).toEqual([]);
    }
  }, 60_000);

  it('starts a conversation with a project file that sets only the marker', async () => {
    expect((await startConversation(MARKER)).marker).toBe(31337);
  }, 60_000);

  // The pass rule's table, read off both runs on the first runs: in every case the planted
  // file loaded (the marker reads back in both runs), the control reads the switch on, and
  // the pinned run starts and reads it off. Held by the list; nothing was refused.
  const planted = [...PINNED.map((key) => [key, 'working'] as const), ['apps', 'above'] as const];
  for (const [key, folder] of planted) {
    it(`holds ${key} off when a project file in the ${folder} folder sets it on`, async () => {
      const read = await startConversation(`${MARKER}\n\n[features]\n${key} = true\n`, folder);
      expect(read.marker).toBe(31337);
      expect(read.enabled[key]).toBe(control);
      // The apps call's own row: the control makes it and the pinned run does not. Held by behavior.
      if (key === 'apps' && folder === 'working') expect(read.appsCalls > 0).toBe(control);
    }, 60_000);
  }
});
