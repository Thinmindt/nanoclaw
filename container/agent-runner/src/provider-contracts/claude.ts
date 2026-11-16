import {
  resolveClaudeExecutionPolicy,
  resolveClaudeInference,
  resolveClaudeMcpServers,
  resolveClaudeMemoryRuntime,
} from '../providers/claude-config.js';
import { newestClaudeTranscript } from '../providers/claude-history.js';

import { registerProviderContract } from '../providers/provider-registry.js';
import { PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION, type ProviderRuntimeContract } from './registry.js';

const provider = 'claude';

// The runner reads and writes no Claude settings file: the memory hook is an
// in-process callback (providers/claude.ts) and the host seeds the file.
export const claudeRuntimeContract: ProviderRuntimeContract = {
  seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  configuration: {
    // Claude's stance is fixed — the container and the OneCLI allow-list are
    // the boundary — so it is declared as the constant it is.
    executionPolicy: { constant: resolveClaudeExecutionPolicy() },
    inference: resolveClaudeInference,
    // The memory runtime env is likewise fixed: auto-memory stays off whatever
    // hook core registers, so it is a constant, not a function of the hook.
    memory: { constant: resolveClaudeMemoryRuntime() },
    mcpServers: resolveClaudeMcpServers,
  },
  // Pre-compact archiving and continuation rotation are provider-internal
  // (providers/claude-history.ts); core only needs the trace lookup.
  history: { readTrace: newestClaudeTranscript },
  textDelivery: 'mid-turn-complete',
  // Aliases are listed with their command, as in the host contract.
  commands: {
    formatting: 'native',
    nativeAdmin: [
      '/remote-control',
      '/rc',
      '/compact',
      '/context',
      '/cost',
      '/usage',
      '/stats',
      '/files',
      '/reset',
      '/new',
    ],
    nativeFiltered: ['/help', '/login', '/logout', '/doctor', '/checkup', '/config', '/settings', '/start'],
  },
};

registerProviderContract(provider, claudeRuntimeContract);
