/**
 * save_message: write the body of a message this session received to a file,
 * exactly as the mailbox holds it, with no model in between.
 *
 * The file is `<inbox>/<message id>/message-body.txt`, beside the message's
 * attachments. Exclusive create is the only guard on the write: whatever is
 * already at that name (an attachment of that name, a link, an earlier save)
 * is never overwritten or followed.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { getMessageIn, type MessageInRow } from '../db/messages-in.js';
import { getMessageIdBySeq } from '../db/messages-out.js';
import { findByRouting } from '../destinations.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const BODY_FILE = 'message-body.txt';
export const MAX_BODY_BYTES = 1024 * 1024;
const INBOX_DIR = '/workspace/inbox';

type Content = { text?: unknown; sender?: string; author?: { fullName?: string; userName?: string } };

/** The row's content as JSON, or undefined when it is not JSON. */
function parseContent(raw: string): Content | undefined {
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return undefined;
  }
}

/**
 * The stored body of a row the seat may save: the `text` string of the JSON
 * content, or the whole column when it is not JSON. Only chat rows carry the
 * #N a seat sees, so task, system and webhook rows are refused.
 */
export function messageBody(seq: number, row: MessageInRow | undefined): { text: string } | { error: string } {
  if (!row) return { error: `#${seq} is not a message this session received.` };
  if (row.kind !== 'chat' && row.kind !== 'chat-sdk') return { error: `#${seq} is a ${row.kind} row, not a message.` };
  const content = parseContent(row.content);
  if (!content) return { text: row.content };
  const text = content.text;
  return typeof text === 'string' && text.length > 0 ? { text } : { error: `Message #${seq} has no text.` };
}

function senderOf(row: MessageInRow): string {
  const content = parseContent(row.content) ?? {};
  return (
    content.sender ||
    content.author?.fullName ||
    content.author?.userName ||
    findByRouting(row.channel_type, row.platform_id)?.name ||
    'unknown'
  );
}

/** True when `file` is a regular file holding exactly `body`; never follows a link or blocks. */
function holdsExactly(file: string, body: Buffer): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== body.length) return false;
    const held = Buffer.alloc(body.length + 1);
    let total = 0;
    let read: number;
    do {
      read = fs.readSync(fd, held, total, held.length - total, null);
      total += read;
    } while (read > 0 && total < held.length);
    return total === body.length && held.subarray(0, total).equals(body);
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes `body` at `file` unless the name is taken; true when the file holds `body` afterwards. */
function writeOnce(file: string, body: Buffer): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return holdsExactly(file, body);
  }
  try {
    fs.writeFileSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export function saveMessageBody(seq: number, inboxDir = INBOX_DIR): { text: string } | { error: string } {
  const id = getMessageIdBySeq(seq);
  const row = id ? getMessageIn(id) : undefined;
  const found = messageBody(seq, row);
  if ('error' in found) return found;
  const message = row!;

  // The id comes from the sender's platform; a slash or `..` would move the file out of the inbox.
  if (message.id.includes('/') || message.id === '..') {
    return { error: `Message #${seq} has an id that cannot name a folder.` };
  }
  const body = Buffer.from(found.text, 'utf8');
  if (body.length > MAX_BODY_BYTES) {
    return { error: `Message #${seq} is ${body.length} bytes; the limit is ${MAX_BODY_BYTES}.` };
  }

  const file = path.join(inboxDir, message.id, BODY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!writeOnce(file, body)) return { error: `${file} already holds something else; nothing was written.` };

  return {
    text: [
      `Saved message #${seq} to ${file}`,
      `sender: ${senderOf(message)}`,
      `time: ${message.timestamp}`,
      `id: ${message.id}`,
      `bytes: ${body.length}`,
      `sha256: ${createHash('sha256').update(body).digest('hex')}`,
    ].join('\n'),
  };
}

export const saveMessage: McpToolDefinition = {
  tool: {
    name: 'save_message',
    description:
      'Save the body of a message you received in this session to /workspace/inbox/<message id>/message-body.txt, ' +
      'copied byte for byte as the mailbox holds it, with nothing added. For a message that crossed a gate, that is ' +
      "the gate's header line, then the reduced text, not what the sender wrote. Sender, time, message id, byte count " +
      'and SHA-256 come back in the result, never in the file. Refused, with nothing written, for a number that is ' +
      'not a message you received, a body over 1 MiB, or when something other than the same body is already at that name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
      },
      required: ['messageId'],
    },
  },
  async handler(args) {
    const saved = saveMessageBody(Number(args.messageId));
    return 'error' in saved
      ? { content: [{ type: 'text' as const, text: `Error: ${saved.error}` }], isError: true }
      : { content: [{ type: 'text' as const, text: saved.text }] };
  },
};

registerTools([saveMessage]);
