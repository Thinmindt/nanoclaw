import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-move-inbound' };
});
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import type { SessionHandle, SessionSnapshot } from '../../drivers/types.js';
import { log } from '../../log.js';
import { SqliteAgentMailbox } from './index.js';
import { moveInboundMailboxes } from './move-inbound.js';
import { inboundDbPath, inboundMoveMarkPath, legacyInboundDbPath, outboundDbPath, sessionMailboxDir } from './paths.js';
import { ensureSchema } from './session-db.js';

const DATA_DIR = '/tmp/nanoclaw-test-move-inbound';
const CHAT = { agentGroupId: 'ag-1', sessionId: 'sess-chat' };
const TASK = { agentGroupId: 'ag-1', sessionId: 'sess-task' };

const nothingListed = async (): Promise<SessionSnapshot[]> => [];

function snapshot(name: string, phase: SessionSnapshot['phase']): SessionSnapshot {
  return { handle: { name } as SessionHandle, phase };
}

/** A session in the layout before the upgrade: inbound.db inside the read-write session folder. */
function legacySession(
  key: typeof CHAT,
  rows: Array<{ id: string; seq: number; kind: string; processAfter?: string }>,
) {
  fs.mkdirSync(sessionMailboxDir(key), { recursive: true });
  ensureSchema(legacyInboundDbPath(key), 'inbound');
  ensureSchema(outboundDbPath(key.agentGroupId, key.sessionId), 'outbound');
  const db = new Database(legacyInboundDbPath(key));
  const insert = db.prepare(
    "INSERT INTO messages_in (id, seq, kind, timestamp, process_after, content) VALUES (?, ?, ?, datetime('now'), ?, '{}')",
  );
  for (const row of rows) insert.run(row.id, row.seq, row.kind, row.processAfter ?? null);
  db.prepare("INSERT INTO delivered (message_out_id, delivered_at) VALUES ('out-1', datetime('now'))").run();
  db.close();
}

function rows(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    return {
      messages: db.prepare('SELECT * FROM messages_in ORDER BY seq').all(),
      delivered: db.prepare('SELECT * FROM delivered').all(),
      maxSeq: (db.prepare('SELECT MAX(seq) AS s FROM messages_in').get() as { s: number }).s,
    };
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  vi.mocked(log.error).mockClear();
});
afterEach(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe('the one-time move refuses while a session container runs (criterion 11)', () => {
  beforeEach(() => legacySession(CHAT, [{ id: 'm1', seq: 2, kind: 'chat' }]));

  it('moves nothing and throws, naming the running containers', async () => {
    const listing = async () => [
      snapshot('nanoclaw-v2-alpha-1', 'running'),
      snapshot('nanoclaw-v2-beta-2', 'terminal'),
    ];
    await expect(moveInboundMailboxes(listing)).rejects.toThrow(/still running \(nanoclaw-v2-alpha-1\)/);
    expect(fs.existsSync(legacyInboundDbPath(CHAT))).toBe(true);
    expect(fs.existsSync(inboundDbPath(CHAT.agentGroupId, CHAT.sessionId))).toBe(false);
    expect(fs.existsSync(inboundMoveMarkPath())).toBe(false);
  });

  it('counts a listing that fails as listed', async () => {
    const listing = async (): Promise<SessionSnapshot[]> => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    await expect(moveInboundMailboxes(listing)).rejects.toThrow('Cannot connect to the Docker daemon');
    expect(fs.existsSync(legacyInboundDbPath(CHAT))).toBe(true);
    expect(fs.existsSync(inboundMoveMarkPath())).toBe(false);
  });

  it('control: with only ended containers listed, the file moves', async () => {
    await moveInboundMailboxes(async () => [snapshot('nanoclaw-v2-beta-2', 'terminal')]);
    expect(fs.existsSync(legacyInboundDbPath(CHAT))).toBe(false);
    expect(fs.existsSync(inboundDbPath(CHAT.agentGroupId, CHAT.sessionId))).toBe(true);
  });
});

it('keeps every row of sessions from before the upgrade, and the idle task still comes due (criterion 4)', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  legacySession(CHAT, [
    { id: 'm1', seq: 2, kind: 'chat' },
    { id: 'm2', seq: 4, kind: 'chat' },
  ]);
  legacySession(TASK, [{ id: 'task-1', seq: 2, kind: 'task', processAfter: past }]);
  const before = [rows(legacyInboundDbPath(CHAT)), rows(legacyInboundDbPath(TASK))];

  await moveInboundMailboxes(nothingListed);

  for (const [index, key] of [CHAT, TASK].entries()) {
    expect(rows(inboundDbPath(key.agentGroupId, key.sessionId))).toEqual(before[index]);
    expect(fs.existsSync(legacyInboundDbPath(key))).toBe(false);
  }
  const due = await new SqliteAgentMailbox().session(TASK, (mailbox) => mailbox.countDueMessages());
  expect(due).toBe(1);
});

