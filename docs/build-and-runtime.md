# Build & Runtime

NanoClaw runs a split stack: the host is Node + pnpm, the agent container is Bun. They communicate exclusively through two SQLite files per session — there are no shared modules between them, which is what lets them use different runtimes cleanly.

## Why the split

- **Host stays on Node** because Baileys (WhatsApp) depends on `libsignal-node` native bindings and a long-tested WebSocket/HTTP stack. Bun's Node-API compat has improved, but this isn't where we want risk.
- **Container runs Bun** because `bun:sqlite` is built-in (no native compile of `better-sqlite3` per image rebuild), source runs directly (no tsc build step at image build or session wake), and `bun install` is ~5-10× faster than `npm install`.

Host and container each have their own package tree:

```
/                             pnpm + Node 22
  pnpm-lock.yaml              host deps (channels, Chat SDK, Baileys, better-sqlite3, etc.)
  pnpm-workspace.yaml         minimumReleaseAge + onlyBuiltDependencies policy

/container/agent-runner/      Bun 1.3+
  bun.lock                    agent-runner runtime deps (Claude Agent SDK, MCP SDK, zod, etc.)
  package.json                @types/bun, typescript devDeps for type-checking
```

The container image also has pnpm + Node inside for global CLIs (`@anthropic-ai/claude-code`, `agent-browser`, `vercel`). Those are Node binaries the agent invokes at runtime, not library deps. Keeping them on pnpm preserves the supply-chain policy for CLI versions.

## Lockfiles

| Tree | Lockfile | Manager | Regenerate after dep change |
|------|----------|---------|----------------------------|
| Host | `pnpm-lock.yaml` | pnpm 10 | `pnpm install` |
| Agent-runner | `container/agent-runner/bun.lock` | Bun 1.3+ | `cd container/agent-runner && bun install` |

Both are committed. CI and the Dockerfile run `--frozen-lockfile` variants — any drift between `package.json` and lockfile fails the build.

## Supply chain

- **Host + global CLIs** (pnpm): `minimumReleaseAge: 4320` (3-day hold on new versions), `onlyBuiltDependencies` allowlist for postinstall scripts. See `pnpm-workspace.yaml` and `docs/SECURITY.md`.
- **Agent-runner** (Bun): no release-age policy — Bun doesn't have an equivalent today. The defenses are `bun.lock` pinning plus a version-pinned Bun itself via a Dockerfile ARG (global CLIs are pinned separately in `container/cli-tools.json`). When bumping `@anthropic-ai/claude-agent-sdk` or any runtime dep, review the release date on npm and bump deliberately, not via `bun update`.

## Bumping Claude Code

Before a new version of the CLI (`@anthropic-ai/claude-code` in `container/cli-tools.json`) or of the agent SDK (`@anthropic-ai/claude-agent-sdk` in `container/agent-runner`) reaches a live seat, rebuild the image and re-run checks 1 to 3 below. They are in `container/agent-runner/src/providers/claude.smoke.test.ts`, which drives the CLI in the image through the runner's own call, in bypass mode, against a stub model; a file counts as loaded when its text reaches the model. CI does not run it. From `container/agent-runner`:

```bash
docker run --rm --init --network none -e CLAUDE_SMOKE=1 -v "$PWD/src:/app/src:ro" \
  -v "$PWD/bunfig.toml:/app/bunfig.toml:ro" -w /app --entrypoint bun \
  nanoclaw-agent-v2-<slug>:latest test src/providers/claude.smoke.test.ts
```

1. **Control.** An instruction file and a skill in a folder under the working folder load once the Read tool reads a file beside them.
2. **The scratch mount loads nothing.** The same kind of files, with other text, in a clone in a scratch mount (an extra mount outside the working folder) do not load after a Read beside them, a shell call that changes into the clone and prints a file there, and a compaction, and still not after check 3.
3. **The scratch mount works.** In the same conversation the file tools read, edit and write in the clone, git runs against it from outside and from inside, and the session deletes it while standing in the working folder, all with no prompt.

