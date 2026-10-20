/**
 * a2a-gate module — the content gate on the Architect → Scout pair.
 *
 * `vetoA2aContent` is consulted by the a2a.send decision in
 * `../agent-to-agent/guard.ts` after the structural checks and before the
 * policy hold. It can only refuse: it returns a reason, or null to leave the
 * decision to the checks that follow. It applies when the target agent group
 * is a gated one: its id is listed in `data/a2a-gate/targets`, or its name
 * is `scout`. Both are the operator's to set (a group's name changes only
 * through an approval-gated command, and a sender cannot change another
 * group); the sender's own destination label is not consulted, since a
 * sender can add labels. The Scout is the one agent that reads the open web,
 * so whatever reaches it may reach any page it opens. Every other pair is
 * untouched.
 *
 * It refuses content fields other than `text` and `files` (the target's
 * formatter renders more of them, such as a quoted reply or a list of links,
 * and the gate reads only these two), attachments, oversize text, invisible
 * characters, links, host names, addresses,
 * paths, mail addresses, opaque blobs, and any term in the operator's two
 * lists under `data/a2a-gate/`: `private-terms` (names, projects, hosts that
 * must never leave the machine) and `canaries` (strings planted in private
 * documents; a hit means a document was lifted). Missing lists refuse every
 * gated message, so an unconfigured gate is a closed gate.
 *
 * A refusal tells the sender why, once per message, so it can rephrase: a
 * note into its session, which is a side effect inside a guard decision and
 * the reason the dedupe set below exists (delivery retries a refused message
 * a few times before giving up). The reason string names the rule only; the
 * matched text goes to the sender, who already has it, never to the host
 * log.
 *
 * `sanitizeA2aContent` is the other direction: an answer from a gated group
 * is reduced to bounded plain text (see ./inbound.ts) before it is written
 * to the target's inbox, so the Architect's rule that an answer is data has
 * a host-side floor under it. Installed by the add-scout-gate skill.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import type { GuardInput } from '../../guard/index.js';
import { log } from '../../log.js';
import { notifyAgent } from '../approvals/index.js';
import { describeSanitized, sanitizeAnswer } from './inbound.js';
import { parseTermList, scrubForScout, type ScrubHit } from './scrub.js';

/** The agent group name the gate applies to, besides the ids listed in `targets`. */
const GATED_NAME = 'scout';
/** Where the operator keeps the term lists and the targets list. */
const GATE_DIR = path.join(DATA_DIR, 'a2a-gate');
/** Longest message text that may cross, in characters. A research question fits; a document does not. */
const MAX_CHARS = 4000;

const EXPLANATIONS: Record<ScrubHit['rule'], string> = {
  fields: 'carries fields other than its text',
  attachments: 'carries an attachment',
  size: 'is longer than the gate allows',
  invisible: 'contains an invisible character',
  url: 'contains a link',
  host: 'contains a host name',
  ip: 'contains an IP address',
  email: 'contains a mail address',
  path: 'contains a file path',
  token: 'contains a long opaque token',
  'private-term': 'contains a private term',
  canary: 'contains a private term',
};

const notified = new Set<string>();

async function tellSender(input: GuardInput, messageId: string, target: string, why: string): Promise<void> {
  const sessionId = input.actor.kind === 'agent' ? input.actor.sessionId : undefined;
  if (!sessionId || notified.has(messageId)) return;
  const session = await getSession(sessionId);
  if (!session) return;
  await notifyAgent(session, `Your message to ${target} was not sent: it ${why}. Rephrase without it and send again.`);
  if (notified.size > 1000) notified.clear();
  notified.add(messageId);
}

function readList(name: string): string[] {
  return parseTermList(fs.readFileSync(path.join(GATE_DIR, name), 'utf-8'));
}

