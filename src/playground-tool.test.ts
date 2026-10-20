/**
 * The playground tool's own rules: the script is read once from inside the agent's folder, the sandbox
 * is started with no network and no privileges, and nothing the sandbox prints is trusted.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KEEP_RUNS,
  MAX_PROJECT_FILE_BYTES,
  MAX_STILLS,
  MAX_VIDEO_BYTES,
  parseEntry,
  parseFps,
  parseScriptArgs,
  parseRunnerOutput,
  parseTimeout,
  readProject,
  runPlayground,
  sandboxArgs,
  type Runner,
} from './playground-tool.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const line = (o: unknown) => JSON.stringify(o);
const result = (extra = {}) => line({ kind: 'result', exit: 0, timed_out: false, log: 'ok', ...extra });
const frame = (name: string, data = PNG) => line({ kind: 'frame', name, b64: data.toString('base64') });

let dir: string;
let group: string;
let shared: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playground-'));
  group = path.join(dir, 'groups', 'steward');
  shared = path.join(dir, 'workbench', 'particle-life');
  fs.mkdirSync(path.join(group, 'sims', 'lib'), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(group, 'sims', 'main.js'), 'console.log("hi")\n');
  fs.writeFileSync(path.join(group, 'sims', 'lib', 'png.js'), 'module.exports = {}\n');
  fs.writeFileSync(path.join(shared, 'engine.js'), '// engine\n');
  fs.writeFileSync(path.join(dir, 'secret.env'), 'TOKEN=x\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readProject', () => {
  const roots = () => [
    { containerPath: '/workspace/agent', hostPath: group },
    { containerPath: '/workspace/extra/particle-life', hostPath: shared },
  ];
  const names = (files: { rel: string }[]) => files.map((f) => f.rel);

  it('reads a project folder, by container path or relative path, skipping .git', () => {
    fs.mkdirSync(path.join(group, 'sims', '.git'));
    fs.writeFileSync(path.join(group, 'sims', '.git', 'HEAD'), 'x');
    expect(names(readProject(roots(), '/workspace/agent/sims'))).toEqual(['lib/png.js', 'main.js']);
    expect(names(readProject(roots(), 'sims'))).toEqual(['lib/png.js', 'main.js']);
  });

  it('reads from a read-only mount by the path the agent sees', () => {
    expect(names(readProject(roots(), '/workspace/extra/particle-life'))).toEqual(['engine.js']);
  });

  it('refuses paths outside, links, FIFOs and missing folders', () => {
    expect(() => readProject(roots(), '/etc')).toThrow(/must be inside/);
    expect(() => readProject(roots(), '../..')).toThrow(/\.\./);
    fs.symlinkSync(path.join(dir, 'secret.env'), path.join(group, 'sims', 'link.js'));
    expect(() => readProject(roots(), 'sims')).toThrow(/link or special file/);
    fs.unlinkSync(path.join(group, 'sims', 'link.js'));
    execFileSync('mkfifo', [path.join(group, 'sims', 'pipe.js')]);
    expect(() => readProject(roots(), 'sims')).toThrow(/link or special file/);
    fs.symlinkSync(dir, path.join(group, 'out'));
    expect(() => readProject(roots(), 'out')).toThrow(/links are refused/);
    expect(() => readProject(roots(), 'nope')).toThrow(/does not exist/);
  });

  it('refuses a project that is too big', () => {
    fs.writeFileSync(path.join(group, 'sims', 'big.js'), Buffer.alloc(MAX_PROJECT_FILE_BYTES + 1));
    expect(() => readProject(roots(), 'sims')).toThrow(/larger/);
  });
});

describe('parseEntry', () => {
  const files = [
    { rel: 'main.js', data: Buffer.from('') },
    { rel: 'lib/png.js', data: Buffer.from('') },
  ];
  it('accepts a JavaScript file in the project and nothing else', () => {
    expect(parseEntry('main.js', files)).toBe('main.js');
    expect(parseEntry('./lib/png.js', files)).toBe('lib/png.js');
    for (const bad of ['', '/main.js', '../main.js', 'other.js', 'main.py']) {
      expect(() => parseEntry(bad, files)).toThrow();
    }
  });
});

describe('parseTimeout', () => {
  it('script arguments come as a list or a whitespace-split string, no control characters', () => {
    expect(parseScriptArgs(undefined)).toEqual([]);
    expect(parseScriptArgs(' --seed 3  --steps 500 ')).toEqual(['--seed', '3', '--steps', '500']);
    expect(parseScriptArgs(['--name', 'two words'])).toEqual(['--name', 'two words']);
    expect(() => parseScriptArgs(['a\nb'])).toThrow();
    expect(() => parseScriptArgs([1])).toThrow();
    expect(() => parseScriptArgs(Array(33).fill('x'))).toThrow();
  });

  it('fps defaults to 30 and accepts 1..60 only', () => {
    expect(parseFps(undefined)).toBe(30);
    expect(parseFps('12')).toBe(12);
    for (const bad of ['0', '61', '2.5', 'x', true]) expect(() => parseFps(bad)).toThrow();
  });

  it('defaults to 60 and accepts 1..1800 only', () => {
    expect(parseTimeout(undefined)).toBe(60);
    expect(parseTimeout('120')).toBe(120);
    expect(parseTimeout('1800')).toBe(1800);
    for (const bad of ['0', '1801', '1.5', 'x', true]) expect(() => parseTimeout(bad)).toThrow();
  });
});

describe('sandboxArgs', () => {
  it('starts the sandbox with no network, no privileges and caps', () => {
    const args = sandboxArgs(
      'img',
      '/tmp/x/project',
      { entry: 'main.js', timeoutS: 60, fps: 24, args: ['--seed', '3'] },
      'n',
    ).join(' ');
    for (const part of [
      '--network none',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--user 65534:65534',
      '--memory 8g',
      '--pids-limit 256',
      '--init',
      'type=bind,source=/tmp/x/project,target=/work,readonly',
      'img 60 24 main.js --seed 3',
    ]) {
      expect(args).toContain(part);
    }
    expect(args).not.toMatch(/--privileged|--network host|docker.sock/);
  });
});

describe('parseRunnerOutput', () => {
  it('keeps only valid PNG frames with safe names, up to the cap', () => {
    const lines = [
      'noise',
      result({ exit: 3, log: 'tail' }),
      frame('frame-000001.png'),
      frame('../evil.png'),
      frame('frame-000002.png', Buffer.from('not a png')),
      frame('frame-000001.png'),
      ...Array.from({ length: 20 }, (_, i) => frame(`frame-0001${String(i).padStart(2, '0')}.png`)),
    ];
    const out = parseRunnerOutput(lines.join('\n'));
    expect(out.exit).toBe(3);
    expect(out.log).toBe('tail');
    expect(out.frames).toHaveLength(MAX_STILLS);
    expect(out.frames[0].name).toBe('frame-000001.png');
    expect(out.frames.map((f) => f.name)).not.toContain('../evil.png');
  });

  it('joins the video chunks and keeps only an MP4 under the cap', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
    const chunk = (b: Buffer) => line({ kind: 'video', b64: b.toString('base64') });
    const ok = parseRunnerOutput(
      [result({ frames: 600, video_full: true }), chunk(mp4.subarray(0, 50)), chunk(mp4.subarray(50))].join('\n'),
    );
    expect(ok.video).toEqual(mp4);
    expect(ok.frameCount).toBe(600);
    expect(ok.videoFull).toBe(true);
    expect(parseRunnerOutput([result(), chunk(Buffer.from('not a video at all'))].join('\n')).video).toBeNull();
    const big = Buffer.concat([mp4, Buffer.alloc(MAX_VIDEO_BYTES)]);
    expect(parseRunnerOutput([result(), chunk(big)].join('\n')).video).toBeNull();
  });

  it('keeps other output files with plain names, never ones that pose as results or frames', () => {
    const file = (name: string, data = Buffer.from('x')) => line({ kind: 'file', name, b64: data.toString('base64') });
    const out = parseRunnerOutput(
      [
        result(),
        file('census.json'),
        file('contact-sheet.png'),
        file('../escape.json'),
        file('.hidden'),
        file('log.txt'),
        file('video.mp4'),
        file('frame-0001.png'),
        file('census.json'),
        file('LOG.TXT'),
        file('Census.json'),
      ].join('\n'),
    );
    expect(out.files.map((f) => f.name)).toEqual(['census.json', 'contact-sheet.png']);
  });

  it('fails when the sandbox gave no result', () => {
    expect(() => parseRunnerOutput(frame('frame-000001.png'))).toThrow(/no result/);
  });
});

describe('runPlayground', () => {
  const OPTS = { entry: 'main.js', timeoutS: 5, fps: 30, args: [] };
  const PROJECT = [{ rel: 'main.js', data: Buffer.from('x') }];
  const config = { agentGroups: new Set(['ag']), image: 'img', dockerBin: 'docker' };

  it('runs a host-owned copy of the project and writes the results into the agent folder', async () => {
    let mounted = '';
    const runner: Runner = async (_bin, args) => {
      const bind = args.find((a) => a.startsWith('type=bind'))!;
      mounted = bind.split(',')[1].slice('source='.length);
      expect(fs.readFileSync(path.join(mounted, 'lib', 'png.js'), 'utf-8')).toBe('module.exports = {}\n');
      const census = line({ kind: 'file', name: 'census.json', b64: Buffer.from('{}').toString('base64') });
      return [result({ log: 'done' }), frame('frame-000001.png'), census].join('\n');
    };
    const project = readProject([{ containerPath: '/workspace/agent', hostPath: group }], 'sims');
    const r = await runPlayground(config, group, project, OPTS, { runner });
    expect(mounted.startsWith(group)).toBe(false);
    expect(fs.existsSync(mounted)).toBe(false);
    expect(r.frames).toEqual([`/workspace/agent/playground/${r.run}/frame-000001.png`]);
    expect(fs.readFileSync(path.join(group, 'playground', r.run, 'frame-000001.png'))).toEqual(PNG);
    expect(fs.readFileSync(path.join(group, 'playground', r.run, 'log.txt'), 'utf-8')).toBe('done');
    expect(r.files).toEqual([`/workspace/agent/playground/${r.run}/census.json`]);
    expect(fs.readFileSync(path.join(group, 'playground', r.run, 'census.json'), 'utf-8')).toBe('{}');
  });

  it('keeps the project copy in a folder only the host user can open', async () => {
    const runner: Runner = async (_bin, args) => {
      const src = args
        .find((a) => a.startsWith('type=bind'))!
        .split(',')[1]
        .slice('source='.length);
      expect(fs.statSync(path.dirname(src)).mode & 0o077).toBe(0);
      return result();
    };
    await runPlayground(config, group, PROJECT, OPTS, { runner });
  });

  it('refuses to write through a results folder the agent swapped for a link', async () => {
    fs.symlinkSync(dir, path.join(group, 'playground'));
    await expect(runPlayground(config, group, PROJECT, OPTS, { runner: async () => result() })).rejects.toThrow(
      /not a real directory/,
    );
    expect(fs.readdirSync(dir).sort()).toEqual(['groups', 'secret.env', 'workbench']);
  });

  it('keeps only the newest runs and leaves other folders alone', async () => {
    const results = path.join(group, 'playground');
    fs.mkdirSync(path.join(results, 'mine'), { recursive: true });
    for (let i = 0; i < KEEP_RUNS + 3; i++) {
      await runPlayground(config, group, PROJECT, OPTS, { runner: async () => result() });
    }
    const left = fs.readdirSync(results);
    expect(left).toContain('mine');
    expect(left.filter((n) => n !== 'mine')).toHaveLength(KEEP_RUNS);
  });

  it('removes a container the run left behind when it fails', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_bin, args) => {
      calls.push(args);
      if (args[0] === 'run') throw new Error('killed');
      return '';
    };
    await expect(runPlayground(config, group, PROJECT, OPTS, { runner })).rejects.toThrow(/killed/);
    expect(calls[1].slice(0, 2)).toEqual(['rm', '-f']);
    expect(calls[1][2]).toBe(calls[0][calls[0].indexOf('--name') + 1]);
  });
});
