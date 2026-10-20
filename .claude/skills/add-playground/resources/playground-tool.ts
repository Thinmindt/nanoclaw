/**
 * Playground tool — runs an agent's Node project in a sandbox with no network.
 *
 * Code running inside an agent's container makes requests through the gateway
 * with that agent's credentials, so for an agent holding the owner's mail "it
 * can't get out of the container" is the wrong boundary. This tool moves the
 * run out of the agent's container: the host copies the project and runs it
 * in a fresh container that reaches no gateway, destination, mount of the
 * agent's, or network. Everything the sandbox prints is re-checked here.
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AnchoredDir } from './anchored-dir.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { readEnvFile } from './env.js';

const DEFAULT_IMAGE = 'nanoclaw-playground:latest';
const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 1800;
const MAX_PROJECT_FILES = 500;
export const MAX_PROJECT_FILE_BYTES = 2_000_000;
const MAX_PROJECT_BYTES = 20_000_000;
/** Other files the script leaves in /out (a census, a contact sheet): how many, and how big. */
const MAX_OUTPUT_FILES = 16;
const MAX_OUTPUT_FILE_BYTES = 4_000_000;
const MAX_OUTPUT_BYTES = 16_000_000;
const OUTPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_OUTPUT = new Set(['log.txt', 'video.mp4']);
const DEFAULT_FPS = 30;
const MAX_FPS = 60;
/** Stills kept from a run, evenly spaced; every frame goes into the video. */
export const MAX_STILLS = 16;
const MAX_FRAME_BYTES = 1_000_000;
/** Above the runner's 9.5 MB ffmpeg cap plus its 5% margin; the runner keeps the video Discord-sized. */
export const MAX_VIDEO_BYTES = 10_000_000;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const FRAME_RE = /^frame-\d{6}\.png$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Where the agent's group folder is mounted inside its own container (see buildMounts in container-runner). */
export const AGENT_DIR = '/workspace/agent';
/** Results land here, under the agent's folder. */
const RESULTS_DIR = 'playground';
/** Older runs past this many are removed when a new run lands. */
export const KEEP_RUNS = 10;
const RUN_RE = /^\d{4}-\d{2}-\d{2}T[\dT-]+Z-[0-9a-f]{6}$/;

export interface PlaygroundConfig {
  agentGroups: Set<string>;
  image: string;
  dockerBin: string;
}

export function loadPlaygroundConfig(): PlaygroundConfig | null {
  const keys = ['PLAYGROUND_AGENT_GROUPS', 'PLAYGROUND_IMAGE', 'PLAYGROUND_DOCKER_BIN'];
  const file = readEnvFile(keys);
  const get = (k: string) => process.env[k] || file[k];
  const groups = (get('PLAYGROUND_AGENT_GROUPS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (groups.length === 0) return null;
  return {
    agentGroups: new Set(groups),
    image: get('PLAYGROUND_IMAGE') || DEFAULT_IMAGE,
    dockerBin: get('PLAYGROUND_DOCKER_BIN') || CONTAINER_RUNTIME_BIN,
  };
}

/** A folder the agent sees at `containerPath` and the host reads at `hostPath`. */
export interface ProjectRoot {
  containerPath: string;
  hostPath: string;
}

export interface ProjectFile {
  rel: string;
  data: Buffer;
}

/** Folders skipped when a project is copied: history the run doesn't need. */
const SKIP_DIRS = new Set(['.git']);
const MAX_DEPTH = 8;

/** Path segments without empty and `.` parts; `..` is refused. */
function splitPath(flag: string, p: string): string[] {
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) throw new Error(`--${flag} must not contain ..`);
  return segs;
}

/**
 * Read a project folder the agent names as it sees it: under /workspace/agent (or relative to it),
 * or under one of its read-only mounts in /workspace/extra. Every level is opened by descriptor
 * (AnchoredDir), so a link, a FIFO or a folder swapped mid-read is refused rather than followed;
 * the trees are agent-writable (the agent's own folder) or another agent's (a mounted workspace).
 * The files are read here, once, and the sandbox gets a host-owned copy.
 */
export function readProject(roots: ProjectRoot[], requested: unknown): ProjectFile[] {
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('--dir is required');
  const req = requested.trim();
  const segs = splitPath('dir', req.startsWith('/') ? req : `${AGENT_DIR}/${req}`);
  let best: { root: ProjectRoot; depth: number } | null = null;
  for (const root of roots) {
    const rootSegs = root.containerPath.split('/').filter(Boolean);
    if (rootSegs.every((s, i) => segs[i] === s) && (!best || rootSegs.length > best.depth)) {
      best = { root, depth: rootSegs.length };
    }
  }
  if (!best) throw new Error(`--dir must be inside ${AGENT_DIR} or one of your mounts under /workspace/extra`);
  let top: AnchoredDir | null;
  try {
    top = AnchoredDir.open(best.root.hostPath, segs.slice(best.depth));
  } catch (err) {
    throw new Error(`--dir ${requested}: links are refused`, { cause: err });
  }
  if (!top) throw new Error(`--dir ${requested} does not exist`);
  const files: ProjectFile[] = [];
  let total = 0;
  const walk = (dir: AnchoredDir, prefix: string, depth: number): void => {
    for (const name of dir.entries().sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = dir.lstat(name);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (depth >= MAX_DEPTH) throw new Error(`--dir is nested deeper than ${MAX_DEPTH} folders`);
        const sub = dir.openDir(name)!;
        try {
          walk(sub, rel, depth + 1);
        } finally {
          sub.close();
        }
      } else if (st.isFile()) {
        if (files.length >= MAX_PROJECT_FILES) throw new Error(`--dir has more than ${MAX_PROJECT_FILES} files`);
        const fd = dir.openReadFd(name);
        try {
          // Read at most one byte past the cap, so a file that grows while it is read still stops here.
          const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_PROJECT_FILE_BYTES) + 1);
          let n = 0;
          for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += r;
          if (n === buf.length && n <= MAX_PROJECT_FILE_BYTES) throw new Error(`${rel} changed while it was read`);
          if (n > MAX_PROJECT_FILE_BYTES) throw new Error(`${rel} is larger than ${MAX_PROJECT_FILE_BYTES} bytes`);
          total += n;
          if (total > MAX_PROJECT_BYTES) throw new Error(`--dir is larger than ${MAX_PROJECT_BYTES} bytes`);
          files.push({ rel, data: buf.subarray(0, n) });
        } finally {
          fs.closeSync(fd);
        }
      } else {
        throw new Error(`--dir holds ${rel}, which is a link or special file; those are refused`);
      }
    }
  };
  try {
    walk(top, '', 0);
  } finally {
    top.close();
  }
  return files;
}

