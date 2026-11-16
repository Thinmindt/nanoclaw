/**
 * The memory hook rides the SDK's flag-level settings: the runner writes no
 * Claude settings file. That its context reaches a real session at startup,
 * compaction and clear is claude.smoke.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const calls: Array<{ settings: { hooks: unknown } }> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: (typeof calls)[number] }) => {
    calls.push(options);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
await import('./index.js');
await import('../provider-contracts/index.js');
const { registerProviderMemorySessionHook } = await import('../provider-contracts/realize.js');
const { createProvider } = await import('./factory.js');

let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  calls.length = 0;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-hook-'));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('Claude memory SessionStart hook', () => {
  it('rides the flag-level settings and writes no settings file', () => {
    const provider = createProvider('claude');
    registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'hi', cwd: '/workspace/agent' });

    expect(fs.readdirSync(configDir)).toEqual([]);
    expect(calls[0].settings.hooks).toEqual({
      SessionStart: [
        {
          matcher: 'startup|clear|compact',
          hooks: [{ type: 'command', command: 'bun /app/src/memory/hook.ts', timeout: 10 }],
        },
      ],
    });
  });
});
