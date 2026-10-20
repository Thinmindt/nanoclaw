// Playground runner: runs one agent project with no network and reports back.
//
// Baked into the playground image and started by the host's playground tool as
// `node /runner.mjs <timeout-seconds> <fps> <entry> [args...]`. The project is
// mounted read-only at /work; the runner starts `node /work/<entry> [args...]`
// in its own process group with /out (a tmpfs) as its working folder, keeping
// only the last LOG_TAIL bytes of its output, in memory.
//
// Frames are not capped by count. While the script runs, every PNG it saves in
// /out as frame-<number>.png is fed, in number order, to ffmpeg, which encodes
// one MP4 as the frames arrive, and is then deleted, so /out never fills. A
// frame is taken once a later-numbered frame exists or the script has exited,
// so a frame still being written is never read. Evenly spaced frames are kept
// in memory as stills: every stride-th frame, doubling the stride whenever more
// than MAX_STILLS are held. Only frame-*.png files are touched; other files the
// script leaves in /out (a census, a contact sheet) are sent back as they are.
//
// When the script exits or the timeout passes, the whole group is killed and
// the runner prints one JSON object per line on stdout:
//
//   {"kind": "result", "exit": <code or null>, "timed_out": <bool>, "log": "<tail>",
//    "frames": <frames encoded>, "video_full": <bool, true if the size cap cut it short>}
//   {"kind": "frame", "name": "frame-000000.png", "b64": "..."}   (up to MAX_STILLS)
//   {"kind": "file", "name": "census.json", "b64": "..."}         (up to MAX_FILES)
//   {"kind": "video", "b64": "..."}                               (the MP4, in chunks)
//
// The host trusts none of it: it re-checks every name, size and file header.
// Its limits match these, so a well-behaved run never overflows what it reads.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.RUNNER_OUT || '/out';
const WORK = process.env.RUNNER_WORK || '/work';
const VIDEO = path.join(OUT, '.video.mp4');
const LOG_TAIL = 4000;
const MAX_STILLS = 16;
const MAX_FRAME_BYTES = 1_000_000;
const MAX_FILES = 16;
const MAX_FILE_BYTES = 4_000_000;
const MAX_FILES_BYTES = 16_000_000;
const MAX_VIDEO_BYTES = 9_500_000; // fits a Discord upload
const VIDEO_CHUNK = 768 * 1024;
// After the time limit: how long to keep encoding frames already saved, and to finish the video.
// Together well inside the 180 s the host allows past the time limit.
const DRAIN_MS = 45_000;
const FINISH_MS = 90_000;
const FRAME_RE = /^frame-(\d{1,6})\.png$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const POLL_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => fs.writeSync(1, JSON.stringify(obj) + '\n');

class Encoder {
  proc = null;
  closed = false;
  count = 0;
  stride = 1;
  stills = []; // { index, name, data }

  constructor(fps) {
    this.fps = fps;
  }

  start() {
    // One thread each: the sandbox caps processes (threads count), and ffmpeg otherwise sizes its
    // thread pools from the host's cores. Even dimensions for yuv420p; -fs stops at the size cap.
    this.proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-f',
        'image2pipe',
        '-framerate',
        String(this.fps),
        '-c:v',
        'png',
        '-i',
        '-',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'veryfast',
        '-crf',
        '26',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-fs',
        String(MAX_VIDEO_BYTES),
        VIDEO,
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    this.exited = new Promise((r) => this.proc.on('close', r));
    // A failed spawn, or ffmpeg stopping at the size cap, ends the video; later frames are dropped.
    this.proc.on('error', () => (this.closed = true));
    this.proc.on('close', () => (this.closed = true));
    this.proc.stdin.on('error', () => (this.closed = true));
  }

