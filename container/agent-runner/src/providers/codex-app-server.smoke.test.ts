import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type JsonRpcNotification,
  initializeCodexAppServer,
  killCodexAppServer,
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
});
