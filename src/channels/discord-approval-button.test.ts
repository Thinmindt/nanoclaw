/**
 * Guard for the patch-discord-approval-buttons skill.
 *
 * The bridge builds each card button with an id (`ncq:<questionId>:<index>`) and a value (the same index).
 * The Discord adapter encodes a button's custom_id as `<id>\n<value>`, so a click arrives through the
 * Gateway as `ncq:<questionId>:0\n0`. The bridge must read the option index from before the newline;
 * otherwise `0\n0` fails the index check, passes through as the selected "option", and every approval
 * resolves as a reject (the response handler treats anything but exactly `approve` as one).
 *
 * Drives the real bridge's Gateway webhook with a real `pending_approvals` row in a test DB; only the
 * Discord API acknowledgement is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import { normalizeOptions } from './ask-question.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { resolveQuestionRender } from './question-render-registry.js';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const BOT_TOKEN = 'test-bot-token';
const APPROVAL_ID = 'appr-test-0001';
const OPTIONS = normalizeOptions([
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
]);
const realFetch = globalThis.fetch;
let discordApi: ReturnType<typeof vi.fn>;

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
  const click = (customId: string) =>
    realFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-discord-gateway-token': BOT_TOKEN },
      body: JSON.stringify({
        type: 'GATEWAY_INTERACTION_CREATE',
        data: {
          type: 3,
          id: 'interaction-1',
          token: 'interaction-token',
          channel_id: 'dm-1',
          data: { custom_id: customId },
          member: { user: { id: 'owner-1', username: 'owner' } },
          message: { id: 'card-1', embeds: [{ title: 'Message approval', description: 'q' }] },
        },
      }),
    });
  return { bridge, click, onAction };
}

/** The footer text the bridge wrote back onto the card. */
function footer(): string | undefined {
  const call = discordApi.mock.calls.find(([url]) => String(url).includes('/interactions/'));
  if (!call) return undefined;
  return JSON.parse(String((call[1] as RequestInit).body)).data?.embeds?.[0]?.footer?.text;
}

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
  const { createPendingApproval } = await import('../db/sessions.js');
  await createPendingApproval({
    approval_id: APPROVAL_ID,
    request_id: APPROVAL_ID,
    action: 'a2a_message_gate',
    payload: '{}',
    created_at: new Date().toISOString(),
    title: 'Message approval',
    question: 'Agent "Architect" wants to send a message to "Scout"',
    options_json: JSON.stringify(OPTIONS),
  });
  discordApi = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', discordApi);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

describe('Discord approval card clicks', () => {
  it('finds the card render for a stored approval row', async () => {
    const render = await resolveQuestionRender(APPROVAL_ID);
    expect(render?.title).toBe('Message approval');
    expect(render?.options[0].value).toBe('approve');
  });

  it('regression: Approve arriving as "ncq:<id>:0\\n0" resolves to approve, not reject', async () => {
    const { bridge, click, onAction } = await startGateway();
    try {
      await click(`ncq:${APPROVAL_ID}:0\n0`);
      await vi.waitFor(() => expect(onAction).toHaveBeenCalled());
      expect(onAction).toHaveBeenCalledWith(APPROVAL_ID, 'approve', 'owner-1', expect.anything());
      expect(footer()).toBe('✅ Approved by owner');
    } finally {
      await bridge.teardown();
    }
  });

  it('Reject arriving as "ncq:<id>:1\\n1" resolves to reject', async () => {
    const { bridge, click, onAction } = await startGateway();
    try {
      await click(`ncq:${APPROVAL_ID}:1\n1`);
      await vi.waitFor(() => expect(onAction).toHaveBeenCalled());
      expect(onAction).toHaveBeenCalledWith(APPROVAL_ID, 'reject', 'owner-1', expect.anything());
      expect(footer()).toBe('❌ Rejected by owner');
    } finally {
      await bridge.teardown();
    }
  });

  it('still accepts a custom_id with no value suffix', async () => {
    const { bridge, click, onAction } = await startGateway();
    try {
      await click(`ncq:${APPROVAL_ID}:0`);
      await vi.waitFor(() => expect(onAction).toHaveBeenCalled());
      expect(onAction).toHaveBeenCalledWith(APPROVAL_ID, 'approve', 'owner-1', expect.anything());
    } finally {
      await bridge.teardown();
    }
  });
});
