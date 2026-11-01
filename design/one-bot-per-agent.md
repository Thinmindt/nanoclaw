# One Discord bot per agent

This page is public once it is in the repository. It names roles and placeholders, never an install's agents: their names, pictures and keys live in the install's `.env`, the Developer Portal and the install's own records, none of which are committed. Line pointers are to the fork's `main` at 17c74742 unless they say `channels`.

## What changes

Today one Discord bot speaks for every agent, so in a room shared by three agents three replies arrive under one name. After this change each agent group has its own bot: each agent posts under its own bot's name, and each bot's DM with the owner carries that agent's approval cards.

## The model

One messaging-group row per room and bot, each wired to its own agent. Nothing new is invented: the host already keys adapters, rows, delivery and cards by instance.

- The registry keys adapters by `instance ?? channelType`, so several Discord instances coexist (`src/channels/channel-registry.ts:307-312`).
- The router persists the receiving instance on each `messaging_groups` row, unique on channel type, platform id and instance (`src/router.ts:241-261`; migration 016).
- Delivery sends through the origin row's instance (`src/delivery.ts:449-491`), and the registry dispatches by exact key with no sibling fallback (`src/channels/channel-registry.ts:99-128`).
- Approval cards go to the approver's DM on the origin instance (`src/modules/permissions/sender-approval.ts:100`, `src/modules/approvals/primitive.ts:166-184`, `src/modules/permissions/user-dm.ts:54-110`).

"Routing picks the bot per wiring" is out: it would fight the unique key and the exact-key delivery.

## Instances

- The existing bot keeps the instance key `discord`. That key is the default: cards with no channel origin (ncl approvals, gate taps) resolve through `getChannelAdapter('discord')`, whose fallback to a differently keyed instance only warns (`channel-registry.ts:53-66`). Keeping the existing bot on it means the owner's existing DM row and pending approvals stay where they are. Which agent it serves is the install's choice.
- Each further bot registers as `discord-<instance>`, where `<instance>` is a short lowercase label chosen at install time (by role, for example `architect`, is the recommendation, so the key outlives any renaming). This is the shape Slack already uses on the `channels` branch: an instances list plus suffixed env keys (`SLACK_INSTANCES`, `SLACK_BOT_TOKEN_<NAME>`; add-slack SKILL.md:148-150).
- Each bot needs all three values: token, public key, application id (`createDiscordBridge` in `src/channels/discord.ts`, `channels`). Env shape: `DISCORD_INSTANCES=<a>,<b>`, then `DISCORD_BOT_TOKEN_<A>`, `DISCORD_PUBLIC_KEY_<A>`, `DISCORD_APPLICATION_ID_<A>`, and so on. The unsuffixed three stay the default instance. The bot's display name and picture are Developer Portal settings, not code.
- Registration is per entry: a missing or wrong value for one bot fails only that bot, with a named log line; the others start. `discord-registration.test.ts` grows a case for the instances loop (today it pins only `discord`).
- `setup/verify.ts` checks the suffixed keys as well as `DISCORD_BOT_TOKEN` (`discordInstanceAuth` in `setup/verify.ts`).

## Sibling bots in one room

With several bots in a shared room, each bot also receives the others' posts. This change leaves them where the Discord defaults put them: an unapproved sender, held at the sender gate (`DISCORD_DEFAULTS` in `src/channels/discord.ts`, `request_approval`). One test covers it: a bot-authored inbound on one instance is held, not engaged. Letting agents read each other is a later change with its own page.

## Cutover

Rows and sessions do not move by themselves. Moving a room to a named bot is a new row, a new wiring and a new session; the old row is retired by hand. Order:

1. Throwaway channel first: two bots, one message each, under their own names.
2. Then one agent's room at a time. Rooms and the owner's DM that belong to the agent kept on the default instance do not move.
3. The shared room last: one new row per non-default bot, each wired to its agent, beside the existing default row. Each bot invited to the server and the channel.
4. Pending approvals on moved rooms re-raised on the new instance; old rows retired.
5. Each agent's scheduled tasks post through its own bot after the move (one check per agent).

The install's own order, with its room names and dates, is kept in the install's records, not here.

## Where it lands

In two places, the way upstream's maintenance doc divides the tree (docs/BRANCH-FORK-MAINTENANCE.md): adapter code on the `channels` registry branch, skill definitions and setup code on `main`.

- **`channels`:** `discord.ts` and its tests. Fixes to existing adapters land as pull requests based on the registry branch, and the add-discord skill copies these files from there into a clone, overwriting what is there.
- **`main`:** the add-discord skill (the copy list, which now includes the sibling-bot gate test, and the setup section), `setup/verify.ts`, and this page. With them, the applied result: add-discord re-run on `main`, which copies the new adapter and tests in.

`channels` merges first. Main's skill lists a file only the new `channels` carries, and both the skill install and the registry-skills check fail until it is there.

A fork that carries its own `channels` must have every install path copy from it. Setup's skill driver resolves the remote whose URL is the upstream repository (`setup/lib/channels-remote.sh`), while the skill engine and `/update-skills` prefer `origin` when it carries the branch; `NANOCLAW_CHANNELS_REMOTE=origin`, set in the shell environment (these paths read the process environment, not `.env`), makes them all copy from the fork. Without it, a setup-driven reinstall would put upstream's adapter back.

The next forward merge of upstream's `channels` into the fork's conflicts on `discord.ts` only if upstream changed the same lines, which is the signal to re-read. Offer the adapter upstream as a pull request against `channels` and the skill change as one against `main`; if they are not taken, the fork keeps them. Build and test after every forward merge, as the maintenance doc says.

## Setup docs

Adding a bot per agent becomes a documented step: the Developer Portal work for each bot (application, bot user, name, About Me, picture, server invite with the right scopes), the three env values, the instances list, and one line in the shared room to confirm. Names and pictures are the install's own.

## Gates

`pnpm test`, `pnpm typecheck`, `pnpm lint`; the registration test and the sender-gate test above; the Architect's review of the diff before merge.
