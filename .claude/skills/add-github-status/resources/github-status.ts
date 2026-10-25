/**
 * GitHub status tool — lets an agent read the state of pull requests and
 * issues on the owner's repositories, and the owner's own words on them, and
 * nothing anyone else wrote.
 *
 * Why a host-side tool rather than a gateway rule: a read-only gateway rule
 * would let the agent read every comment on a public repository, and a comment
 * is text a stranger can write. The agent that keeps the owner's private plan
 * must not read strangers' prose. So:
 *
 *   - `summarizePulls` / `summarizeIssues` (pure) reduce GitHub's responses to
 *     fixed fields (numbers, states, logins, counts, dates). Free text is kept
 *     only when its author is `GITHUB_STATUS_OWNER_LOGIN`; anyone else's title,
 *     body, comment or branch name is replaced by a placeholder naming the
 *     login. Kept text is reduced to bounded plain text.
 *   - The gateway identity the tool calls as allows GET on the
 *     configured repositories' API paths and nothing else, so no input can
 *     turn the tool into a way to post.
 */
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

export const MAX_TITLE = 200;
export const MAX_BODY = 4000;
export const MAX_COMMENT = 2000;
export const MAX_COMMENTS = 20;
export const MAX_ITEMS = 30;
export const MAX_CHECKS = 50;
export const MAX_LABEL = 50;

export type RepoRef = { name: string; owner: string; repo: string };

