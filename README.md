# GGB Bot

Discord bot for Global Gym Battles (GGB), a team-wars league for Pokémon TCG Pocket. It keeps the league's gyms and trainers in Google Sheets, runs roster requests through staff approval, ingests weekly match sheets, and keeps trainer nicknames in sync with Discord.

Bot behavior and the column-level data model are defined in the **GGB Bot Spec**, with `/roster` and `/gym` in detail in the **GGB Roster Spec**. Read them before changing behavior; this README only covers running the code.

## How it works

- **Discord HTTP interactions**, not a gateway bot. Discord POSTs each slash command or button press to `/interactions`; the bot answers within 3 seconds or defers and follows up. The bot always shows as offline in Discord; that's expected.
- **Google Sheets is the database.** The bot reads and writes the League DB workbook through a Google service account. A workbook is reachable once it's shared with the service account's email.
- **One always-on Node process.** Approval locks, the `/submit` and `/rebuild` lock, and the daily nickname sync schedule live in memory, so exactly one instance may run.
- **Deploys.** On SIGTERM the bot stops taking interactions and waits up to 25 seconds for the ones in progress, so an approval isn't cut off halfway; one that runs longer is finished by startup recovery. The host must not run the old and new process at the same time (see Deploy). Startup recovery leaves an approval claimed in the last 150 seconds alone until it's that old, in case an old process is still finishing it.

## Layout

| Path | Purpose |
|---|---|
| `src/server.ts` | Express server: `POST /interactions` (signature-verified), `GET /health` (503 until startup finishes) |
| `render.yaml` | Render Blueprint for the hosted bot (see Deploy) |
| `src/interactions.ts` | Deferred slash command replies and button presses: acknowledge at once, fill in the result later |
| `src/commands/` | Slash command definitions and handlers (`index.ts` lists them all) |
| `src/sheet-rows.ts` | Typed read, append and update of League DB rows |
| `src/seasons.ts` | Active season and in season vs off-season |
| `src/roster/` | Roster requests: League DB reads, request checks, request rows and cards, approval |
| `src/locks.ts` | In-memory locks (request IDs, one approval per gym at a time) |
| `src/views.ts` | League Stats views rebuild (empty until the views are built) |
| `src/google.ts` | Sheets client for the service account, with timeouts and retries |
| `src/schema.ts` | Every League DB tab and its columns, from the Bot Spec's Data model |
| `src/league-db.ts` | Checks the League DB tabs against the schema |
| `src/discord.ts` | Discord REST calls: roles, members, messages, deferred replies |
| `src/config.ts` | Loads `config/league.json`: import and staff role names, S4 relegated gyms |
| `scripts/import.ts`, `scripts/import/` | The one-shot import of gyms and trainers |
| `scripts/load-env.ts` | Loads `.env` or the file given with `--env`, which needs confirming first |
| `scripts/register-commands.ts` | Registers the slash commands in `src/commands/` to the server in `DISCORD_GUILD_ID` |
| `scripts/db-setup.ts` | Builds all League DB tabs in an empty workbook |
| `scripts/sheets-smoke.ts` | Writes and reads the `Bot state` tab to check Sheets access |

`scripts/` are dev tools run with `tsx`; they aren't part of the production build.

## Setup

Requires Node 22 or later.

```sh
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` | Discord Developer Portal > your app > General Information |
| `DISCORD_BOT_TOKEN` | Developer Portal > Bot > Reset Token |
| `DISCORD_GUILD_ID` | The Discord server the bot runs in (the test server in development): right-click it > Copy Server ID (needs Developer Mode, below) |
| `DISCORD_STAFF_CHANNEL_ID` | Right-click the staff channel > Copy Channel ID. Gets the import report and roster request approval cards |
| `DISCORD_TRANSFER_ANNOUNCEMENTS_CHANNEL_ID` | Same, for the channel where approved roster changes are announced |
| `DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID` | Same, for the channel where match results are announced (not used yet) |
| `DISCORD_STAFF_ROLE_IDS` | The four staff roles (Server Owner, League CEO, Head Referee, Referee), comma-separated: Server Settings > Roles, right-click each > Copy Role ID. Only these can approve, reject and repost requests; checked by ID, so a role renamed to match can't pass |
| `GOOGLE_SERVICE_ACCOUNT_KEY_B64` | `base64 -i key.json` of the service account's JSON key |
| `GOOGLE_LEAGUE_DB_ID` | The League DB workbook URL: `docs.google.com/spreadsheets/d/<this part>/edit` |

Turn on Discord Developer Mode (User Settings > Advanced > Developer Mode) to get the "Copy ID" menu items.

## Dev loop

1. `npm run dev`
2. `cloudflared tunnel --url http://localhost:3000`
3. Paste the new URL plus `/interactions` into General Information > Interactions Endpoint URL in the dev app and save.