/** The file Node starts, relative to the project folder. */
export function parseEntry(value: unknown, files: ProjectFile[]): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('--entry is required');
  const rel = splitPath('entry', value).join('/');
  if (value.trim().startsWith('/') || !/\.(m|c)?js$/.test(rel)) {
    throw new Error('--entry must be a .js, .mjs or .cjs file inside --dir');
  }
  if (!files.some((f) => f.rel === rel)) throw new Error(`--entry ${rel} is not in --dir`);
  return rel;
}

/** Write the host-owned copy the sandbox mounts read-only at /work. */
function writeProject(dir: string, files: ProjectFile[]): void {
  fs.mkdirSync(dir, { mode: 0o755 });
  for (const f of files) {
    const p = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
    fs.writeFileSync(p, f.data, { mode: 0o644 });
  }
}

const MAX_SCRIPT_ARGS = 32;
const MAX_SCRIPT_ARG_LENGTH = 256;

/**
 * The script's arguments: a list (from `--stdin-json`) or one string split on whitespace. They reach
 * the script as argv, never through a shell; control characters are refused.
 */
export function parseScriptArgs(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.trim().split(/\s+/) : null;
  if (!list || !list.every((a) => typeof a === 'string'))
    throw new Error('--args must be a string or a list of strings');
  if (list.length > MAX_SCRIPT_ARGS) throw new Error(`--args takes at most ${MAX_SCRIPT_ARGS} arguments`);
  for (const a of list as string[]) {
    // eslint-disable-next-line no-control-regex
    if (a.length > MAX_SCRIPT_ARG_LENGTH || /[\u0000-\u001f\u007f]/.test(a)) {
      throw new Error(`each argument must be at most ${MAX_SCRIPT_ARG_LENGTH} characters with no control characters`);
    }
  }
  return list as string[];
}

/** A whole number flag. A bare flag (which `ncl` reads as `true`) is refused, not taken as 1. */
function wholeNumber(flag: string, value: unknown, fallback: number, max: number, unit = ''): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`--${flag} must be a whole number${unit} from 1 to ${max}`);
  return n;
}

export const parseFps = (value: unknown): number => wholeNumber('fps', value, DEFAULT_FPS, MAX_FPS);
export const parseTimeout = (value: unknown): number =>
  wholeNumber('timeout', value, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, ' of seconds');