/** The targets list is optional: without it, only the name match gates. */
function readTargets(): string[] {
  /* eslint-disable no-catch-all/no-catch-all -- an absent list means no listed ids, not a failure */
  try {
    return readList('targets');
  } catch {
    return [];
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Whether a group is gated: named `scout`, or listed by id in `targets`. Returns the display name too. */
async function gatedGroup(id: string): Promise<{ gated: boolean; name: string }> {
  const group = await getAgentGroup(id);
  const name = group?.name ?? id;
  return { gated: name.toLowerCase() === GATED_NAME || readTargets().includes(id), name };
}

/**
 * The text and file names of a message, plus `unchecked`: any other field the
 * target would see. Only a string `text` and a `files` list are read by the
 * rules, so anything else (a quoted reply, links, a non-string text) is named
 * here and refused.
 */
function parseContent(content: unknown): { text: string; files: string[]; unchecked: string[] } {
  if (typeof content !== 'string') return { text: '', files: [], unchecked: [] };
  let parsed: unknown;
  /* eslint-disable no-catch-all/no-catch-all -- plain text is a valid content shape */
  try {
    parsed = JSON.parse(content);
  } catch {
    // Not JSON: the content is the text itself.
    return { text: content, files: [], unchecked: [] };
  }
  /* eslint-enable no-catch-all/no-catch-all */
  if (typeof parsed !== 'object' || parsed === null) return { text: '', files: [], unchecked: [] };
  const fields = parsed as Record<string, unknown>;
  const text = typeof fields.text === 'string' ? fields.text : '';
  const files = Array.isArray(fields.files) ? fields.files.filter((f): f is string => typeof f === 'string') : [];
  const read = (k: string) =>
    (k === 'text' && typeof fields.text === 'string') ||
    (k === 'files' && Array.isArray(fields.files) && files.length === fields.files.length);
  return { text, files, unchecked: Object.keys(fields).filter((k) => !read(k)) };
}

/**
 * The a2a.send content check. Returns the refusal reason, or null when the
 * message is not gated or may cross. Never throws: a gate that cannot decide
 * refuses.
 */
export async function vetoA2aContent(input: GuardInput): Promise<string | null> {
  if (input.actor.kind !== 'agent') return null;
  const from = input.actor.agentGroupId;
  const to = input.resource?.to ?? '';
  const messageId = String(input.payload.id);

  const { gated, name: targetName } = await gatedGroup(to);
  if (!gated) return null;

  let privateTerms: string[];
  let canaries: string[];
  /* eslint-disable no-catch-all/no-catch-all -- fails closed: unreadable lists refuse the message */
  try {
    privateTerms = readList('private-terms');
    canaries = readList('canaries');
  } catch (err) {
    log.error('a2a-gate: term lists unreadable, refusing every gated message', { dir: GATE_DIR, err });
    await tellSender(input, messageId, targetName, 'cannot be checked (the gate is not configured on the host)');
    return `a2a-gate: term lists unreadable under ${GATE_DIR}`;
  }
  /* eslint-enable no-catch-all/no-catch-all */

  const { text, files, unchecked } = parseContent(input.payload.content);
  const hit: ScrubHit | null =
    unchecked.length > 0
      ? { rule: 'fields', match: unchecked.join(', ') }
      : scrubForScout(text, files, { maxChars: MAX_CHARS, privateTerms, canaries });
  if (!hit) return null;

  if (hit.rule === 'canary') {
    log.warn('a2a-gate: canary tripped — a private document reached an outbound message', {
      from,
      to,
      msgId: messageId,
    });
  }
  await tellSender(input, messageId, targetName, `${EXPLANATIONS[hit.rule]} ("${hit.match}")`);
  return `a2a-gate: message to ${targetName} refused (${hit.rule})`;
}

/**
 * The inbound half. Returns the content to write to the target's inbox:
 * unchanged when the sender is not gated; otherwise `{ text }` only, with the
 * answer reduced to bounded plain text and a header line saying what was
 * removed. Attachments do not survive, so none are forwarded.
 */
export async function sanitizeA2aContent(fromGroupId: string, content: string): Promise<string> {
  const { gated, name } = await gatedGroup(fromGroupId);
  if (!gated) return content;
  const { text, files } = parseContent(content);
  const result = sanitizeAnswer(text, files.length);
  if (result.truncated || Object.values(result.removed).some((n) => n > 0)) {
    log.info('a2a-gate: answer reduced to plain text', {
      from: fromGroupId,
      ...result.removed,
      truncated: result.truncated,
    });
  }
  return JSON.stringify({ text: `${describeSanitized(name, result)}\n${result.text}` });
}
