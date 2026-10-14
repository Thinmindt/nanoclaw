import { describe, expect, test } from 'bun:test';

import type { Fetch } from './lib/http.js';
import { StdioServer } from './lib/mcp.js';
import { API, buildTools, slimTask, toTickTickDate } from './ticktick.js';

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function fakeFetch(reply: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const doFetch: Fetch = async (url, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      auth: new Headers(init?.headers).get('Authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), { status });
  };
  return { calls, doFetch };
}

async function call(tools: ReturnType<typeof buildTools>, name: string, args: Record<string, unknown> = {}) {
  const server = new StdioServer('ticktick', '0', '', tools);
  const res = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as {
    result: { content: { text: string }[]; isError: boolean };
  };
  return res.result;
}

describe('ticktick', () => {
  test('dates', () => {
    expect(toTickTickDate('2026-10-15')).toEqual({ date: '2026-10-15T00:00:00+0000', allDay: true });
    expect(toTickTickDate('2026-10-15T09:30:00+02:00')).toEqual({ date: '2026-10-15T09:30:00+0200', allDay: false });
    expect(toTickTickDate('2026-10-15T09:30Z').date).toBe('2026-10-15T09:30:00+0000');
    expect(toTickTickDate('2026-10-15T09:30').date).toMatch(/^2026-10-15T09:30:00[+-]\d{4}$/);
    expect(() => toTickTickDate('next tuesday')).toThrow();
  });

  test('slimTask names the priority and drops empty fields', () => {
    expect(slimTask({ id: 'a', title: 'T', content: '', tags: [], priority: 5, status: 2 })).toEqual({
      id: 'a',
      title: 'T',
      priority: 'high',
      completed: true,
    });
  });

  test('no delete, and complete only when allowed', () => {
    const names = (allow: boolean) => buildTools(fakeFetch(() => ({})).doFetch, allow).map((t) => t.name);
    expect(names(false)).toEqual(['list_projects', 'list_tasks', 'get_task', 'create_task', 'update_task']);
    expect(names(true)).toContain('complete_task');
    expect(names(true).some((n) => n.includes('delete'))).toBe(false);
  });

  test('requests carry only the placeholder credential', async () => {
    const { calls, doFetch } = fakeFetch(() => [{ id: 'p1', name: 'Inbox', extra: 1 }]);
    const res = await call(buildTools(doFetch, false), 'list_projects');
    expect(JSON.parse(res.content[0].text)).toEqual([{ id: 'p1', name: 'Inbox' }]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/project`, auth: 'Bearer placeholder' });
  });

  test('create_task builds the body', async () => {
    const { calls, doFetch } = fakeFetch((c) => ({ ...(c.body as object), id: 't1' }));
    const res = await call(buildTools(doFetch, false), 'create_task', {
      title: 'Call the vet',
      notes: 'from email',
      due_date: '2026-10-20',
      priority: 'medium',
    });
    expect(res.isError).toBe(false);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${API}/task`);
    expect(calls[0].body).toEqual({
      title: 'Call the vet',
      priority: 3,
      content: 'from email',
      dueDate: '2026-10-20T00:00:00+0000',
      startDate: '2026-10-20T00:00:00+0000',
      isAllDay: true,
    });
  });

  test('bad priority and missing arguments are tool errors, not calls', async () => {
    const { calls, doFetch } = fakeFetch(() => ({}));
    const tools = buildTools(doFetch, false);
    expect((await call(tools, 'create_task', { title: 'x', priority: 'urgent' })).isError).toBe(true);
    expect((await call(tools, 'update_task', { task_id: 't1' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('ids cannot reach other paths', async () => {
    const { calls, doFetch } = fakeFetch(() => ({}));
    const res = await call(buildTools(doFetch, false), 'get_task', { project_id: '../x', task_id: 't' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('a refused request explains itself', async () => {
    const { doFetch } = fakeFetch(() => ({ error: 'denied' }), 403);
    const res = await call(buildTools(doFetch, false), 'create_task', { title: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('refused (403)');
  });
});