export type GithubStatusConfig = {
  /** The owner's GitHub login: the only author whose text the tool passes on. */
  ownerLogin: string;
  /** Repositories by the short name the agent uses, in the order configured. */
  repos: Map<string, RepoRef>;
  /** Gateway agent identifier the tool calls as; its policy allows GET on these repos only. */
  gatewayAgent: string;
  /** Agent groups allowed to call the tool. */
  agentGroups: Set<string>;
  onecliBin: string;
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OWNER_REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** `name=owner/repo,name2=owner/repo2` → repos by name. Throws on a malformed entry. */
export function parseRepos(value: string | undefined): Map<string, RepoRef> {
  const repos = new Map<string, RepoRef>();
  for (const entry of (value ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const name = eq === -1 ? trimmed.slice(trimmed.indexOf('/') + 1) : trimmed.slice(0, eq).trim();
    const full = (eq === -1 ? trimmed : trimmed.slice(eq + 1)).trim();
    const m = OWNER_REPO_RE.exec(full);
    if (!NAME_RE.test(name) || !m) {
      throw new Error(`GITHUB_STATUS_REPOS entry "${trimmed}" is not name=owner/repo`);
    }
    if (repos.has(name)) throw new Error(`GITHUB_STATUS_REPOS names "${name}" twice`);
    repos.set(name, { name, owner: m[1], repo: m[2] });
  }
  return repos;
}

/** Read the tool's settings; null when it is not configured (the command then explains how). */
export function readGithubStatusConfig(env: Record<string, string | undefined>): GithubStatusConfig | null {
  const ownerLogin = env.GITHUB_STATUS_OWNER_LOGIN?.trim();
  const gatewayAgent = env.GITHUB_STATUS_GATEWAY_AGENT?.trim();
  const groups = (env.GITHUB_STATUS_AGENT_GROUPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const repos = parseRepos(env.GITHUB_STATUS_REPOS);
  if (!ownerLogin || !gatewayAgent || groups.length === 0 || repos.size === 0) return null;
  return {
    ownerLogin,
    repos,
    gatewayAgent,
    agentGroups: new Set(groups),
    onecliBin: env.ONECLI_BIN?.trim() || path.join(os.homedir(), '.local', 'bin', 'onecli'),
  };
}

export const ENV_KEYS = [
  'GITHUB_STATUS_OWNER_LOGIN',
  'GITHUB_STATUS_REPOS',
  'GITHUB_STATUS_GATEWAY_AGENT',
  'GITHUB_STATUS_AGENT_GROUPS',
  'ONECLI_BIN',
];

export function loadGithubStatusConfig(): GithubStatusConfig | null {
  const file = readEnvFile(ENV_KEYS);
  const merged: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) merged[k] = process.env[k] || file[k];
  return readGithubStatusConfig(merged);
}

// ---------------------------------------------------------------------------
// Text reduction: the same idea as the Scout gate's inbound half, kept local so
// this tool stands on its own. Only the owner's text ever reaches it.
// ---------------------------------------------------------------------------

const INVISIBLE =
  // eslint-disable-next-line no-control-regex -- the control characters are the point of the rule
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/gu;
const TAG = /<\/?[a-z!?][^<>]{0,200}>/gi;

/** Plain text, bounded: invisible characters and tags removed, cut at `max` with a marker. */
export function plainText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(TAG, '').trim();
  if (text.length > max) {
    const marker = `\n[cut at ${max} characters]`;
    const keep = Math.max(0, max - marker.length);
    text = keep ? `${text.slice(0, keep).trimEnd()}${marker}` : text.slice(0, max);
  }
  return text;
}

// ---------------------------------------------------------------------------
// GitHub's shapes, only the fields read here.
// ---------------------------------------------------------------------------

type GhUser = { login?: string } | null | undefined;
type GhLabel = { name?: string } | string;
type GhPull = {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  user?: GhUser;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  created_at?: string;
  updated_at?: string;
  labels?: GhLabel[];
};
type GhIssue = {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  state_reason?: string | null;
  user?: GhUser;
  labels?: GhLabel[];
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: unknown;
};
type GhReview = { user?: GhUser; state?: string; submitted_at?: string; body?: string | null };
type GhComment = { user?: GhUser; body?: string | null; created_at?: string };
type GhCheckRun = { name?: string; status?: string; conclusion?: string | null };

export type OwnerComment = { at: string; text: string };
export type OwnerText = { body: string; comments: OwnerComment[] };

export type PullSummary = {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  head: string;
  base: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  checks: { total: number; passed: number; failed: number; pending: number; failed_names: string[] };
  reviews: { approved: string[]; changes_requested: string[] };
  mergeable?: boolean | null;
  mergeable_state?: string;
  /** Present only in single-item mode, and only when the owner wrote the text. */
  your_text?: OwnerText;
};

export type IssueSummary = {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: string[];
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  your_text?: OwnerText;
};

export type PullStatusResult = {
  repo: string;
  repository: string;
  owner_login: string;
  fetched_at: string;
  scope: 'open' | 'all' | 'one';
  pulls: PullSummary[];
};

export type IssueStatusResult = {
  repo: string;
  repository: string;
  owner_login: string;
  fetched_at: string;
  scope: 'open' | 'all' | 'one';
  issues: IssueSummary[];
};

const login = (u: GhUser): string => (u && typeof u.login === 'string' ? u.login : 'unknown');
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const stamp = (s: unknown): string => (typeof s === 'string' ? s : '');

/** Free text is the owner's, or it is a placeholder naming who wrote it. */
function ownedText(raw: unknown, author: string, ownerLogin: string, max: number, what: string): string {
  if (!sameLogin(author, ownerLogin)) return `[${what} by ${author} not shown]`;
  return plainText(raw, max);
}

function labelNames(labels: GhLabel[] | undefined): string[] {
  return (labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n): n is string => typeof n === 'string')
    .map((n) => plainText(n, MAX_LABEL))
    .filter(Boolean);
}

const PASSED = new Set(['success', 'neutral', 'skipped']);
const PENDING_STATUS = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export function summarizeChecks(runs: GhCheckRun[]): PullSummary['checks'] {
  const checks = { total: 0, passed: 0, failed: 0, pending: 0, failed_names: [] as string[] };
  for (const run of runs.slice(0, MAX_CHECKS)) {
    checks.total += 1;
    if (run.status !== 'completed' || PENDING_STATUS.has(run.status ?? '')) {
      checks.pending += 1;
    } else if (PASSED.has(run.conclusion ?? '')) {
      checks.passed += 1;
    } else {
      checks.failed += 1;
      checks.failed_names.push(plainText(run.name ?? 'unnamed check', 100));
    }
  }
  return checks;
}

