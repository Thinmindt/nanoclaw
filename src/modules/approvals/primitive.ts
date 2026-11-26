/**
 * Approvals primitive — the public API that other modules call.
 *
 * Two surfaces:
 *   - `requestApproval()` — queue an approval request, deliver the card to
 *     the right admin DM, record the pending_approvals row. Used by any
 *     module that needs admin confirmation before doing something sensitive.
 *   - `registerApprovalHandler(action, handler)` — called at module import
 *     time. When the admin approves a pending row with matching `action`,
 *     the response handler dispatches into the registered callback. Optional
 *     modules (self-mod, future module gates) register here.
 *
 * Approver picking lives here too — it used to sit in src/access.ts and got
 * folded in with the PR #7 re-tier. The picks functions walk user_roles
 * (owner, global admin, scoped admin) and resolve to a reachable DM via the
 * permissions module's user-dm helper.
 *
 * Tier: default module. Permissions is an optional module, so importing from
 * it here is technically a tier inversion — but the host bundles both with
 * main, and the alternative (a third "permissions-primitive" default module
 * exposing just user-roles/user-dms) is more churn than it's worth. Revisit
 * if either module becomes genuinely optional (see REFACTOR_PLAN open q #3).
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import {
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupsByAgentGroup,
} from '../../db/messaging-groups.js';
import { createPendingApproval, deletePendingApproval, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, PendingApproval, Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/**
 * Card value for the "Reject with reason…" button. Selecting it doesn't
 * finalize the reject — it holds the row and captures the approver's next DM
 * as a one-line reason relayed to the requesting agent. See reason-capture.ts.
 */
export const REJECT_WITH_REASON_VALUE = 'reject_with_reason';

/**
 * Three-button approval UI. Plain Reject is the instant fast path; "Reject with
 * reason…" opts into the reason-capture flow. Shared by every module approval
 * (create_agent, install_packages, add_mcp_server). Gateway approvals use the
 * core gateway coordinator's two-button decision flow.
 */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: REJECT_WITH_REASON_VALUE },
];

// ── Approval handler registry ──
// Modules that want to be called back when an admin approves a pending row
// register here at import time, keyed by the `action` string they used in
// their `requestApproval()` calls.

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  /**
   * The verified approval row — the grant an approved continuation carries
   * when it re-enters its guarded entry point. Still live here; resolution
   * deletes it after the handler returns, so a grant executes exactly once.
   */
  approval: PendingApproval;
  /** User ID of the admin who approved. Empty string if unknown. */
  userId: string;
  /** Send a system chat message to the requesting agent's session. */
  notify: (text: string) => Promise<void>;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

// ── Approval-resolved callbacks ──
// Modules that want to observe approval resolution (any action, approve or
// reject) register here at import time. The response handler fires every
// registered callback after the admin's decision is applied — e.g. a module
// clearing an "awaiting approval" status indicator it set when the card went
// out. Callback errors are logged and isolated; they never block resolution.
//
// Only authorized clicks resolve an approval (the response handler's
// isAuthorizedApprovalClick gate runs first), so callbacks never fire for
// unauthorized responses.

export interface ApprovalResolvedEvent {
  approval: PendingApproval;
  session: Session;
  outcome: 'approve' | 'reject';
  /** Namespaced user ID (`<channel>:<handle>`) of the resolving admin. Empty string if unknown. */
  userId: string;
}

export type ApprovalResolvedHandler = (event: ApprovalResolvedEvent) => Promise<void> | void;

const approvalResolvedHandlers: ApprovalResolvedHandler[] = [];

export function registerApprovalResolvedHandler(handler: ApprovalResolvedHandler): void {
  approvalResolvedHandlers.push(handler);
}

/** Fire every registered approval-resolved callback. Called by the response handler. */
export async function notifyApprovalResolved(event: ApprovalResolvedEvent): Promise<void> {
  for (const handler of approvalResolvedHandlers) {
    try {
      await handler(event);
      // eslint-disable-next-line no-catch-all/no-catch-all -- isolation is the contract: one bad callback must not block resolution or other callbacks
    } catch (err) {
      log.error('Approval-resolved handler threw', {
        approvalId: event.approval.approval_id,
        action: event.approval.action,
        outcome: event.outcome,
        err,
      });
    }
  }
}

