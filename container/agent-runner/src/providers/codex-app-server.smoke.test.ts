import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
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

  it('reads apps, plugins, browser and computer use as off, image generation as on', () => {
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
      image_generation: true,
    });
  });

  it('refuses the web search the agent asks for', async () => {
    writeCodexConfigToml({});
    const config = path.join(os.homedir(), '.codex', 'config.toml');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('web_search = "disabled"', 'web_search = "live"'));

    const server = spawnCodexAppServer();
    try {
      const warning = new Promise<string>((resolve) => {
        server.notificationHandlers.push((n: JsonRpcNotification) => {
          if (n.method === 'configWarning') resolve(n.params?.summary as string);
        });
      });
      await initializeCodexAppServer(server);
      expect(await warning).toContain(
        '`Live` is not in the allowed set [Disabled] (set by /etc/codex/requirements.toml)',
      );
    } finally {
      killCodexAppServer(server);
    }
  }, 60_000);
});