The tunnel URL changes every time cloudflared restarts, so step 3 repeats each session. Run `npm run register` after any change to the command definitions.

## Deploy

The bot runs on Render as a Starter web service (always on), set up from `render.yaml` in the repo root: Render dashboard > New > Blueprint, connect the repo, and Render creates the service from the file. Creating it by hand works too with the same settings.

| Setting | Value | Why |
|---|---|---|
| Branch | `production` | Deploys come from this branch, not `main`. Ship with `git push origin main:production` |
| Plan and instances | Starter, 1 instance | Locks and recovery live in memory, so exactly one process may run. Never scale out |
| Build | `npm ci --include=dev && npm run build` | TypeScript is a dev dependency |
| Start | `node dist/server.js` | Not `npm start` or `npm run dev`, so SIGTERM reaches the bot itself |
| Disk | 1 GB at `/var/data`, unused | A disk turns off Render's zero-downtime deploys, so the old process stops before the new one starts. Without it the two overlap for a minute or more, and the new one's startup recovery could take over an approval the old one is still writing. Don't remove it |
| Health check | `/health` | Answers 503 until the League DB header check and startup recovery finish, then 200; 503 again after SIGTERM. Render sends traffic only once it's 200 |
| Shutdown delay | Not set | Render won't set one on a service with a disk and kills 30 seconds after SIGTERM, so the bot drains for at most 25 |

Each deploy has a few seconds of downtime between the old process stopping and the new one passing its health check. A button pressed then shows "This interaction failed"; pressing it again works.

**Environment variables.** Every variable in the Setup table, set in the service's Environment tab; `render.yaml` lists them by name with `sync: false` and never holds values. Render sets `PORT` itself. Never set `GGB_CRASH_AT` or `GGB_FAIL_AT` on Render.

**Discord.** After the first deploy is live, stop any local bot that uses the same League DB, then set the app's Interactions Endpoint URL (Developer Portal > General Information) to `https://<service>.onrender.com/interactions` and save. Discord sends a PING first, so a save that succeeds means the bot answered. The hosted bot doesn't register commands itself. After any change to the command definitions ships to production, wait for the deploy to go live, then run `npm run register -- --env .env.production` from your machine. Registering first would show trainers commands the running bot can't handle yet.

**Logs.** On a deploy, expect the old process's `SIGTERM: N interaction(s) in progress` and `interactions finished after Ns` (or the 25-second timeout line) before the new one's `listening on 10000` and `startup finished; taking interactions`.

