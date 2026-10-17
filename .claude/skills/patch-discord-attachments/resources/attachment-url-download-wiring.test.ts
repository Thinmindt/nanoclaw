/**
 * Wiring guard for the patch-discord-attachments skill.
 *
 * Drives a message through the REAL bridge (stub adapter captures the Chat SDK
 * instance; `chat.processMessage` delivers through the SDK's own dispatch) with
 * an attachment shaped like the Discord adapter's: a CDN `url` and no
 * `fetchData()`. Only the network edge is faked. If the bridge's
 * "no fetchData → downloadAttachmentByUrl" block is deleted or misplaced, the
 * attachment arrives without data and this goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

interface ChatDriver {
  processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
}

function makeStubAdapter(name: string): { adapter: Adapter; chat: () => ChatDriver } {
  let captured: ChatDriver | null = null;
  const adapter = {
    name,
    initialize: async (chat: ChatDriver) => {
      captured = chat;
    },
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
  } as unknown as Adapter;
  return {
    adapter,
    chat: () => {
      if (!captured) throw new Error('adapter not initialized');
      return captured;
    },
  };
}

let nextId = 0;
function messageWithAttachment(attachment: Record<string, unknown>): Record<string, unknown> {
  const payload = {
    id: `msg-${++nextId}`,
    text: '',
    author: { userId: 'U1', userName: 'human', fullName: 'A Human', isBot: false, isMe: false },
  };
  return {
    ...payload,
    attachments: [attachment],
    isMention: false,
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
    raw: undefined,
    toJSON: () => ({ ...payload }),
  };
}

function makeHost(): { setup: ChannelSetup; inbound: InboundMessage[] } {
  const inbound: InboundMessage[] = [];
  return {
    inbound,
    setup: {
      onInbound: (_platformId, _threadId, message) => {
        inbound.push(message);
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    },
  };
}

const CDN = 'https://cdn.discordapp.com/attachments/1/2/brief.md';

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

async function deliver(attachment: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { adapter, chat } = makeStubAdapter('discord');
  const { setup, inbound } = makeHost();
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
  await bridge.setup(setup);
  await chat().processMessage(adapter, 'discord:C1:T1', messageWithAttachment(attachment));
  await bridge.teardown();
  expect(inbound).toHaveLength(1);
  const content = inbound[0].content as { attachments: Record<string, unknown>[] };
  return content.attachments[0];
}

describe('bridge → patch-discord-attachments wiring', () => {
  it('regression: a URL-only Discord attachment reaches the agent with its content', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(String(url));
      return new Response('# Seneca brief');
    });

    const att = await deliver({ type: 'file', name: 'brief.md', mimeType: 'text/markdown', size: 14, url: CDN });

    expect(requested).toEqual([CDN]);
    expect(Buffer.from(String(att.data), 'base64').toString()).toBe('# Seneca brief');
    expect(att.name).toBe('brief.md');
  });

  it('passes an attachment on a non-CDN host through as metadata only, without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const att = await deliver({ type: 'file', name: 'x.md', size: 5, url: 'https://example.com/x.md' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(att.data).toBeUndefined();
    expect(att.name).toBe('x.md');
  });
});
