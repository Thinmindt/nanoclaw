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

/**
 * Start a new conversation in a fresh Codex home, with `planted` as the project config file
 * of the working folder or of the folder above it, through the start of the first turn, and
 * read back what Codex made of it. A ChatGPT login of made-up tokens, with chatgpt_base_url
 * pointed at a local stub, lets the apps call be seen offline.
 */
async function startConversation(planted: string, folder: 'working' | 'above') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-case-'));
  const session = path.join(root, 'session');
  const workdir = path.join(session, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  // Codex reads a project file above the working folder only up to a repository root.
  if (folder === 'above') execFileSync('git', ['init', '-q', session]);
  const projectDir = path.join(folder === 'working' ? workdir : session, '.codex');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'config.toml'), planted);

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

    // The switch is read from Codex's feature list for the thread: config/read reports what
    // the files ask for, and under the pin still says most planted switches are on.
    const { data } = await request(server, 'experimentalFeature/list', { threadId });
    const read = (await request(server, 'config/read', { cwd: workdir })).config;
    return {
      marker: read.project_doc_max_bytes,
      enabled: Object.fromEntries(PINNED.map((key) => [key, data.find((f: any) => f.name === key)?.enabled])),
      warnings,
      appsCalls: calls.filter((p) => p === APPS_PATH).length,
    };
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

  // In both runs the planted file loads (the marker reads back) and the conversation starts.
  // The control reads every planted switch on; under the pin each reads off.
  it('holds every pinned switch off when a project file in the working folder sets it on', async () => {
    const read = await startConversation(
      `${MARKER}\n\n[features]\n${PINNED.map((k) => `${k} = true`).join('\n')}\n`,
      'working',
    );
    expect(read.marker).toBe(31337);
    expect(read.enabled).toEqual(Object.fromEntries(PINNED.map((key) => [key, control])));
    expect(read.appsCalls > 0).toBe(control);
    // A misspelled or renamed key in the pin is dropped with only a warning, which the
    // control's made-up key shows arriving.
    const unknownKey =
      'Ignoring unknown `features` requirement `not_a_codex_feature` from /etc/codex/requirements.toml';
    expect(read.warnings).toEqual(control ? [unknownKey] : []);
  }, 60_000);

  it('holds apps off when a project file in the repository folder above sets it on', async () => {
    const read = await startConversation(`${MARKER}\n\n[features]\napps = true\n`, 'above');
    expect(read.marker).toBe(31337);
    expect(read.enabled.apps).toBe(control);
  }, 60_000);
});