A failure holds the bump. If check 2 fails, a seat's clones are no longer safe in its scratch mount, and that goes to the operator before anything else.

## Image build surface

`container/Dockerfile` is a single-stage build on `node:22-slim`:

- **Pinned ARGs** — `BUN_VERSION`, `PNPM_VERSION`, `INSTALL_CJK_FONTS`. Bump deliberately in PRs. Global CLI versions (`@anthropic-ai/claude-code`, `agent-browser`, `vercel`) are pinned separately in `container/cli-tools.json`, not as ARGs.
- **CJK fonts** — `ARG INSTALL_CJK_FONTS=false`. `container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through. Default build saves ~200MB; opt in when the user works with Chinese/Japanese/Korean content.
- **BuildKit cache mounts** — `/var/cache/apt`, `/var/lib/apt`, `/root/.bun/install/cache`, `/root/.cache/pnpm`. Rebuilds where `package.json`/`bun.lock` haven't changed are fast. Requires BuildKit (default on Docker 23+, Apple Container-compat).
- **`tini` as init** — reaps Chromium zombies, forwards signals so in-flight `outbound.db` writes finalize on SIGTERM.
- **`entrypoint.sh`** (extracted) — `exec bun run /app/src/index.ts` under tini. Readable and diffable.
- **No compiled `/app/dist`** — Bun runs TS directly. The host also mounts fresh source over `/app/src` at session start, so host edits take effect without rebuilding the image.

## Session wake (two paths)

1. **Base image ENTRYPOINT** — used for stdin-piped test invocations like the sample in `container/build.sh`: `tini --> entrypoint.sh` captures stdin to `/tmp/input.json`, then `exec bun run src/index.ts`.
2. **Host-spawned session** — `src/container-runner.ts` at line ~503 uses `--entrypoint bash` with `-c 'exec bun run /app/src/index.ts'`. Bypasses tini (Docker's default PID 1 handling applies). Stdin is unused; all IO flows through the mounted session DBs.

Both paths end with Bun running the same source file from `/app/src/index.ts`.

## CI shape

`.github/workflows/ci.yml` installs both Node and Bun and runs the host and container checks; any failure fails the PR. Its local counterpart is the local bar in [CONTRIBUTING.md](../CONTRIBUTING.md#pr-body-shape).

## Key invariants

- **Session DBs must use `journal_mode=DELETE`.** WAL's `-shm` memory-map doesn't cross VirtioFS between host and guest. See `container/agent-runner/src/mailbox/sqlite/connection.ts` and `src/mailbox/sqlite/session-db.ts`.
- **Named SQL parameters in the container require the prefix in JS object keys.** `bun:sqlite` does not auto-strip `@`/`$`/`:` the way `better-sqlite3` does on the host. Use `$name` in both SQL and keys: `.run({ $id: msg.id })`. Positional `?` params work normally.
- **Agent-runner tests run under `bun:test`, not vitest.** `vitest.config.ts` excludes the `container/agent-runner/` tree because vitest runs on Node and can't load `bun:sqlite`.
- **No tsc build step in the container image.** Re-adding one would reintroduce the ~200-500ms per-session-wake cost we removed.
- **Global container CLIs stay on pnpm, not Bun.** `agent-browser`, `@anthropic-ai/claude-code`, `vercel` and any future Node CLIs the agent invokes should be pinned versions under the Dockerfile's pnpm global-install block. `bun install -g` would bypass the pnpm supply-chain policy.

## Migration history

This structure replaced a uniform npm-on-Node stack across both host and container. The pnpm migration landed first (PR #1771) to bring the host under supply-chain policy, then the container moved to Bun to eliminate native-module compilation and the per-wake tsc step. The split was chosen over going full-Bun because Baileys' native deps are the main risk surface on the host — the container has no such deps, so it benefits from Bun without taking the risk.