/** The latest non-comment review per reviewer decides where that reviewer stands. */
export function summarizeReviews(reviews: GhReview[]): PullSummary['reviews'] {
  const latest = new Map<string, { state: string; at: string }>();
  for (const review of reviews) {
    const state = (review.state ?? '').toUpperCase();
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;
    const who = login(review.user);
    const at = stamp(review.submitted_at);
    const prev = latest.get(who);
    if (!prev || prev.at <= at) latest.set(who, { state, at });
  }
  const approved: string[] = [];
  const changesRequested: string[] = [];
  for (const [who, { state }] of latest) {
    if (state === 'APPROVED') approved.push(who);
    else if (state === 'CHANGES_REQUESTED') changesRequested.push(who);
  }
  return { approved: approved.sort(), changes_requested: changesRequested.sort() };
}

/** The owner's comments only, oldest first, at most MAX_COMMENTS of the newest. */
export function ownerComments(comments: GhComment[], ownerLogin: string): OwnerComment[] {
  return comments
    .filter((c) => sameLogin(login(c.user), ownerLogin))
    .map((c) => ({ at: stamp(c.created_at), text: plainText(c.body, MAX_COMMENT) }))
    .filter((c) => c.text)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_COMMENTS);
}

export function summarizePull(
  pull: GhPull,
  ownerLogin: string,
  extras: { reviews: GhReview[]; checkRuns: GhCheckRun[]; comments?: GhComment[] },
): PullSummary {
  const author = login(pull.user);
  const summary: PullSummary = {
    number: pull.number,
    title: ownedText(pull.title, author, ownerLogin, MAX_TITLE, 'title'),
    author,
    state: pull.state === 'closed' ? 'closed' : 'open',
    draft: pull.draft === true,
    merged: pull.merged === true || typeof pull.merged_at === 'string',
    merged_at: typeof pull.merged_at === 'string' ? pull.merged_at : null,
    head: ownedText(pull.head?.ref, author, ownerLogin, 100, 'branch'),
    base: plainText(pull.base?.ref, 100),
    labels: labelNames(pull.labels),
    created_at: stamp(pull.created_at),
    updated_at: stamp(pull.updated_at),
    checks: summarizeChecks(extras.checkRuns),
    reviews: summarizeReviews(extras.reviews),
  };
  if (pull.mergeable !== undefined) summary.mergeable = pull.mergeable ?? null;
  if (typeof pull.mergeable_state === 'string') summary.mergeable_state = plainText(pull.mergeable_state, 40);
  if (extras.comments) {
    summary.your_text = {
      body: sameLogin(author, ownerLogin) ? plainText(pull.body, MAX_BODY) : '',
      comments: ownerComments(extras.comments, ownerLogin),
    };
  }
  return summary;
}

export function summarizeIssue(issue: GhIssue, ownerLogin: string, comments?: GhComment[]): IssueSummary {
  const author = login(issue.user);
  const summary: IssueSummary = {
    number: issue.number,
    title: ownedText(issue.title, author, ownerLogin, MAX_TITLE, 'title'),
    author,
    state: issue.state === 'closed' ? 'closed' : 'open',
    state_reason: typeof issue.state_reason === 'string' ? plainText(issue.state_reason, 40) : null,
    labels: labelNames(issue.labels),
    comments: typeof issue.comments === 'number' ? issue.comments : 0,
    created_at: stamp(issue.created_at),
    updated_at: stamp(issue.updated_at),
    closed_at: typeof issue.closed_at === 'string' ? issue.closed_at : null,
  };
  if (comments) {
    summary.your_text = {
      body: sameLogin(author, ownerLogin) ? plainText(issue.body, MAX_BODY) : '',
      comments: ownerComments(comments, ownerLogin),
    };
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Fetching, through the gateway.
// ---------------------------------------------------------------------------

/** Fetches one API path (`/repos/...`) and returns its parsed JSON; injectable for tests. */
export type Fetcher = (apiPath: string) => Promise<unknown>;

/** Runs a command and returns stdout; injectable for tests. */
export type Runner = (bin: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gateway call failed: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });

/** The exact gateway invocation, separated so tests can check it is a GET under the tool identity. */
export function requestArgs(config: GithubStatusConfig, apiPath: string): { args: string[]; url: string } {
  if (!apiPath.startsWith('/repos/')) throw new Error(`refusing to fetch outside /repos/: ${apiPath}`);
  const url = `https://api.github.com${apiPath}`;
  const args = [
    'run',
    '--agent',
    config.gatewayAgent,
    '--',
    'curl',
    '-sS',
    '--max-time',
    '20',
    '-X',
    'GET',
    '-H',
    'accept: application/vnd.github+json',
    '-H',
    'x-github-api-version: 2022-11-28',
    '-H',
    'user-agent: nanoclaw-github-status',
    '-w',
    '\n%{http_code}',
    url,
  ];
  return { args, url };
}

export function gatewayFetcher(config: GithubStatusConfig, run: Runner = defaultRunner): Fetcher {
  return async (apiPath) => {
    const { args } = requestArgs(config, apiPath);
    const out = await run(config.onecliBin, args);
    const nl = out.lastIndexOf('\n');
    const status = Number(out.slice(nl + 1).trim());
    const payload = out.slice(0, nl);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // the status decides
    }
    if (status >= 200 && status < 300) return parsed;
    const message =
      parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
        ? (parsed as { message: string }).message
        : payload.slice(0, 200);
    if (status === 403 || status === 429) {
      if (/rate limit/i.test(message)) {
        throw new Error(
          `GitHub's rate limit is used up for now (HTTP ${status}). Try again later; the operator can ` +
            'give the tool identity a read-only token to raise the limit.',
        );
      }
      throw new Error(`GitHub refused the request (HTTP ${status}): ${plainText(message, 200)}`);
    }
    if (status === 404) throw new Error('GitHub answered 404: the repository, pull request or issue was not found.');
    throw new Error(`GitHub answered HTTP ${status || 'unknown'}: ${plainText(message, 200)}`);
  };
}

