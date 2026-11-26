/**
 * One-time move of each session's inbound.db out of the read-write session
 * folder into its host-only folder, which the container mounts read-only.
 *
 * Runs at host start, before anything opens a mailbox. The rows are copied
 * into a file the host creates (never renamed: a second name the seat made
 * for the old file would still reach a renamed one). Once the mark is
 * written, the old path is never read again.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import type { SessionSnapshot } from '../../drivers/types.js';
import { log } from '../../log.js';
import type { MailboxSessionKey } from '../types.js';
import {
  inboundMailboxDir,
  inboundMoveMarkPath,
  legacyInboundDbPath,
  sessionMailboxPath,
  sessionsRootDir,
} from './paths.js';

export async function moveInboundMailboxes(listSessions: () => Promise<SessionSnapshot[]>): Promise<void> {
  if (fs.existsSync(inboundMoveMarkPath())) return;

  // A container that is still running reads the old path and would go deaf
  // after the move. A listing that fails throws here and refuses the same way.
  const running = (await listSessions()).filter((s) => s.phase === 'running').map((s) => s.handle.name);
  if (running.length > 0) {
    throw new Error(
      `Inbound mailbox move refused: session containers still running (${running.join(', ')}). ` +
        'Stop them, then restart the service.',
    );
  }

  /* eslint-disable no-catch-all/no-catch-all -- one session's file must not stop the host; it is logged for a hand repair */
  for (const key of sessionKeys()) {
    try {
      moveOne(key);
    } catch (err) {
      log.error('Inbound mailbox not moved; repair by hand', { ...key, path: legacyInboundDbPath(key), err });
    }
  }
  /* eslint-enable no-catch-all/no-catch-all */
  fs.mkdirSync(sessionsRootDir(), { recursive: true });
  fs.writeFileSync(inboundMoveMarkPath(), `${new Date().toISOString()}\n`);
}

function sessionKeys(): MailboxSessionKey[] {
  const root = sessionsRootDir();
  if (!fs.existsSync(root)) return [];
  const keys: MailboxSessionKey[] = [];
  for (const group of fs.readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory() || group.name.startsWith('.')) continue;
    for (const session of fs.readdirSync(path.join(root, group.name), { withFileTypes: true })) {
      if (!session.isDirectory() || session.name.startsWith('.')) continue;
      keys.push({ agentGroupId: group.name, sessionId: session.name });
    }
  }
  return keys;
}

function moveOne(key: MailboxSessionKey): void {
  const legacy = legacyInboundDbPath(key);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(legacy);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isFile()) throw new Error('the old path is not a regular file');

  const target = sessionMailboxPath(key, 'inbound');
  fs.mkdirSync(inboundMailboxDir(key), { recursive: true });
  // A copy left by a move that died part way is replaced; the old file is still the record.
  fs.rmSync(target, { force: true });
  // Opening read-write rolls back a journal a killed host write left behind.
  const db = new Database(legacy);
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  for (const suffix of ['', '-journal']) fs.rmSync(`${legacy}${suffix}`, { force: true });
  log.info('Inbound mailbox moved', { ...key });
}
