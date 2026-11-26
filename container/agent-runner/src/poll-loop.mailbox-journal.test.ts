/**
 * The kill test (nanoclaw-99 criterion 9), runner half: a host writer killed
 * inside a write leaves a real journal that the runner's read-only reader
 * cannot roll back. The poll loop must stay up through the failed reads and
 * read the rows once the journal is cleared. The host's sweep clearing that
 * journal is shown in src/mailbox-journal-sweep.test.ts; here a
 * read-write open stands in for it, since the host runs under Node.
 */
import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, initTestSessionDb, useInboundFileForTests } from './mailbox/sqlite/connection.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider } from './providers/types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-journal-'));
const dbPath = path.join(dir, 'inbound.db');

const seed = new Database(dbPath);
seed.exec('PRAGMA journal_mode = DELETE');
seed.exec(`
  CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
    status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT,
    tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, platform_id TEXT,
    channel_type TEXT, thread_id TEXT, content TEXT NOT NULL, on_wake INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, platform_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'delivered', delivered_at TEXT NOT NULL);
  CREATE TABLE destinations (name TEXT PRIMARY KEY, display_name TEXT, type TEXT NOT NULL,
    channel_type TEXT, platform_id TEXT, agent_group_id TEXT);
`);
seed
  .prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, platform_id, channel_type, content)
     VALUES ('request-a', 2, 'chat', ?, 'channel-1', 'slack', ?)`,
  )
  .run(new Date().toISOString(), JSON.stringify({ text: 'hello from before the crash' }));
seed.close();

// The host writer, killed inside its transaction: pages already spilled, journal left hot.
Bun.spawnSync([
  process.execPath,
  '-e',
  `const { Database } = require('bun:sqlite');
   const db = new Database(${JSON.stringify(dbPath)});
   db.exec('PRAGMA cache_size = 1');
   db.exec('BEGIN');
   const insert = db.prepare("INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', '2026-01-01', ?)");
   for (let i = 0; i < 2000; i++) insert.run('ghost-' + i, 1000 + 2 * i, JSON.stringify({ text: 'x'.repeat(200) }));
   process.kill(process.pid, 'SIGKILL');`,
]);

// Bun on macOS uses the system SQLite, which reads past a hot journal; Linux
// Bun (the agent image, CI) refuses, which is the case under test.
const reportsHotJournal = (() => {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.prepare('SELECT count(*) FROM messages_in').get();
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
})();

afterEach(() => {
  closeSessionDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

it.skipIf(!reportsHotJournal)(
  'stays up through a leftover journal and reads the rows once it is cleared',
  async () => {
    expect(fs.statSync(`${dbPath}-journal`).size).toBeGreaterThan(0);
    initTestSessionDb();
    useInboundFileForTests(dbPath);

    const controller = new AbortController();
    const prompts: string[] = [];
    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      query: (input) => {
        prompts.push(input.prompt);
        controller.abort();
        return { events: (async function* () {})(), push: () => {}, end: () => {}, abort: () => {} };
      },
    };
    let ended = false;
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: dir, signal: controller.signal }).finally(() => {
      ended = true;
    });

    // Two reads fail in full (1 s of retries each, then the poll interval).
    await Bun.sleep(2500);
    expect(ended).toBe(false);
    expect(prompts).toEqual([]);

    // The host's sweep opens the file read-write, which rolls the journal back.
    const host = new Database(dbPath);
    host.prepare('SELECT count(*) FROM messages_in').get();
    host.close();
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(false);

    await loop;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('hello from before the crash');
    expect(prompts[0]).not.toContain('ghost');
  },
  10_000,
);
