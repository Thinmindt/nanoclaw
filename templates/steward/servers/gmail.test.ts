import { describe, expect, test } from 'bun:test';

import { API, buildTools, bodyText, full, htmlToText, UNTRUSTED_NOTE } from './gmail.js';
import type { Fetch } from './lib/http.js';
import { StdioServer } from './lib/mcp.js';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

const message = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'Can you confirm &amp; reply?',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Sam <sam@example.com>' },
      { name: 'Subject', value: 'Saturday?' },
      { name: 'Date', value: 'Tue, 14 Oct 2026 09:00:00 +0000' },
      { name: 'To', value: 'me@example.com' },
      { name: 'X-Other', value: 'dropped' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Are you free Saturday?') } },
      { mimeType: 'text/html', body: { data: b64('<p>Are you <b>free</b></p>') } },
    ],
  },
};

function fakeFetch() {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const doFetch: Fetch = async (url, init) => {
    calls.push({ method: init?.method ?? 'GET', url, auth: new Headers(init?.headers).get('Authorization') });
    const path = new URL(url).pathname;
    if (path.endsWith('/messages')) return Response.json({ messages: [{ id: 'm1' }] });
    if (path.includes('/threads/')) return Response.json({ messages: [message, message] });
    return Response.json(message);
  };
  return { calls, doFetch };
}

async function call(name: string, args: Record<string, unknown>, doFetch: Fetch) {
  const server = new StdioServer('gmail', '0', '', buildTools(doFetch));
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

describe('gmail', () => {
  test('only read tools exist', () => {
    expect(buildTools(fakeFetch().doFetch).map((t) => t.name)).toEqual(['search_mail', 'read_message', 'read_thread']);
  });

  test('html to text', () => {
    expect(htmlToText('<style>x{}</style><p>Hi&nbsp;there &amp; <b>you</b></p><br>Bye')).toBe('Hi there & you \n\nBye');
  });

  test('prefers plain text, falls back to html', () => {
    expect(bodyText(message.payload)).toBe('Are you free Saturday?');
    expect(bodyText({ mimeType: 'text/html', body: { data: b64('<div>Only html</div>') } })).toBe('Only html');
  });

  test('bodies are wrapped as untrusted and truncated', () => {
    const out = full(message, 7);
    expect(out.body).toEqual({ note: UNTRUSTED_NOTE, text: 'Are you' });
    expect(out.truncated).toBe(true);
    expect(out.to).toBe('me@example.com');
    expect(out).not.toHaveProperty('snippet');
  });

  test('search makes only GET requests with the placeholder credential', async () => {
    const { calls, doFetch } = fakeFetch();
    const res = await call('search_mail', { query: 'is:unread', max_results: 500 }, doFetch);
    const out = JSON.parse(res.content[0].text);
    expect(out[0]).toMatchObject({ id: 'm1', from: 'Sam <sam@example.com>', snippet: 'Can you confirm & reply?' });
    expect(calls.every((c) => c.method === 'GET' && c.auth === 'Bearer placeholder')).toBe(true);
    const list = new URL(calls[0].url);
    expect(list.origin + list.pathname).toBe(`${API}/messages`);
    expect(list.searchParams.get('maxResults')).toBe('100');
    expect(new URL(calls[1].url).searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject', 'Date']);
  });

  test('read_thread returns each message', async () => {
    const res = await call('read_thread', { thread_id: 't1' }, fakeFetch().doFetch);
    expect(JSON.parse(res.content[0].text)).toHaveLength(2);
  });

  test('ids with path characters are refused', async () => {
    const { calls, doFetch } = fakeFetch();
    expect((await call('read_message', { message_id: 'm1/../../send' }, doFetch)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