/** The sandbox: no network, read-only root, no capabilities, nobody, capped, the project read-only. */
export function sandboxArgs(image: string, projectDir: string, opts: RunOptions, name: string): string[] {
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/out:rw,size=256m,mode=1777',
    '--tmpfs',
    '/tmp:rw,size=32m,mode=1777',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--memory',
    '8g',
    '--memory-swap',
    '8g',
    '--cpus',
    '1',
    '--pids-limit',
    '256',
    // A real PID 1 that reaps what the script leaves behind.
    '--init',
    '--mount',
    `type=bind,source=${projectDir},target=/work,readonly`,
    image,
    String(opts.timeoutS),
    String(opts.fps),
    opts.entry,
    ...opts.args,
  ];
}

export interface RunOptions {
  /** The file Node starts, relative to the project folder. */
  entry: string;
  timeoutS: number;
  fps: number;
  /** Command-line arguments for the script, passed as argv with no shell. */
  args: string[];
}

export interface PlaygroundOutput {
  exit: number | null;
  timedOut: boolean;
  log: string;
  frameCount: number;
  videoFull: boolean;
  frames: { name: string; data: Buffer }[];
  files: { name: string; data: Buffer }[];
  video: Buffer | null;
}

/**
 * A named file from one runner line, unless its name is taken. Names are compared without case: a
 * case-insensitive host disk would see LOG.txt as log.txt.
 */
function named(msg: Record<string, unknown>, taken: { name: string }[]): { name: string; data: Buffer } | null {
  const { name, b64 } = msg;
  if (typeof name !== 'string' || typeof b64 !== 'string') return null;
  if (taken.some((t) => t.name.toLowerCase() === name.toLowerCase())) return null;
  return { name, data: Buffer.from(b64, 'base64') };
}

/** Parse the runner's JSON lines, keeping only what passes every check. */
export function parseRunnerOutput(stdout: string): PlaygroundOutput {
  const out: PlaygroundOutput = {
    exit: null,
    timedOut: false,
    log: '',
    frameCount: 0,
    videoFull: false,
    frames: [],
    files: [],
    video: null,
  };
  let fileBytes = 0;
  const chunks: Buffer[] = [];
  let videoBytes = 0;
  let sawResult = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.kind === 'result' && !sawResult) {
      sawResult = true;
      out.exit = typeof msg.exit === 'number' ? msg.exit : null;
      out.timedOut = msg.timed_out === true;
      out.log = typeof msg.log === 'string' ? msg.log.slice(-4000) : '';
      out.frameCount = typeof msg.frames === 'number' && Number.isInteger(msg.frames) ? Math.max(0, msg.frames) : 0;
      out.videoFull = msg.video_full === true;
    } else if (msg.kind === 'frame' && out.frames.length < MAX_STILLS) {
      const f = named(msg, out.frames);
      if (!f || !FRAME_RE.test(f.name) || f.data.length > MAX_FRAME_BYTES) continue;
      if (f.data.subarray(0, 8).equals(PNG_MAGIC)) out.frames.push(f);
    } else if (msg.kind === 'file' && out.files.length < MAX_OUTPUT_FILES) {
      const f = named(msg, out.files);
      if (!f || !OUTPUT_NAME_RE.test(f.name) || RESERVED_OUTPUT.has(f.name.toLowerCase())) continue;
      if (/^frame-\d+\.png$/i.test(f.name) || f.data.length > MAX_OUTPUT_FILE_BYTES) continue;
      if (fileBytes + f.data.length > MAX_OUTPUT_BYTES) continue;
      fileBytes += f.data.length;
      out.files.push(f);
    } else if (msg.kind === 'video' && typeof msg.b64 === 'string' && videoBytes <= MAX_VIDEO_BYTES) {
      const chunk = Buffer.from(msg.b64, 'base64');
      videoBytes += chunk.length;
      chunks.push(chunk);
    }
  }
  // An MP4 starts with an ftyp box; anything else, or anything over the cap, is dropped whole.
  const video = Buffer.concat(chunks);
  if (videoBytes <= MAX_VIDEO_BYTES && video.subarray(4, 8).toString('latin1') === 'ftyp') out.video = video;
  if (!sawResult) throw new Error('the sandbox returned no result');
  return out;
}

/** Runs a command and returns stdout; injectable for tests. */
export type Runner = (bin: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultRunner: Runner = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES }, (err, stdout, stderr) => {
      if (err) reject(new Error(`sandbox run failed: ${stderr.trim().slice(-500) || err.message}`));
      else resolve(stdout);
    });
  });

let running = false;
export const BUSY = 'Another playground run is in progress; try again when it finishes.';

/**
 * Remove sandboxes a previous host process left running: their results have nowhere to go, and each
 * holds up to 8 GB until its own time limit. Called once, before this process's first run.
 */