describe('what the move copies and what it refuses (criterion 5)', () => {
  it('copies into a file the host creates, so a second name the seat made reaches only the old file', async () => {
    legacySession(CHAT, [{ id: 'm1', seq: 2, kind: 'chat' }]);
    const secondName = path.join(sessionMailboxDir(CHAT), 'second-name.db');
    fs.linkSync(legacyInboundDbPath(CHAT), secondName);

    await moveInboundMailboxes(nothingListed);

    const moved = inboundDbPath(CHAT.agentGroupId, CHAT.sessionId);
    expect(fs.statSync(moved).ino).not.toBe(fs.statSync(secondName).ino);
    const forged = new Database(secondName);
    forged
      .prepare("INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES ('forged', 6, 'chat', 'now', '{}')")
      .run();
    forged.close();
    expect(rows(moved).messages.map((row) => (row as { id: string }).id)).toEqual(['m1']);
  });

  it('refuses and logs an old path that is not a regular file, and keeps going', async () => {
    legacySession(TASK, [{ id: 'task-1', seq: 2, kind: 'task' }]);
    fs.mkdirSync(sessionMailboxDir(CHAT), { recursive: true });
    fs.symlinkSync(legacyInboundDbPath(TASK), legacyInboundDbPath(CHAT));

    await moveInboundMailboxes(nothingListed);

    expect(log.error).toHaveBeenCalledWith(
      'Inbound mailbox not moved; repair by hand',
      expect.objectContaining({ sessionId: CHAT.sessionId }),
    );
    expect(fs.existsSync(inboundDbPath(CHAT.agentGroupId, CHAT.sessionId))).toBe(false);
    expect(fs.existsSync(inboundDbPath(TASK.agentGroupId, TASK.sessionId))).toBe(true);
    expect(fs.existsSync(inboundMoveMarkPath())).toBe(true);
  });

  it('ignores a file placed at the old path after its one run', async () => {
    legacySession(CHAT, [{ id: 'm1', seq: 2, kind: 'chat' }]);
    await moveInboundMailboxes(nothingListed);
    const moved = inboundDbPath(CHAT.agentGroupId, CHAT.sessionId);
    const afterMove = rows(moved);

    legacySession(CHAT, [{ id: 'planted', seq: 2, kind: 'chat' }]);
    await moveInboundMailboxes(async () => [snapshot('nanoclaw-v2-alpha-1', 'running')]);

    expect(rows(moved)).toEqual(afterMove);
    expect(fs.existsSync(legacyInboundDbPath(CHAT))).toBe(true);
  });
});

it('round trip: move forward, copy back by the written steps, and move forward again (criterion 10)', async () => {
  legacySession(CHAT, [{ id: 'm1', seq: 2, kind: 'chat' }]);
  const original = rows(legacyInboundDbPath(CHAT));

  await moveInboundMailboxes(nothingListed);
  // The way back: copy each file to its old place and remove the mark.
  fs.copyFileSync(inboundDbPath(CHAT.agentGroupId, CHAT.sessionId), legacyInboundDbPath(CHAT));
  fs.rmSync(inboundMoveMarkPath());
  expect(rows(legacyInboundDbPath(CHAT))).toEqual(original);

  // Old code runs for a while and receives a row at the old path; the next move carries it.
  const db = new Database(legacyInboundDbPath(CHAT));
  db.prepare("INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES ('m2', 4, 'chat', 'now', '{}')").run();
  db.close();
  await moveInboundMailboxes(nothingListed);
  expect(rows(inboundDbPath(CHAT.agentGroupId, CHAT.sessionId)).maxSeq).toBe(4);
});