  async take(name) {
    const file = path.join(OUT, name);
    let data;
    try {
      if (fs.lstatSync(file).isFile()) data = fs.readFileSync(file);
    } catch {
      // unreadable: skipped
    }
    fs.rmSync(file, { recursive: true, force: true });
    if (!data?.subarray(0, 8).equals(PNG_MAGIC)) return;
    if (!this.proc) this.start();
    if (!this.closed && !this.proc.stdin.write(data)) {
      await new Promise((r) => {
        const go = () => {
          this.proc.stdin.off('drain', go);
          this.proc.off('close', go);
          r();
        };
        this.proc.stdin.once('drain', go);
        this.proc.once('close', go);
      });
    }
    if (this.count % this.stride === 0 && data.length <= MAX_FRAME_BYTES) {
      this.stills.push({ index: this.count, name: `frame-${String(this.count).padStart(6, '0')}.png`, data });
      if (this.stills.length > MAX_STILLS) {
        this.stride *= 2;
        this.stills = this.stills.filter((s) => s.index % this.stride === 0);
      }
    }
    this.count++;
  }

  // Close the video. True when the size cap cut it short.
  async finish() {
    if (!this.proc) return false;
    this.proc.stdin.end();
    const killer = setTimeout(() => this.proc.kill('SIGKILL'), FINISH_MS);
    await this.exited;
    clearTimeout(killer);
    try {
      return fs.statSync(VIDEO).size >= MAX_VIDEO_BYTES * 0.97;
    } catch {
      return false;
    }
  }
}

// Frame names in number order.
function pendingFrames() {
  const num = (n) => Number(FRAME_RE.exec(n)[1]);
  return fs
    .readdirSync(OUT)
    .filter((n) => FRAME_RE.test(n))
    .sort((a, b) => num(a) - num(b));
}

async function main() {
  const [timeoutArg, fpsArg, entry, ...args] = process.argv.slice(2);
  const enc = new Encoder(Number(fpsArg) || 30);
  let tail = Buffer.alloc(0);
  const keep = (chunk) => {
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > LOG_TAIL) tail = tail.subarray(tail.length - LOG_TAIL);
  };
  const child = spawn('node', [path.join(WORK, entry), ...args], {
    cwd: OUT,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let code = null;
  let done = false;
  // 'exit', not 'close': a process the script left behind may hold its output open.
  child.on('exit', (c) => {
    code = c;
    done = true;
  });
  child.on('error', (err) => {
    keep(Buffer.from(`runner: could not start the script: ${err.message}\n`));
    done = true;
  });

  const deadline = Date.now() + Number(timeoutArg) * 1000;
  let timedOut = false;
  while (!done) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    // Every frame but the newest is finished: the script has moved on to a later one.
    for (const name of pendingFrames().slice(0, -1)) await enc.take(name);
    await sleep(POLL_MS);
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
  if (timedOut) code = null;

  const drainUntil = Date.now() + DRAIN_MS;
  for (const name of pendingFrames()) {
    if (Date.now() >= drainUntil) break; // frames past this point stay out of the video
    await enc.take(name);
  }
  const videoFull = await enc.finish();

  emit({
    kind: 'result',
    exit: code,
    timed_out: timedOut,
    log: tail.toString('utf8'),
    frames: enc.count,
    video_full: videoFull,
  });

  for (const s of enc.stills) emit({ kind: 'frame', name: s.name, b64: s.data.toString('base64') });

  let sent = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(OUT).sort()) {
    if (sent >= MAX_FILES || name.startsWith('.') || FRAME_RE.test(name)) continue;
    try {
      const file = path.join(OUT, name);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES || bytes + st.size > MAX_FILES_BYTES) continue;
      const data = fs.readFileSync(file);
      emit({ kind: 'file', name, b64: data.toString('base64') });
      sent++;
      bytes += data.length;
    } catch {
      // unreadable: skipped
    }
  }

  try {
    const video = fs.readFileSync(VIDEO);
    if (video.length <= MAX_VIDEO_BYTES * 1.05) {
      for (let i = 0; i < video.length; i += VIDEO_CHUNK) {
        emit({ kind: 'video', b64: video.subarray(i, i + VIDEO_CHUNK).toString('base64') });
      }
    }
  } catch {
    // no video
  }
}

await main();
