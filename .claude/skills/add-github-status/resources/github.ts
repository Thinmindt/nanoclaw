import {
  formatIssueStatus,
  formatPullStatus,
  gatewayFetcher,
  issueStatus,
  loadGithubStatusConfig,
  pullStatus,
  type GithubStatusConfig,
  type StatusArgs,
} from '../../github-status.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

/**
 * Keys the CLI framework may add that carry no query data. Dispatch auto-fills `agent_group_id` and
 * `group` for group-scoped agents; the caller's group is taken from the authenticated context instead.
 */
const IGNORED_FIELDS = new Set(['help', 'agent_group_id', 'group']);

function configured(ctx: CallerContext): GithubStatusConfig {
  const config = loadGithubStatusConfig();
  if (!config) {
    throw new Error(
      'The GitHub status tool is not configured. The operator sets GITHUB_STATUS_OWNER_LOGIN, ' +
        'GITHUB_STATUS_REPOS, GITHUB_STATUS_GATEWAY_AGENT and GITHUB_STATUS_AGENT_GROUPS in .env.',
    );
  }
  if (ctx.caller === 'agent' && !config.agentGroups.has(ctx.agentGroupId)) {
    throw new Error('This agent group is not allowed to use the GitHub status tool.');
  }
  return config;
}

/** `--repo <name> [--pr|--issue N] [--all]`, with unknown flags refused. */
function statusArgs(raw: Record<string, unknown>, numberKey: 'pr' | 'issue'): StatusArgs {
  const allowed = new Set(['repo', numberKey, 'all']);
  const input: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) input[key.replace(/-/g, '_')] = value;
  for (const key of Object.keys(input)) {
    if (IGNORED_FIELDS.has(key) || allowed.has(key)) continue;
    throw new Error(`unknown field --${key}; allowed: ${[...allowed].map((k) => `--${k}`).join(', ')}`);
  }
  const args: StatusArgs = { repo: typeof input.repo === 'string' ? input.repo : '' };
  if (input[numberKey] !== undefined && input[numberKey] !== null && input[numberKey] !== '') {
    const n = Number(input[numberKey]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${numberKey} must be a positive whole number`);
    args.number = n;
  }
  if (input.all === true || input.all === 'true') args.all = true;
  return args;
}

// No `resource` on any of these: a command without one stays reachable for agents with cli_scope=group
// (the guard's resource whitelist applies only to commands that name a resource). Access is gated by the
// agent groups listed in GITHUB_STATUS_AGENT_GROUPS instead.

register({
  name: 'github-repos',
  action: 'github.repos',
  access: 'open',
  description: 'List the repository names the GitHub status tool knows, for --repo.',
  parseArgs: (raw) => raw,
  handler: async (_args, ctx) => {
    const config = configured(ctx);
    return [...config.repos.values()].map((r) => ({ name: r.name, repository: `${r.owner}/${r.repo}` }));
  },
  formatHuman: (rows) =>
    (rows as { name: string; repository: string }[]).map((r) => `${r.name}\t${r.repository}`).join('\n'),
});

register({
  name: 'github-pr-status',
  action: 'github.pr-status',
  access: 'open',
  description:
    'Pull request status for one repository: number, state, draft, merged, checks, reviews, dates. ' +
    '--repo <name> (see github repos); --pr <number> for one pull request with your own description ' +
    'and comments; --all to include closed and merged ones. Text written by anyone but the owner is ' +
    'never shown.',
  parseArgs: (raw) => statusArgs(raw as Record<string, unknown>, 'pr'),
  handler: async (args, ctx) => {
    const config = configured(ctx);
    return pullStatus(config, gatewayFetcher(config), args);
  },
  formatHuman: (result) => formatPullStatus(result),
});

register({
  name: 'github-issue-status',
  action: 'github.issue-status',
  access: 'open',
  description:
    'Issue status for one repository: number, state, labels, comment count, dates. --repo <name>; ' +
    '--issue <number> for one issue with your own description and comments; --all to include closed ' +
    'ones. Text written by anyone but the owner is never shown.',
  parseArgs: (raw) => statusArgs(raw as Record<string, unknown>, 'issue'),
  handler: async (args, ctx) => {
    const config = configured(ctx);
    return issueStatus(config, gatewayFetcher(config), args);
  },
  formatHuman: (result) => formatIssueStatus(result),
});
