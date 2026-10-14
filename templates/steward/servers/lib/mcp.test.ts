import { expect, test } from 'bun:test';
import path from 'path';

/** Speak to a real server process over stdio, the way the agent's client does. */
test('gmail server answers initialize and tools/list over stdio', async () => {
  const proc = Bun.spawn(['bun', path.join(import.meta.dir, '..', 'gmail.ts')], {
    stdin: 'pipe',
    stdout: 'pipe',
    env: { ...process.env, HTTPS_PROXY: '' },
  });
  const send = (m: unknown) => proc.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'nope' });
  proc.stdin.end();

  const lines = (await new Response(proc.stdout).text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(lines).toHaveLength(3);
  expect(lines[0].result.serverInfo.name).toBe('gmail');
  expect(lines[0].result.instructions).toContain('read-only');
  expect(lines[1].result.tools.map((t: { name: string }) => t.name)).toEqual([
    'search_mail',
    'read_message',
    'read_thread',
  ]);
  expect(lines[2].error.code).toBe(-32601);
  expect(await proc.exited).toBe(0);
});