// ---------------------------------------------------------------------------
// The two queries.
// ---------------------------------------------------------------------------

export type StatusArgs = { repo: string; number?: number; all?: boolean };

export function resolveRepo(config: GithubStatusConfig, name: unknown): RepoRef {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`--repo is required; one of: ${[...config.repos.keys()].join(', ')}`);
  }
  const ref = config.repos.get(name.trim());
  if (!ref) throw new Error(`unknown repo "${name}"; one of: ${[...config.repos.keys()].join(', ')}`);
  return ref;
}

function asList<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

export async function pullStatus(
  config: GithubStatusConfig,
  fetch: Fetcher,
  args: StatusArgs,
): Promise<PullStatusResult> {
  const ref = resolveRepo(config, args.repo);
  const base = `/repos/${ref.owner}/${ref.repo}`;
  const result: PullStatusResult = {
    repo: ref.name,
    repository: `${ref.owner}/${ref.repo}`,
    owner_login: config.ownerLogin,
    fetched_at: new Date().toISOString(),
    scope: args.number ? 'one' : args.all ? 'all' : 'open',
    pulls: [],
  };
  if (args.number) {
    const pull = (await fetch(`${base}/pulls/${args.number}`)) as GhPull;
    const [reviews, checks, issueComments, reviewComments] = await Promise.all([
      fetch(`${base}/pulls/${args.number}/reviews?per_page=100`),
      pull.head?.sha ? fetch(`${base}/commits/${pull.head.sha}/check-runs?per_page=${MAX_CHECKS}`) : null,
      fetch(`${base}/issues/${args.number}/comments?per_page=100`),
      fetch(`${base}/pulls/${args.number}/comments?per_page=100`),
    ]);
    result.pulls.push(
      summarizePull(pull, config.ownerLogin, {
        reviews: asList<GhReview>(reviews),
        checkRuns: asList<GhCheckRun>((checks as { check_runs?: unknown })?.check_runs),
        comments: [...asList<GhComment>(issueComments), ...asList<GhComment>(reviewComments)],
      }),
    );
    return result;
  }
  const state = args.all ? 'all' : 'open';
  const pulls = asList<GhPull>(
    await fetch(`${base}/pulls?state=${state}&sort=updated&direction=desc&per_page=${MAX_ITEMS}`),
  );
  for (const pull of pulls) {
    const [reviews, checks] = await Promise.all([
      fetch(`${base}/pulls/${pull.number}/reviews?per_page=100`),
      pull.head?.sha ? fetch(`${base}/commits/${pull.head.sha}/check-runs?per_page=${MAX_CHECKS}`) : null,
    ]);
    result.pulls.push(
      summarizePull(pull, config.ownerLogin, {
        reviews: asList<GhReview>(reviews),
        checkRuns: asList<GhCheckRun>((checks as { check_runs?: unknown })?.check_runs),
      }),
    );
  }
  return result;
}

