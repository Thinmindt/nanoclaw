/**
 * Regression guard for the patch-discord-approval-buttons skill.
 *
 * The Discord Gateway delivers a button click with `custom_id` set to the
 * button's id and value joined by a newline (`ncq:<card>:0\n0`). Without the
 * patch the bridge decodes the option as `0\n0`, cannot map it to an option,
 * and the approval resolves as a rejection whatever was pressed. This drives a
 * real Gateway click through the bridge's local webhook, with only the network
 * faked, and checks the pressed option arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerQuestionRenderResolver } from './question-render-registry.js';

const BOT_TOKEN = 'test-bot-token';
const realFetch = globalThis.fetch;

registerQuestionRenderResolver((id) =>
  id === 'approval-card'
    ? {
        title: 'Message approval',
        question: 'Agent "Architect" wants to send a message to "Scout"',
        options: [
          { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
          { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
        ],
      }
    : undefined,
);

function click(customId: string): string {
  return JSON.stringify({
    type: 'GATEWAY_INTERACTION_CREATE',
    data: {
      type: 3,
      id: 'interaction-1',
      token: 'interaction-token',
      channel_id: 'dm-1',
      data: { custom_id: customId },
      user: { id: 'owner-1', username: 'owner' },
      message: { id: 'card-1', embeds: [] },
    },
  });
}

async function startGateway() {
  let webhookUrl = '';
  const adapter = {
    name: 'discord',
    initialize: async () => {},
    handleWebhook: vi.fn(async () => new Response('ok')),
    channelIdFromThreadId: (threadId: string) => threadId,
    startGatewayListener: async (_opts: unknown, _ms: number, _signal: AbortSignal, url: string) => {
      webhookUrl = url;
      return new Response('{}');
    },
  } as unknown as Adapter;
  const onAction = vi.fn();
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true, botToken: BOT_TOKEN });
  await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
  const post = (body: string) =>
    realFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-discord-gateway-token': BOT_TOKEN },
      body,
    });
  return { bridge, post, onAction };
}

describe('Discord approval buttons (patch-discord-approval-buttons)', () => {
  let discordCalls: Array<{ url: string; body: string }>;

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    discordCalls = [];
    // Interaction acks go to the Discord API; record them instead.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        discordCalls.push({ url, body: init?.body ?? '' });
        return new Response(null, { status: 204 });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  it.each([
    ['0', 'approve', '✅ Approved by owner'],
    ['1', 'reject', '❌ Rejected by owner'],
  ])('decodes a Gateway click on button %s as %s', async (index, value, footer) => {
    const { bridge, post, onAction } = await startGateway();
    try {
      expect((await post(click(`ncq:approval-card:${index}\n${index}`))).status).toBe(200);
      expect(onAction).toHaveBeenCalledWith('approval-card', value, 'owner-1', expect.anything());
      expect(discordCalls.some((c) => c.body.includes(footer))).toBe(true);
    } finally {
      await bridge.teardown();
    }
  });

  it('still decodes a click without the appended value', async () => {
    const { bridge, post, onAction } = await startGateway();
    try {
      expect((await post(click('ncq:approval-card:0'))).status).toBe(200);
      expect(onAction).toHaveBeenCalledWith('approval-card', 'approve', 'owner-1', expect.anything());
    } finally {
      await bridge.teardown();
    }
  });
});