export async function removeLeftoverSandboxes(config: PlaygroundConfig, runner: Runner = defaultRunner): Promise<void> {
  const out = await runner(config.dockerBin, ['ps', '-aq', '--filter', 'name=^nanoclaw-playground-'], 30_000);
  const ids = out.split('\n').filter((id) => /^[0-9a-f]{12,64}$/.test(id));
  if (ids.length) await runner(config.dockerBin, ['rm', '-f', ...ids], 30_000);
}

/** True while a run is in progress; only one runs at a time. */
export function playgroundBusy(): boolean {
  return running;
}

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

/** The message the agent gets when its run ends. */
export function formatPlaygroundResult(r: PlaygroundResult): string {
  return (
    `Playground run ${r.run}: ${r.timed_out ? 'stopped at the time limit' : `exit ${r.exit}`}\n` +
    `${r.frame_count} frames${r.video_cut_short ? ' (the video stopped at its size limit)' : ''}\n` +
    (r.video ? `video: ${r.video}\n` : '') +
    (r.frames.length ? `stills:\n${r.frames.join('\n')}\n` : '') +
    (r.files.length ? `files:\n${r.files.join('\n')}\n` : '') +
    (r.log ? `output (tail):\n${r.log}` : 'no output')
  );
}

export interface PlaygroundResult {
  run: string;
  exit: number | null;
  timed_out: boolean;
  log: string;
  frame_count: number;
  video_cut_short: boolean;
  video: string | null;
  frames: string[];
  files: string[];
}

/**
 * Remove runs past the newest KEEP_RUNS. Only names this tool makes are touched, and only their
 * files; a run folder the agent has put anything else in is left alone.
 */
function pruneRuns(results: AnchoredDir): void {
  const runs = results
    .entries()
    .filter((n) => RUN_RE.test(n))
    .sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
    try {
      const d = results.openDir(name);
      if (!d) continue;
      try {
        for (const f of d.entries()) if (d.lstat(f).isFile()) d.unlink(f);
      } finally {
        d.close();
      }
      results.rmdir(name);
    } catch {
      // Not ours to force; it stays.
    }
  }
}

/**
 * Run one project and write its results to `<groupDir>/playground/<run>/`. One run at a time.
 *
 * The script and the runner share a user inside the sandbox, so the script can forge the runner's
 * output or kill it. That only lets it lie about its own run, which it controls anyway: every line
 * is re-checked by parseRunnerOutput and written into the agent's folder by descriptor.
 */
export async function runPlayground(
  config: PlaygroundConfig,
  groupDir: string,
  project: ProjectFile[],
  opts: RunOptions,
  { runner = defaultRunner, run = newRunId() }: { runner?: Runner; run?: string } = {},
): Promise<PlaygroundResult> {
  if (running) throw new Error(BUSY);
  let tmp: string | undefined;
  try {
    running = true;
    const name = `nanoclaw-playground-${run.toLowerCase()}`;
    // mkdtemp makes the folder 0700, so other host users can't read the copy; the sandbox reaches the
    // project through its bind mount, which needs only the project folder itself to be readable.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-playground-'));
    const projectDir = path.join(tmp, 'project');
    writeProject(projectDir, project);
    let stdout: string;
    try {
      stdout = await runner(
        config.dockerBin,
        sandboxArgs(config.image, projectDir, opts, name),
        // The runner's own deadline, then time to finish the video and print it.
        (opts.timeoutS + 180) * 1000,
      );
    } catch (err) {
      // A run killed from outside leaves its container behind; --rm only cleans up on a normal exit.
      await runner(config.dockerBin, ['rm', '-f', name], 30_000).catch(() => undefined);
      throw err;
    }
    const output = parseRunnerOutput(stdout);
    const results = AnchoredDir.open(groupDir, [RESULTS_DIR], true)!;
    try {
      const out = results.openDir(run, true)!;
      try {
        out.writeNewFile('log.txt', Buffer.from(output.log));
        for (const f of output.frames) out.writeNewFile(f.name, f.data);
        for (const f of output.files) out.writeNewFile(f.name, f.data);
        if (output.video) out.writeNewFile('video.mp4', output.video);
      } finally {
        out.close();
      }
      pruneRuns(results);
    } finally {
      results.close();
    }
    const shown = `${AGENT_DIR}/${RESULTS_DIR}/${run}`;
    return {
      run,
      exit: output.exit,
      timed_out: output.timedOut,
      log: output.log,
      frame_count: output.frameCount,
      video_cut_short: output.videoFull,
      video: output.video ? `${shown}/video.mp4` : null,
      frames: output.frames.map((f) => `${shown}/${f.name}`),
      files: output.files.map((f) => `${shown}/${f.name}`),
    };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    running = false;
  }
}
