import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, spyOn } from 'bun:test';

import { type AppServer, writeCodexConfigToml, type CodexMemorySessionHook } from './codex-app-server.js';
import { defaultCodexRuntimeDeps } from './codex.js';
import type { McpServerConfig } from './types.js';

// These tests need the runtime-contract core (registry + realize + factory
// wiring). On the standalone providers branch that core is absent — the
// payload is only ever executed inside an install — so they skip there, the
// same way legacy-payload-compat.test.ts skips absent payloads on core.
const hasContractCore = fs.existsSync(new URL('../provider-contracts/realize.ts', import.meta.url));

const SERVERS: Record<string, McpServerConfig> = {
  nanoclaw: {
    command: 'bun',
    args: ['run', '/app/src/mcp-tools/index.ts'],
    env: { FOO: 'bar' },
  },
  docs: {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { 'X-Api-Version': '2024-06' },
  },
};

const HOOK: CodexMemorySessionHook = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
};

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parity-'));
}

function readConfigToml(home: string): string {
  return fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
}

(hasContractCore ? describe : describe.skip)('codex contract write-path parity', () => {
  it('produces byte-identical config.toml through the contract path and the legacy writer', async () => {
    // Two-step registration: the providers barrel registers the factory, the
    // contracts barrel attaches the contract whose beforeQuery writes the files.
    await import('./index.js');
    await import('../provider-contracts/index.js');
    const { createProvider } = await import('./factory.js');
    const { registerProviderMemorySessionHook, runProviderBeforeQuery } =
      await import('../provider-contracts/realize.js');

    const previousHome = process.env.HOME;
    const legacyHome = tempHome();
    const contractHome = tempHome();
    try {
      // Legacy path: the provider normalizes effort in its constructor, then
      // hands the direct writer the normalized value.
      process.env.HOME = legacyHome;
      writeCodexConfigToml(SERVERS, { model: 'gpt-5', effort: 'high' });
      const legacy = readConfigToml(legacyHome);

      // Contract path: core hands the raw construction inputs to the provider
      // lifecycle callback (effort arrives un-normalized).
      process.env.HOME = contractHome;
      const provider = createProvider('codex', { mcpServers: SERVERS, model: 'gpt-5', effort: 'HIGH' });
      registerProviderMemorySessionHook('codex', provider, {
        command: HOOK.command,
        legacyCommands: [...HOOK.legacyCommands],
        sources: ['startup', 'clear', 'compact'],
      });
      runProviderBeforeQuery('codex', {
        inference: { model: 'gpt-5', effort: 'HIGH' },
        memory: HOOK,
        mcpServers: SERVERS,
      });
      const contract = readConfigToml(contractHome);

      expect(contract).toBe(legacy);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(legacyHome, { recursive: true, force: true });
      fs.rmSync(contractHome, { recursive: true, force: true });
    }
  });

  it('writes config.toml exactly once per query through the factory-wrapped provider', async () => {
    await import('./index.js');
    await import('../provider-contracts/index.js');
    const { createProvider } = await import('./factory.js');
    const { registerProviderMemorySessionHook } = await import('../provider-contracts/realize.js');

    const previousHome = process.env.HOME;
    const home = tempHome();
    // The contract's beforeQuery writes through the real writer; the
    // provider's own direct write goes through its runtime deps. Count the
    // real file writes and the deps writer separately, and keep the query
    // from reaching a codex binary by failing the app-server handshake.
    const originalDeps = { ...defaultCodexRuntimeDeps };
    let legacyWrites = 0;
    const writeSpy = spyOn(fs, 'writeFileSync');
    Object.assign(defaultCodexRuntimeDeps, {
      writeCodexConfigToml: (...args: Parameters<typeof writeCodexConfigToml>) => {
        legacyWrites += 1;
        originalDeps.writeCodexConfigToml(...args);
      },
      spawnCodexAppServer: () => fakeAppServer(),
      attachCodexAutoApproval: () => {},
      initializeCodexAppServer: async () => {
        throw new Error('handshake stopped by test');
      },
      killCodexAppServer: () => {},
    });
    try {
      process.env.HOME = home;
      const provider = createProvider('codex', { mcpServers: SERVERS, model: 'gpt-5', effort: 'high' });
      registerProviderMemorySessionHook('codex', provider, {
        command: HOOK.command,
        legacyCommands: [...HOOK.legacyCommands],
        sources: ['startup', 'clear', 'compact'],
      });

      const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
      await expect(query.events.next()).rejects.toThrow('handshake stopped by test');

      const written = writeSpy.mock.calls.map((call) => path.basename(String(call[0])));
      expect(written.filter((name) => name === 'config.toml')).toHaveLength(1);
      expect(legacyWrites).toBe(0);
      expect(readConfigToml(home)).toContain('model = "gpt-5"');
    } finally {
      writeSpy.mockRestore();
      Object.assign(defaultCodexRuntimeDeps, originalDeps);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

function fakeAppServer(): AppServer {
  return {
    process: { stdin: { write: () => true } },
    readline: { close: () => {} },
    pending: new Map(),
    notificationHandlers: [],
    exitHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
}
