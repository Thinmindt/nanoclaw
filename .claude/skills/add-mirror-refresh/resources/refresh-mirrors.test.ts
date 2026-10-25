import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * Drives refresh-mirrors.sh against throwaway repositories. The only fake is
 * gitleaks: a stand-in that reports every added line containing FAKE-SECRET in
 * the commits named by --log-opts, and honors <source>/.gitleaksignore.
 */

const SCRIPT = path.resolve(__dirname, 'refresh-mirrors.sh');

const FAKE_GITLEAKS = `#!/usr/bin/env bash
set -u
src= opts= report=
while [ $# -gt 0 ]; do
  case "$1" in
    --source) src="$2"; shift 2 ;;
    --log-opts) opts="$2"; shift 2 ;;
    --report-path) report="$2"; shift 2 ;;
    --report-format) shift 2 ;;
    *) shift ;;
  esac
done
echo "$opts" >>"$FAKE_GITLEAKS_LOG"
[ -n "\${FAKE_GITLEAKS_CRASH:-}" ] && exit 2
# shellcheck disable=SC2086
hits=$(git -C "$src" log --format='commit %H' -p -U0 $opts | awk '
  /^commit / { c = $2 } /^\\+\\+\\+ b\\// { f = substr($0, 7) }
  /^\\+[^+]/ && /FAKE-SECRET/ { print c ":" f ":fake-rule:1" }' | sort -u)
out="["; sep=""; found=0
for h in $hits; do
  grep -qxF "$h" "$src/.gitleaksignore" 2>/dev/null && continue
  out="$out$sep{\\"Fingerprint\\": \\"$h\\"}"; sep=","; found=1
done
echo "$out]" >"$report"
exit $found
`;

let root: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(file: string, content: string): string {
  fs.writeFileSync(path.join(root, 'upstream', file), content);
  git(path.join(root, 'upstream'), 'add', file);
  git(path.join(root, 'upstream'), 'commit', '-qm', `edit ${file}`);
  return git(path.join(root, 'upstream'), 'rev-parse', '--short', 'HEAD');
}

function refresh(...args: string[]) {
  return spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf-8' });
}

const mirror = () => path.join(root, 'repos', 'project');
const readme = () => fs.readFileSync(path.join(root, 'repos', 'README.md'), 'utf-8');
const mirrorHead = () => git(mirror(), 'rev-parse', '--short', 'main');
const scanLog = () => fs.readFileSync(path.join(root, 'gitleaks.log'), 'utf-8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-mirrors-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gitleaks'), FAKE_GITLEAKS, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'gitleaks.log'), '');
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MIRRORS_DIR: path.join(root, 'repos'),
    XDG_RUNTIME_DIR: root,
    TMPDIR: root,
    FAKE_GITLEAKS_LOG: path.join(root, 'gitleaks.log'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete env.GITLEAKS;
  delete env.FAKE_GITLEAKS_CRASH;
  fs.mkdirSync(path.join(root, 'upstream'));
  git(path.join(root, 'upstream'), 'init', '-q', '-b', 'main');
  commit('a.txt', 'one\n');
  fs.mkdirSync(path.join(root, 'repos'));
  git(root, 'clone', '-q', '--mirror', path.join(root, 'upstream'), mirror());
  fs.writeFileSync(path.join(root, 'repos', 'README.md'), '# Mirrors\n\ncanary: test-canary\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('refresh-mirrors.sh', () => {
  it('fetches new commits, scans only those, and writes one last-refresh line', () => {
    const sha = commit('a.txt', 'two\n');
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(mirrorHead()).toBe(sha);
    expect(scanLog()).toBe('--all --not --alternate-refs\n');
    expect(readme()).toContain('canary: test-canary');
    expect(readme()).toMatch(new RegExp(`^last-refresh: project \\S+ main@${sha}$`, 'm'));

    const sha2 = commit('a.txt', 'three\n');
    expect(refresh().status).toBe(0);
    expect(readme().match(/^last-refresh: project /gm)).toHaveLength(1);
    expect(readme()).toContain(`main@${sha2}`);
  });

  it('skips the scan when nothing is new but still records the refresh', () => {
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(scanLog()).toBe('');
    expect(readme()).toMatch(/^last-refresh: project /m);
  });

  it('leaves the mirror and its line untouched when the scan finds something', () => {
    expect(refresh().status).toBe(0);
    const before = readme();
    const old = mirrorHead();
    commit('config.env', 'TOKEN=FAKE-SECRET\n');

    const r = refresh();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/possible secrets/);
    expect(r.stderr).toMatch(/:config\.env:fake-rule:1/);
    expect(mirrorHead()).toBe(old);
    expect(readme()).toBe(before);
  });

  it('refuses when gitleaks fails without a report', () => {
    commit('a.txt', 'two\n');
    const old = mirrorHead();
    env.FAKE_GITLEAKS_CRASH = '1';
    const r = refresh();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/without a report/);
    expect(mirrorHead()).toBe(old);
    expect(readme()).not.toMatch(/last-refresh/);
  });

  it('does not re-flag history the mirror already holds', () => {
    commit('fixture.txt', 'FAKE-SECRET in an old fixture\n');
    expect(refresh('--accept', 'project').status).toBe(0);
    fs.rmSync(path.join(mirror(), '.gitleaksignore'));
    const sha = commit('a.txt', 'clean\n');
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(mirrorHead()).toBe(sha);
  });

  it('--accept baselines the findings, refreshes, and later runs pass', () => {
    commit('fixture.txt', 'FAKE-SECRET\n');
    expect(refresh().status).toBe(1);

    const r = refresh('--accept', 'project');
    expect(r.status, r.stderr).toBe(0);
    const ignore = fs.readFileSync(path.join(mirror(), '.gitleaksignore'), 'utf-8');
    expect(ignore).toMatch(/^[0-9a-f]{40}:fixture\.txt:fake-rule:1$/m);
    expect(mirrorHead()).toBe(git(path.join(root, 'upstream'), 'rev-parse', '--short', 'HEAD'));
  });

  it('records a push-fed mirror by its newest commit without fetching it', () => {
    git(root, 'init', '-q', '--bare', '-b', 'main', path.join(root, 'repos', 'pushed'));
    git(path.join(root, 'upstream'), 'push', '-q', path.join(root, 'repos', 'pushed'), 'main');
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(readme()).toMatch(/^last-refresh: pushed \S+ main@[0-9a-f]+ \(push-fed: time of newest commit\)$/m);
    expect(readme()).toMatch(/^last-refresh: project /m);
  });

  it('refreshes only the named mirror and rejects unknown names', () => {
    git(root, 'init', '-q', '--bare', '-b', 'main', path.join(root, 'repos', 'pushed'));
    expect(refresh('project').status).toBe(0);
    expect(readme()).not.toMatch(/last-refresh: pushed/);
    const r = refresh('nope');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/nope: not a bare repository/);
  });

  it('skips quietly while another refresh holds the lock', () => {
    const lock = path.join(root, `refresh-mirrors.${process.getuid!()}.lock`);
    // `; exit $?` keeps the holding shell alive: bash would otherwise exec the last command and drop the lock.
    const holder = spawnSync('bash', ['-c', `exec 9>"${lock}"; flock 9; bash "${SCRIPT}"; exit $?`], {
      env,
      encoding: 'utf-8',
    });
    expect(holder.status).toBe(0);
    expect(holder.stderr).toMatch(/another refresh is running/);
    expect(fs.readFileSync(path.join(root, 'repos', 'README.md'), 'utf-8')).not.toMatch(/last-refresh/);
  });
});
