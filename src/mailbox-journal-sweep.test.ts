/**
 * The kill test (nanoclaw-99 criterion 9), host half: a host writer killed
 * inside a write leaves a real journal in inbound.db. A read-only reader (the
 * runner's view through its read-only mount) cannot roll it back; the sweep's
 * per-session pass opens the file read-write, which does. The runner half
 * (the poll loop staying up and reading the rows after) is
 * container/agent-runner/src/poll-loop.mailbox-journal.test.ts.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-mailbox-journal-sweep' };
});
vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createSession } from './db/sessions.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import { reconcileSession } from './reconcile-session.js';
import { initSessionFolder, writeSessionMessage } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-mailbox-journal-sweep';
const AG = 'ag-journal';
const SESS = 'sess-journal';

function readOnlyIds(): string[] {
  const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
  try {
    return (db.prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{ id: string }>).map((r) => r.id);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = await initTestDb();
  await runMigrations(db);
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: AG, name: 'Journal', folder: 'journal', agent_provider: null, created_at });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at,
  });
  initSessionFolder(AG, SESS);
  await writeSessionMessage(AG, SESS, { id: 'committed', kind: 'chat', timestamp: created_at, content: '{}' });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

it('the next sweep pass clears a journal a killed host write left, and a read-only read then sees the rows', async () => {
  spawnSync(
    process.execPath,
    [
      '-e',
      `const Database = require('better-sqlite3');
       const db = new Database(${JSON.stringify(inboundDbPath(AG, SESS))});
       db.pragma('cache_size = 1');
       db.exec('BEGIN');
       const insert = db.prepare("INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', 'now', ?)");
       for (let i = 0; i < 2000; i++) insert.run('ghost-' + i, 1000 + 2 * i, 'x'.repeat(200));
       process.kill(process.pid, 'SIGKILL');`,
    ],
    { cwd: process.cwd() },
  );
  expect(fs.statSync(`${inboundDbPath(AG, SESS)}-journal`).size).toBeGreaterThan(0);
  expect(readOnlyIds).toThrow(expect.objectContaining({ code: 'SQLITE_READONLY_ROLLBACK' }));

  await reconcileSession(SESS);

  expect(fs.existsSync(`${inboundDbPath(AG, SESS)}-journal`)).toBe(false);
  expect(readOnlyIds()).toEqual(['committed']);
});
