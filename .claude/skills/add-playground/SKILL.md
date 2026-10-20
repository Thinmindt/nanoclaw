---
name: add-playground
description: Add `ncl playground run`, which runs an agent's Node project in a sandbox container with no network, no gateway, and no mounts of the agent's, and hands back the output, a video of every frame it saved, a few stills, and any other files it wrote. Use when an agent that holds private data (mail, a calendar, private code) wants to run code it did not write, or code another agent wrote, without that code running next to its credentials.
---

# Add playground

Code that runs inside an agent's container can make requests through the credential gateway, and the
gateway injects that agent's credentials on the way out. So "it can't get out of the container" is
the wrong boundary for an agent that holds the owner's mail: code it runs has the agent's reach.
The playground moves the run somewhere with no reach at all.

The agent names a project folder and the file to start:

```bash
ncl playground run --dir /workspace/extra/particle-life --entry main.js [--timeout 60] [--fps 30]
```

`--dir` is a folder as the agent sees it: under `/workspace/agent`, or under one of its read-only
mounts in `/workspace/extra` (another agent's project, say). The script's own arguments go in
`--args` and reach it as argv with no shell. A value that starts with `--` would be read as an `ncl`
flag, so arguments like `--seed 3` go through `--stdin-json`:

```bash
echo '{"args": ["--seed", "3"]}' | ncl playground run --dir /workspace/extra/particle-life --entry main.js --stdin-json
```

The host reads the folder once, one level at a time by descriptor, refusing links and special files
(at most 500 files, 2 MB each, 20 MB in all; `.git` is skipped), puts a host-owned copy in a
temporary folder, and starts a fresh container from the `nanoclaw-playground` image:

- **no network** (`--network none`), so no gateway, no destination, no address of any kind;
- read-only root, no capabilities, `no-new-privileges`, the unprivileged `nobody` user;
- 8 GB of memory (no swap), one CPU, 64 processes, a 256 MB `/out` and a 32 MB `/tmp`;
- the project copy read-only at `/work`, and nothing else from the host.

The image is Node 22 with its standard library, nothing else for the script, and ffmpeg for the
runner. The script runs as `node /work/<entry>` with `/out` as its working folder, for the time
limit (default 60 seconds, at most 1800), after which everything it started is killed. Only one run
happens at a time. The host machine needs the memory to spare: a run can use 8 GB on top of the
running agents.

The command returns at once with the run's name. Runs can last far longer than an `ncl` call waits,
and holding the host's delivery loop that long would stall every agent's replies, so the result
arrives later as a message that wakes the agent: the exit code (or "stopped at the time limit"), the
last 4000 characters of output, the frame count, and the paths of the video, the stills and the
other files.

The script saves frames in `/out` as `frame-0001.png`, `frame-0002.png`, and so on, as many as it
likes. As each one lands (once a later-numbered frame exists, so a frame still being written is never
read) the runner feeds it to ffmpeg, which builds one MP4 as the run goes, and deletes the PNG, so
`/out` never fills. The video is capped at about 10 MB, small enough for a Discord upload; a run that
reaches the cap says so. Up to 16 evenly spaced frames are kept as stills, which is what an agent can
look at; the video is for people. Only `frame-*.png` files are swept: up to 16 other files the
script leaves in `/out` (a census, a contact sheet, a run summary; plain names, 4 MB each) come back
as they are. Everything is written to `/workspace/agent/playground/<run>/` in the agent's own folder.
The host trusts nothing the sandbox prints: names, sizes, PNG headers and the MP4 header are
re-checked.

Which agents may call it is the operator's choice, in `.env`. The command has no resource, so it is
reachable for agents with `cli_scope=group`, like the calendar command.

## Steps

Run every step from the NanoClaw project root. Each step is safe to re-run.

### 1. Copy the tool, its command, the image and the tests

```
.claude/skills/add-playground/resources/playground-tool.ts                → src/playground-tool.ts
.claude/skills/add-playground/resources/playground-tool.test.ts           → src/playground-tool.test.ts
.claude/skills/add-playground/resources/playground-skill-sync.test.ts     → src/playground-skill-sync.test.ts
.claude/skills/add-playground/resources/playground.ts                     → src/cli/resources/playground.ts
.claude/skills/add-playground/resources/playground-group-scope.test.ts    → src/cli/resources/playground-group-scope.test.ts
.claude/skills/add-playground/resources/Dockerfile                        → container/playground/Dockerfile
.claude/skills/add-playground/resources/runner.mjs                        → container/playground/runner.mjs
```

```bash
R=.claude/skills/add-playground/resources
cp $R/playground-tool.ts $R/playground-tool.test.ts $R/playground-skill-sync.test.ts src/
cp $R/playground.ts $R/playground-group-scope.test.ts src/cli/resources/
mkdir -p container/playground && cp $R/Dockerfile $R/runner.mjs container/playground/
```

### 2. Register the command

Append to `src/cli/resources/index.ts`:

```ts
import './playground.js';
```

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/playground-tool.test.ts src/playground-skill-sync.test.ts src/cli/resources/playground-group-scope.test.ts
```

The group-scope test drives the real dispatch as a group-scoped agent; delete the barrel line and it
goes red.

### 4. Build the image

```bash
docker build -t nanoclaw-playground:latest container/playground
```

Re-run after changing the Dockerfile or `runner.mjs`. Then check the sandbox really has no network:

```bash
docker run --rm --network none --entrypoint node nanoclaw-playground:latest \
  -e "fetch('https://example.com').then(() => console.log('REACHED'), (e) => { console.error(e.cause?.code ?? e); process.exit(1); })"
```

This must fail with a network error and never print `REACHED`.

### 5. Choose the agents

Add to `.env` the agent group ids that may use it (`ncl groups list`), comma-separated:

```
PLAYGROUND_AGENT_GROUPS=<group-id>[,<group-id>...]
```

`PLAYGROUND_IMAGE` and `PLAYGROUND_DOCKER_BIN` override the image tag and the docker binary.

### 6. Mark the install reviewed and restart

```bash
pnpm exec tsx scripts/upgrade-state.ts set
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

A restart drops chat messages sent while the host is down on channels that do not replay them;
warn the owner first.

### 7. Try it

Ask the agent to run a short Node script that saves frames:

> Write a Node script, standard library only, that moves 50 dots around a 200x200 image for 300
> steps, saving each step as frame-0001.png, frame-0002.png and so on (zlib is built in), plus a
> summary.json, then run it with `ncl playground run`.

It should come back with exit 0, 300 frames, a video, some stills and `summary.json` under
`/workspace/agent/playground/`. Then ask it to run a script that calls `fetch('https://example.com')`;
that must fail.

If the host restarts during a run, the sandbox still stops at its time limit, but the result is
lost; the agent can start the run again.

Each run's log and frames stay under `/workspace/agent/playground/<run>/`; the newest 10 runs are
kept and older ones removed. Inside the sandbox the script and the runner share one user, so a
script can fake its own results; the host re-checks every frame and writes nothing outside the
run's folder, so faking only misleads about that run.

## Troubleshooting

- **"not allowed to use the playground"**: the group id is not in `PLAYGROUND_AGENT_GROUPS`.
- **"Unable to find image"**: step 4 was not run on this host.
- **"another playground run is in progress"**: one run at a time; ask again when it finishes.
- **No frames**: the script must save them in its working folder (`/out`), not a subfolder, as
  `frame-NNNN.png`, PNG only. Stills over 1 MB are left out; they still go into the video.
- **Video stops early**: it reached its 10 MB cap. Use a smaller frame, a lower `--fps`, or fewer
  frames.

## Removing

See `REMOVE.md`.