export async function issueStatus(
  config: GithubStatusConfig,
  fetch: Fetcher,
  args: StatusArgs,
): Promise<IssueStatusResult> {
  const ref = resolveRepo(config, args.repo);
  const base = `/repos/${ref.owner}/${ref.repo}`;
  const result: IssueStatusResult = {
    repo: ref.name,
    repository: `${ref.owner}/${ref.repo}`,
    owner_login: config.ownerLogin,
    fetched_at: new Date().toISOString(),
    scope: args.number ? 'one' : args.all ? 'all' : 'open',
    issues: [],
  };
  if (args.number) {
    const issue = (await fetch(`${base}/issues/${args.number}`)) as GhIssue;
    if (issue.pull_request) throw new Error(`#${args.number} is a pull request; use pr-status`);
    const comments = asList<GhComment>(await fetch(`${base}/issues/${args.number}/comments?per_page=100`));
    result.issues.push(summarizeIssue(issue, config.ownerLogin, comments));
    return result;
  }
  const state = args.all ? 'all' : 'open';
  const issues = asList<GhIssue>(
    await fetch(`${base}/issues?state=${state}&sort=updated&direction=desc&per_page=${MAX_ITEMS}`),
  );
  for (const issue of issues) {
    if (issue.pull_request) continue; // GitHub lists pull requests as issues too
    result.issues.push(summarizeIssue(issue, config.ownerLogin));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Human rendering.
// ---------------------------------------------------------------------------

function pullLine(p: PullSummary): string {
  const state = p.merged ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open';
  const checks =
    p.checks.total === 0
      ? 'no checks'
      : p.checks.failed
        ? `checks ${p.checks.failed} failed (${p.checks.failed_names.join(', ')})`
        : p.checks.pending
          ? `checks ${p.checks.pending} pending`
          : `checks ${p.checks.passed}/${p.checks.total} passed`;
  const review = p.reviews.changes_requested.length
    ? `changes requested by ${p.reviews.changes_requested.join(', ')}`
    : p.reviews.approved.length
      ? `approved by ${p.reviews.approved.join(', ')}`
      : 'no review';
  const merge = p.mergeable === false ? `, ${p.mergeable_state ?? 'not mergeable'}` : '';
  return `#${p.number} ${state} "${p.title}" (${p.author}) ${p.head} -> ${p.base}; ${checks}; ${review}${merge}; updated ${p.updated_at}`;
}

function yourText(t: OwnerText | undefined): string[] {
  if (!t) return [];
  const lines: string[] = [];
  if (t.body) lines.push('', 'Your description:', t.body);
  for (const c of t.comments) lines.push('', `Your comment at ${c.at}:`, c.text);
  return lines;
}

export function formatPullStatus(r: PullStatusResult): string {
  const head = `${r.repository} (${r.repo}), ${r.scope === 'open' ? 'open pull requests' : r.scope === 'all' ? 'latest pull requests' : 'pull request'}, as of ${r.fetched_at}`;
  if (r.pulls.length === 0) return `${head}\nnone`;
  const lines = [head, ...r.pulls.map(pullLine)];
  if (r.scope === 'one') lines.push(...yourText(r.pulls[0].your_text));
  return lines.join('\n');
}

export function formatIssueStatus(r: IssueStatusResult): string {
  const head = `${r.repository} (${r.repo}), ${r.scope === 'open' ? 'open issues' : r.scope === 'all' ? 'latest issues' : 'issue'}, as of ${r.fetched_at}`;
  if (r.issues.length === 0) return `${head}\nnone`;
  const lines = [
    head,
    ...r.issues.map(
      (i) =>
        `#${i.number} ${i.state}${i.state_reason ? ` (${i.state_reason})` : ''} "${i.title}" (${i.author})` +
        `${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}; ${i.comments} comments; updated ${i.updated_at}`,
    ),
  ];
  if (r.scope === 'one') lines.push(...yourText(r.issues[0].your_text));
  return lines.join('\n');
}
