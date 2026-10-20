import { configFromDb } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import { log } from '../../log.js';
import { notifyAgent } from '../../modules/approvals/index.js';
import { validateAdditionalMounts } from '../../modules/mount-security/index.js';
import {
  BUSY,
  formatPlaygroundResult,
  loadPlaygroundConfig,
  MAX_TIMEOUT_S,
  newRunId,
  parseEntry,
  parseFps,
  parseScriptArgs,
  parseTimeout,
  playgroundBusy,
  AGENT_DIR,
  type ProjectRoot,
  readProject,
  removeLeftoverSandboxes,
  runPlayground,
} from '../../playground-tool.js';
import { register } from '../registry.js';

let leftoversRemoved = false;

register({
  name: 'playground-run',
  action: 'playground.run',
  // No `resource`: reachable for agents with cli_scope=group, like the calendar command. Access is gated
  // by the agent groups listed in PLAYGROUND_AGENT_GROUPS instead.
  access: 'open',
  description:
    'Run a Node project in a sandbox with no network (Node 22 and its standard library only; 8 GB of ' +
    'memory). --dir <project folder: under /workspace/agent, or one of your read-only mounts under ' +
    '/workspace/extra> --entry <.js file in it> [--timeout <seconds, default 60, max ' +
    `${MAX_TIMEOUT_S}>] [--fps <video frame rate, default 30>] [--args <the script's own arguments>]. ` +
    'With --stdin-json, pass {"args": ["--seed", "3"]}, since a value starting with -- is read as a flag. ' +
    'The script runs with /out as its working folder; save frames there as frame-0001.png, frame-0002.png ' +
    'and so on, as many as you like: they become one MP4 (about 10 MB at most) and up to 16 evenly spaced ' +
    'stills. Other files left in /out (a census, a contact sheet) come back too. The command returns at ' +
    'once; when the run ends you get a message with the exit code, the last 4000 characters of output, ' +
    'and where everything was saved. One run at a time.',
  parseArgs: (raw) => raw,
  handler: async (args, ctx) => {
    const config = loadPlaygroundConfig();
    if (!config)
      throw new Error('The playground is not configured. The operator sets PLAYGROUND_AGENT_GROUPS in .env.');
    if (ctx.caller !== 'agent' || !ctx.sessionId)
      throw new Error("The playground runs scripts from an agent group's folder; call it from an agent.");
    if (!config.agentGroups.has(ctx.agentGroupId))
      throw new Error('This agent group is not allowed to use the playground.');
    const group = await getAgentGroup(ctx.agentGroupId);
    if (!group) throw new Error(`Agent group not found: ${ctx.agentGroupId}`);
    const a = args as Record<string, unknown>;
    const groupDir = resolveGroupFolderPath(group.folder);
    // The folders the agent can name, as it sees them: its own, and its mounts, re-validated the way
    // the container runner mounts them.
    const row = await getContainerConfig(group.id);
    const mounts = row ? validateAdditionalMounts(configFromDb(row, group).additionalMounts, group.name) : [];
    const roots: ProjectRoot[] = [{ containerPath: AGENT_DIR, hostPath: groupDir }, ...mounts];
    if (playgroundBusy()) throw new Error(BUSY);
    const project = readProject(roots, a.dir);
    const opts = {
      entry: parseEntry(a.entry, project),
      timeoutS: parseTimeout(a.timeout),
      fps: parseFps(a.fps),
      args: parseScriptArgs(a.args),
    };
    if (!leftoversRemoved) {
      leftoversRemoved = true;
      await removeLeftoverSandboxes(config).catch((err: unknown) =>
        log.warn('Could not remove leftover playground sandboxes', { err }),
      );
    }
    const run = newRunId();
    const sessionId = ctx.sessionId;
    // Runs last up to 30 minutes, far longer than an `ncl` call waits or the delivery poll may be
    // held, so the command only starts the run; the result arrives as a message that wakes the agent.
    void runPlayground(config, groupDir, project, opts, { run })
      .then((r) => formatPlaygroundResult(r))
      .catch((err: unknown) => `Playground run ${run} failed: ${err instanceof Error ? err.message : String(err)}`)
      .then(async (text) => {
        const session = await getSession(sessionId);
        if (session) await notifyAgent(session, text);
      })
      .catch((err: unknown) => log.error('Playground result not delivered', { run, sessionId, err }));
    return { run, started: true, timeout: opts.timeoutS };
  },
  formatHuman: (r) =>
    `Playground run ${r.run} started (time limit ${r.timeout}s). The result arrives as a message when it ends.`,
});