**Railway.** The code is host-agnostic and runs on Railway too: set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60` so Railway waits for the drain, and leave `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` unset. Railway still sends new interactions to the new process while the old one drains; the 150-second recovery wait covers that.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs the server with reload on save |
| `npm run build` / `npm start` | Compiles to `dist/` and runs the compiled server |
| `npm run register` | Overwrites the slash commands in the `DISCORD_GUILD_ID` server with the ones in `scripts/register-commands.ts` |
| `npm run db:setup` | Builds every League DB tab in the workbook at `GOOGLE_LEAGUE_DB_ID` |
| `npm run sheets-smoke` | Checks the service account can read and write the workbook |
| `npm run import -- --season N --dry-run` / `--commit [--force]` | Imports gyms and trainers from Discord (see Testing the import) |

`register`, `db:setup`, `import` and `sheets-smoke` read `.env`. Add `--env <path>` to use another file, e.g. `npm run register -- --env .env.production`. With any file other than `.env`, the script prints the file, guild ID and spreadsheet ID and does nothing until you type `yes`.

## Setting up a League DB workbook

### Build a new workbook

1. Create an empty Google Sheets workbook.
2. Share it with the service account as Editor. The email is the `client_email` in the key; to print it:

    ```sh
    K="$(grep GOOGLE_SERVICE_ACCOUNT_KEY_B64 .env | cut -d= -f2-)" node -e "console.log(JSON.parse(Buffer.from(process.env.K,'base64')).client_email)"
    ```

3. Put the workbook ID in `.env` as `GOOGLE_LEAGUE_DB_ID`. It's the part of the URL between `/d/` and `/edit`.
4. Build the tabs and check access:

    ```sh
    npm run db:setup
    npm run sheets-smoke
    ```

`db:setup` adds any missing tabs with the Bot Spec's headers, freezes and bolds each header row, puts tabs in that order, and removes the empty default `Sheet1`. It's safe to re-run: tabs that already match print `ok`. If an existing tab's header doesn't match the schema, it lists expected vs found and writes nothing.

### After a schema change

When a column is added to or changed in `src/schema.ts`, `db:setup` refuses on that tab. `db:setup` never rewrites a header over existing data, so the fix depends on the workbook:

- **Dev workbook (test data only):** delete the tab in Google Sheets, then rebuild it and re-import:

    ```sh
    npm run db:setup
    npm run import -- --season 5 --commit --force
    ```

- **Real League DB:** don't delete anything. Insert the new column in the tab by hand at the position the schema expects, type its header, then run `npm run db:setup` to confirm every tab prints `ok`.

## Testing the import

The import reads the Discord member list once and writes the Gyms and Trainers tabs (Bot Spec: "Initial population"). Test it against the dev test server and dev workbook, never the real ones.

### 1. Test server

As server owner, in the Discord client:

1. **Channel.** Create a private text channel `#bot-staff`. Under the channel's Permissions, add the bot with View Channel, Send Messages and Read Message History (a cancelled request's card is found by reading recent messages). Copy its ID into `DISCORD_STAFF_CHANNEL_ID`.
2. **Roles.** Create these, with no permissions (they're labels only). Names must match exactly.

    | Role(s) | Purpose |
    |---|---|
    | `Participating Trainer`, `Gym Leader`, `Gym Vice-Leader`, `Non-Player` | Import marker roles |
    | `Phoenix` + `Phoenix Fan`, `Frog EX` + `Frog EX Fan`, `Daybreak` + `Daybreak Fan` | Three active gyms |
    | `Team Skull` + `Team Skull Fan` | An S4 relegated gym; must come out `relegated`, not active |

3. **Accounts.** You plus 3 alts. Create alts with Gmail plus-addressing (`you+ggb1@gmail.com`) and switch between them with Discord's account switcher (click your avatar > Switch Accounts). Invite each with right-click the server > Invite People. A friend works too if Discord demands phone verification.

### 2. Run A

Assign roles (right-click a member > Roles):

| Member | Roles | Expected |
|---|---|---|
| You | Participating Trainer, Phoenix, Gym Leader | Imported, `leader` |
| Alt1 | Participating Trainer, Phoenix, Non-Player | Imported, `non-playing` |
| Alt2 | Participating Trainer, Frog EX, Gym Leader, Gym Vice-Leader | Imported, `leadership = none`, flagged |
| Alt3 | Participating Trainer, Phoenix, Frog EX | Not imported: more than one gym role |

```sh
npm run import -- --season 5 --dry-run
```

Check the report printed to the terminal and posted to `#bot-staff`. Daybreak and Frog EX should show `[Needs 1]` on Leaders, and every gym `[Needs 8-15]` on Participating trainers.

### 3. Run B

Keep your roles; change the alts:

| Member | Roles | Expected |
|---|---|---|
| Alt1 | Participating Trainer, Daybreak, Gym Vice-Leader | Imported to Daybreak, `vice-leader` |
| Alt2 | Participating Trainer, Phoenix, Team Skull | Not imported: more than one gym role (relegated gym roles count) |
| Alt3 | Frog EX only | Not imported: gym role without Participating Trainer |

Run the dry run again. Phoenix should show 1 Leader and 1 Participating trainer, Daybreak 1 Vice-Leader and 1 Participating trainer, Frog EX nobody, and "Both Gym Leader and Gym Vice-Leader" none.

### 4. Commit

1. Run `npm run db:setup` if the dev workbook is new. Both import modes refuse to run until every tab is set up.
2. `npm run import -- --season 5 --commit`
3. In the dev workbook, check:
    - Gyms: one `active` row per gym role, plus the four S4 gyms as `relegated`, with IDs `G001`, `G002`, ... in name order.
    - Trainers: one row per imported trainer. Discord IDs must show every digit (they're stored as text).
    - Roster history: one `import` row per trainer, before columns blank.
4. Run the commit again: it should refuse because Gyms, Trainers and Roster history have rows. `--force` clears those three tabs and imports again. `--force` still refuses if Divisions, Matches, Match rosters or Roster requests have rows: they store gym IDs, and a reset assigns new ones.

## Roster requests setup

Roster and gym commands work only in `#transfer-request` and `#bot-staff`. Discord enforces this, not the bot, so it's set by hand in each server (dev and production) after `npm run register`:

1. Server Settings > Integrations > the bot.
2. Open `/roster` > Add Channels, add "All Channels", `#transfer-request` and `#bot-staff`, set All Channels to ✗ and the other two to ✓, and save. Leave Role & Member Overrides empty. Do the same for `/gym`.
3. Check from an account without Administrator. The server owner (and likely anyone with Administrator) still sees the command in every channel; that's expected.

Approving a request also changes Discord roles, so the bot needs Manage Roles, with its role above every gym role and gym fan role (a rebrand renames both), Participating Trainer, Non-Player, Gym Leader and Gym Vice-Leader and below the staff roles (Roster Spec: "What each change does").
