import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { MailboxSessionKey } from '../types.js';

export function sessionsRootDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** The session folder: outbound.db and the agent's working files. Mounted read-write. */
export function sessionMailboxDir(key: MailboxSessionKey): string {
  return path.join(sessionsRootDir(), key.agentGroupId, key.sessionId);
}

/** Host-only folder holding the session's inbound.db, mounted read-only into the container. */
export function inboundMailboxDir(key: MailboxSessionKey): string {
  return path.join(sessionsRootDir(), key.agentGroupId, '.inbound', key.sessionId);
}

export function sessionMailboxPath(key: MailboxSessionKey, side: 'inbound' | 'outbound'): string {
  return side === 'inbound'
    ? path.join(inboundMailboxDir(key), 'inbound.db')
    : path.join(sessionMailboxDir(key), 'outbound.db');
}

export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return sessionMailboxPath({ agentGroupId, sessionId }, 'inbound');
}

export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return sessionMailboxPath({ agentGroupId, sessionId }, 'outbound');
}

/** Where inbound.db sat before it moved out of the writable session folder. Read only by the one-time move. */
export function legacyInboundDbPath(key: MailboxSessionKey): string {
  return path.join(sessionMailboxDir(key), 'inbound.db');
}

/** Written once the one-time move has run; from then on the legacy path is never read. */
export function inboundMoveMarkPath(): string {
  return path.join(sessionsRootDir(), '.inbound-moved');
}
