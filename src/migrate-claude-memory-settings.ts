import path from 'path';

import { AnchoredDir } from './anchored-dir.js';
import { log } from './log.js';
import type { ProviderFileDiagnostic, ProviderFileTransformer } from './provider-contracts/registry.js';

const CLAUDE_SETTINGS_FILE = 'settings.json';
const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';
// The runner now passes the memory hook in the SDK's flag-level settings, so a
// command entry for either script in this file would inject memory a second time.
const MEMORY_SESSION_START_COMMANDS = new Set(['bun /app/src/memory/hook.ts', 'bun /app/src/memory-hook.ts']);
// Extra mounts are no longer added directories, so the switch that loads
// instruction files from them has nothing to do and is removed.
const ADDED_DIRECTORIES_INSTRUCTIONS_ENV = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';
// Claude Code's own default output style, seeded only when the key is missing
// so a seat's own choice stays. With a named style (such as Concise) Claude
// Code adds a style message to every request, and the conversation is then not
// read back from the prompt cache. The concise instruction is in the agent's
// CLAUDE.md (container/CLAUDE.md, Communication), in the cached prefix.
const DEFAULT_OUTPUT_STYLE = 'default';

export const CLAUDE_DEFAULT_SETTINGS =
  JSON.stringify(
    {
      autoMemoryEnabled: false,
      outputStyle: DEFAULT_OUTPUT_STYLE,
      env: {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: PRE_COMPACT_COMMAND,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Seed or reconcile `settings.json` in the Claude state directory. The
 * directory is a read-write mount, so the file is reached through the
 * directory's descriptor: a symlink or FIFO planted under its name is refused
 * and the settings are left alone. Returns what was done.
 */
export function prepareClaudeMemorySettings(claudeDir: string): 'created' | 'reconciled' | 'unchanged' {
  const settingsFile = path.join(claudeDir, CLAUDE_SETTINGS_FILE);
  let dir: AnchoredDir | null = null;
  try {
    dir = AnchoredDir.open(claudeDir, [], true);
    if (!dir) throw new Error(`Claude settings directory is missing: '${claudeDir}'`);
    let current: string;
    try {
      current = dir.readFile(CLAUDE_SETTINGS_FILE).toString('utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      dir.writeNewFile(CLAUDE_SETTINGS_FILE, Buffer.from(CLAUDE_DEFAULT_SETTINGS));
      return 'created';
    }
    const result = claudeSettingsTransformer.transform(current, settingsFile);
    if (result.kind === 'invalid') {
      log.warn('Claude settings are invalid; leaving them unchanged', { settingsFile, reason: result.reason });
      return 'unchanged';
    }
    emitDiagnostics(result.diagnostics);
    if (result.kind === 'unchanged') return 'unchanged';
    dir.replaceFile(CLAUDE_SETTINGS_FILE, result.content);
    return 'reconciled';
  } catch (err) {
    emitDiagnostic(claudeSettingsTransformer.mapIoFailure(err, settingsFile));
    return 'unchanged';
  } finally {
    dir?.close();
  }
}

export const claudeSettingsTransformer: ProviderFileTransformer = {
  transform(current) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return { kind: 'invalid', reason: 'does not parse as JSON' };
    }
    if (!isRecord(parsed)) return { kind: 'invalid', reason: 'root is not a JSON object' };

    let changed = false;
    if (parsed.autoMemoryEnabled !== false) {
      parsed.autoMemoryEnabled = false;
      changed = true;
    }
    if (parsed.outputStyle === undefined) {
      parsed.outputStyle = DEFAULT_OUTPUT_STYLE;
      changed = true;
    }

    const env = isRecord(parsed.env) ? parsed.env : {};
    if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') {
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      changed = true;
    }
    if (ADDED_DIRECTORIES_INSTRUCTIONS_ENV in env) {
      delete env[ADDED_DIRECTORIES_INSTRUCTIONS_ENV];
      changed = true;
    }
    if (parsed.env !== env) {
      parsed.env = env;
      changed = true;
    }

    const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
    const existingSessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const nextSessionStart = existingSessionStart.map(removeMemoryHook).filter((entry) => entry !== undefined);
    if (JSON.stringify(nextSessionStart) !== JSON.stringify(existingSessionStart)) {
      if (nextSessionStart.length > 0) hooks.SessionStart = nextSessionStart;
      else delete hooks.SessionStart;
      changed = true;
    }

    const preCompact = Array.isArray(hooks.PreCompact) ? hooks.PreCompact : [];
    if (!JSON.stringify(preCompact).includes(PRE_COMPACT_COMMAND)) {
      preCompact.push({ hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }] });
      hooks.PreCompact = preCompact;
      changed = true;
    }
    if (parsed.hooks !== hooks) {
      parsed.hooks = hooks;
      changed = true;
    }

    return changed ? { kind: 'replace', content: JSON.stringify(parsed, null, 2) + '\n' } : { kind: 'unchanged' };
  },
  mapIoFailure: failedDiagnostic,
};

function failedDiagnostic(err: unknown, settingsFile: string): ProviderFileDiagnostic {
  return {
    level: 'warn',
    message: 'Failed to reconcile Claude settings; leaving them unchanged',
    fields: {
      settingsFile,
      error: err instanceof Error ? err.message : String(err),
    },
  };
}

function emitDiagnostics(diagnostics: readonly ProviderFileDiagnostic[] | undefined): void {
  for (const diagnostic of diagnostics ?? []) emitDiagnostic(diagnostic);
}

function emitDiagnostic(diagnostic: ProviderFileDiagnostic): void {
  log[diagnostic.level](diagnostic.message, diagnostic.fields);
}

function removeMemoryHook(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const remaining = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !MEMORY_SESSION_START_COMMANDS.has(hook.command);
  });
  return remaining.length > 0 ? { ...value, hooks: remaining } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
