import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { BODY_FILE, MAX_BODY_BYTES, saveMessageBody } from './save-message.js';

let inbox: string;

beforeEach(() => {
  initTestSessionDb();
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'save-message-'));
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(inbox, { recursive: true, force: true });
});

/** An inbound row as the host writes it (host sequence numbers are even). */
function seedInbound(seq: number, id: string, content: string, kind = 'chat'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, ?, ?, '2026-11-26T09:15:00.000Z', 'completed', 'ag-architect', 'agent', ?)`,
    )
    .run(id, seq, kind, content);
}

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const bodyPath = (id: string) => path.join(inbox, id, BODY_FILE);

// The gate's header line, then text with everything the seat's view alters or a copy by hand gets wrong.
const BODY =
  '[gate: answer from scout, plain text, nothing removed]\n' +
  'He said "use C:\\temp\\x" & <b>bold</b> > less\r\nZweite Zeile: Grüße, 日本語, ✓\n';

describe('save_message', () => {
  it('writes the stored body byte for byte, attachments untouched, and returns sender, time, id, size and checksum', () => {
    seedInbound(2, 'a2a-1', JSON.stringify({ sender: 'Architect', text: BODY }));
    fs.mkdirSync(path.join(inbox, 'a2a-1'));
    fs.writeFileSync(path.join(inbox, 'a2a-1', 'photo.jpg'), 'jpeg bytes');

    const saved = saveMessageBody(2, inbox);

    const onDisk = fs.readFileSync(bodyPath('a2a-1'));
    expect(sha256(onDisk)).toBe(sha256(BODY));
    expect('text' in saved && saved.text).toBe(
      [
        `Saved message #2 to ${bodyPath('a2a-1')}`,
        'sender: Architect',
        'time: 2026-11-26T09:15:00.000Z',
        'id: a2a-1',
        `bytes: ${Buffer.byteLength(BODY)}`,
        `sha256: ${sha256(BODY)}`,
      ].join('\n'),
    );
    expect(fs.readFileSync(path.join(inbox, 'a2a-1', 'photo.jpg'), 'utf8')).toBe('jpeg bytes');
  });

  it('saves the whole column when the content is not JSON', () => {
    seedInbound(2, 'plain-1', 'not { json');
    saveMessageBody(2, inbox);
    expect(fs.readFileSync(bodyPath('plain-1'), 'utf8')).toBe('not { json');
  });

  it('refuses an unknown number, its own sent message, a task row and a row with no text, writing nothing', async () => {
    const sent = await writeMessageOut({ id: 'out-1', kind: 'chat', content: JSON.stringify({ text: 'mine' }) });
    seedInbound(2, 'task-1', JSON.stringify({ prompt: 'run' }), 'task');
    seedInbound(4, 'empty-1', JSON.stringify({ sender: 'Architect' }));

    for (const seq of [98, sent, 2, 4]) expect('error' in saveMessageBody(seq, inbox)).toBe(true);
    expect(fs.readdirSync(inbox)).toEqual([]);
  });

  it('refuses a body over 1 MiB, writing nothing', () => {
    seedInbound(2, 'big-1', JSON.stringify({ text: 'x'.repeat(MAX_BODY_BYTES + 1) }));
    expect('error' in saveMessageBody(2, inbox)).toBe(true);
    expect(fs.readdirSync(inbox)).toEqual([]);
  });

  it('answers a second save as the first and writes nothing', () => {
    seedInbound(2, 'a2a-2', JSON.stringify({ text: BODY }));
    const first = saveMessageBody(2, inbox);
    const second = saveMessageBody(2, inbox);
    expect(second).toEqual(first);
    expect(fs.readdirSync(path.join(inbox, 'a2a-2'))).toEqual([BODY_FILE]);
  });

  it('refuses when an attachment already holds the name, and leaves it as it was', () => {
    seedInbound(2, 'a2a-3', JSON.stringify({ text: BODY }));
    fs.mkdirSync(path.join(inbox, 'a2a-3'));
    fs.writeFileSync(bodyPath('a2a-3'), 'an attachment');

    expect('error' in saveMessageBody(2, inbox)).toBe(true);
    expect(fs.readFileSync(bodyPath('a2a-3'), 'utf8')).toBe('an attachment');
  });

  it('refuses a link at the name, even to a file holding the same bytes', () => {
    seedInbound(2, 'a2a-4', JSON.stringify({ text: BODY }));
    const target = path.join(inbox, 'same-bytes.txt');
    fs.writeFileSync(target, BODY);
    fs.mkdirSync(path.join(inbox, 'a2a-4'));
    fs.symlinkSync(target, bodyPath('a2a-4'));

    expect('error' in saveMessageBody(2, inbox)).toBe(true);
    expect(fs.lstatSync(bodyPath('a2a-4')).isSymbolicLink()).toBe(true);
  });
});