// ── Approver picking ──

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export async function pickApprover(agentGroupId: string | null): Promise<string[]> {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of await getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of await getGlobalAdmins()) add(r.user_id);
  for (const r of await getOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break: prefer approvers reachable on the same channel kind as the
 * origin; else first in list. A same-channel origin resolves through its
 * exact adapter instance.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
  originInstance?: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId, originInstance === undefined ? undefined : { instance: originInstance });
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  for (const userId of approvers) {
    if (originChannelType && channelTypeOf(userId) === originChannelType) continue;
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}

/**
 * A card joins the requester's thread only when it lands in the requester's own
 * chat; a thread id from any other chat means nothing in the approver's DM.
 */
export function approvalCardThread(session: Session, target: MessagingGroup): string | null {
  return session.messaging_group_id === target.id ? session.thread_id : null;
}

// ── Request API ──

/** Send a system chat to the agent's session. Used by callers and by the response handler. */
export async function notifyAgent(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'inbound-message');
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** Free-form action identifier. Must match the key the consumer registered via registerApprovalHandler. */
  action: string;
  /** JSON-serializable opaque payload. Carried on the pending_approvals row, handed to the handler on approve. */
  payload: Record<string, unknown>;
  /** Card title shown to the admin. */
  title: string;
  /** Card body shown to the admin. */
  question: string;
  /** Deliver the card to this specific user instead of all of the session group's admins. */
  approverUserId?: string;
}

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the pending_approvals row. Fire-and-forget from the
 * caller's perspective — the admin's response kicks off the registered
 * approval handler for this action via the response dispatcher.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question, agentName, approverUserId } = opts;

  const approvers = approverUserId ? [approverUserId] : await pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    await notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const originChannelType = origin?.channel_type ?? '';

  const target = await pickApprovalDelivery(approvers, originChannelType, origin?.instance);
  if (!target) {
    await notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);

  /** Record the request against `mg` and post the card there. False when the post failed. */
  const postCard = async (mg: MessagingGroup): Promise<boolean> => {
    await createPendingApproval({
      approval_id: approvalId,
      session_id: session.id,
      request_id: approvalId,
      action,
      payload: JSON.stringify(payload),
      created_at: new Date().toISOString(),
      channel_type: mg.channel_type,
      platform_id: mg.platform_id,
      instance: mg.instance ?? null,
      title,
      question,
      options_json: JSON.stringify(normalizedOptions),
      // The DM'd approver is the identity this card was routed to; recording it
      // makes resolution exact — only that user may decide the row.
      approver_user_id: approverUserId ?? target.userId ?? null,
    });

    const adapter = getDeliveryAdapter();
    if (!adapter) return true;
    try {
      await adapter.deliver(
        mg.channel_type,
        mg.platform_id,
        approvalCardThread(session, mg),
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
        }),
        undefined,
        mg.instance,
      );
      return true;
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, bot: mg.instance, err });
      // This target never saw the card — remove the row so it can't linger as
      // a pending approval nobody can act on.
      await deletePendingApproval(approvalId);
      return false;
    }
  };

  // A session with no chat, or on a chat its seat has left, would send the card
  // through whatever bot today's target is on. Send it to the same person
  // through the seat's one linked bot instead, with today's target as the retry.
  const originLinked = origin && (await getMessagingGroupAgentByPair(origin.id, session.agent_group_id));
  const bot = originLinked
    ? undefined
    : await seatLinkedBot(session.agent_group_id, target.messagingGroup.channel_type);
  const seatDm =
    bot && bot !== target.messagingGroup.instance ? await ensureUserDm(target.userId, { instance: bot }) : null;

  for (const mg of seatDm ? [seatDm, target.messagingGroup] : [target.messagingGroup]) {
    if (await postCard(mg)) {
      log.info('Approval requested', { action, approvalId, agentName, approver: target.userId, bot: mg.instance });
      return;
    }
  }
  await notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
}

/**
 * The one bot a seat is linked through on a chat service, or undefined when
 * it has none there or more than one. Linked chats come back in no order, so
 * the rule is "exactly one distinct bot", never "the first row".
 */
export async function seatLinkedBot(agentGroupId: string, channelType: string): Promise<string | undefined> {
  const bots = new Set(
    (await getMessagingGroupsByAgentGroup(agentGroupId))
      .filter((mg) => mg.channel_type === channelType)
      .map((mg) => mg.instance ?? mg.channel_type),
  );
  return bots.size === 1 ? [...bots][0] : undefined;
}
