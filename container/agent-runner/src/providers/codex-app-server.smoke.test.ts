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

// Runs the pinned codex binary, so only inside the agent image, with CODEX_SMOKE=1
// (.github/workflows/codex-smoke.yml). No network or login needed: SessionStart
// hooks run at the first turn, before its model request.
(process.env.CODEX_SMOKE ? describe : describe.skip)('pinned codex app-server', () => {
  it('starts a thread and runs only the image hook', async () => {
    const cwd = '/workspace/agent';
    // What an agent could leave behind: a corrupt hooks file in its Codex home
    // and a hook of its own in its workspace.
    fs.mkdirSync(path.join(os.homedir(), '.codex'), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), '.codex', 'hooks.json'), '{');
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }),
    );
    writeCodexConfigToml({});

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

      expect(hookSources).toEqual(['/etc/codex/hooks.json']);
    } finally {
      killCodexAppServer(server);
    }
  }, 60_000);
});
