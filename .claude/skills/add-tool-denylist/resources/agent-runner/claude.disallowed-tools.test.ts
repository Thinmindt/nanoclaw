/**
 * Tools the operator switched off for a group (container.json
 * `disallowedTools`) reach the SDK's disallowed list next to the provider's
 * own. Installed by the add-tool-denylist skill.
 */
import { describe, expect, it, mock } from 'bun:test';

const disallowedCalls: string[][] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { disallowedTools: string[] } }) => {
    disallowedCalls.push(options.disallowedTools);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { runnerConfigFromRaw } = await import('../config.js');
const { SDK_DISALLOWED_TOOLS } = await import('./claude-config.js');

describe('group tool denylist', () => {
  it('reads disallowedTools from container.json, strings only', () => {
    expect(runnerConfigFromRaw({ disallowedTools: ['WebSearch', 3, ''] }).disallowedTools).toEqual(['WebSearch']);
    expect(runnerConfigFromRaw({}).disallowedTools).toEqual([]);
    expect(runnerConfigFromRaw({ disallowedTools: 'WebSearch' }).disallowedTools).toEqual([]);
  });

  it('adds the group list to the SDK disallowed tools', () => {
    disallowedCalls.length = 0;
    const provider = createProvider('claude', { disallowedTools: ['WebSearch'] });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    expect(disallowedCalls[0]).toEqual([...SDK_DISALLOWED_TOOLS, 'WebSearch']);
  });

  it('leaves the provider list alone when the group has none', () => {
    disallowedCalls.length = 0;
    const provider = createProvider('claude', {});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    expect(disallowedCalls[0]).toEqual([...SDK_DISALLOWED_TOOLS]);
  });
});
