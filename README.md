# GGB Bot

Discord bot for Global Gym Battles (GGB), a team-wars league for Pokémon TCG Pocket. It keeps the league's gyms and trainers in Google Sheets, runs roster requests through staff approval, ingests weekly match sheets, and keeps trainer nicknames in sync with Discord.

Bot behavior and the column-level data model are defined in the **GGB Bot Behavior Spec**. Read it before changing behavior; this README only covers running the code.

## How it works

- **Discord HTTP interactions**, not a gateway bot. Discord POSTs each slash command or button press to `/interactions`; the bot answers within 3 seconds or defers and follows up. The bot always shows as offline in Discord; that's expected.
- **Google Sheets is the database.** The bot reads and writes the League DB workbook through a Google service account. A workbook is reachable once it's shared with the service account's email.
- **One always-on Node process.** Approval locks, the `/submit` and `/rebuild` lock, and the daily nickname sync schedule live in memory, so exactly one instance may run.

## Layout

| Path | Purpose |
|---|---|
| `src/server.ts` | Express server: `POST /interactions` (signature-verified), `GET /health` |
| `src/google.ts` | Sheets and Drive clients for the service account |
| `src/schema.ts` | Every League DB tab and its columns, from the Spec |
| `scripts/register-commands.ts` | Registers slash commands to the dev guild (the single source of command definitions) |
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
| `DISCORD_DEV_GUILD_ID` | Right-click the test server > Copy Server ID (needs Developer Mode, below) |
| `DISCORD_STAFF_CHANNEL_ID` | Right-click the staff channel > Copy Channel ID |
| `GOOGLE_SERVICE_ACCOUNT_KEY_B64` | `base64 -i key.json` of the service account's JSON key |
| `GOOGLE_LEAGUE_DB_ID` | The League DB workbook URL: `docs.google.com/spreadsheets/d/<this part>/edit` |

Turn on Discord Developer Mode (User Settings > Advanced > Developer Mode) to get the "Copy ID" menu items.

## Dev loop

1. `npm run dev`
2. `cloudflared tunnel --url http://localhost:3000`
3. Paste the new URL plus `/interactions` into General Information > Interactions Endpoint URL in the dev app and save.

The tunnel URL changes every time cloudflared restarts, so step 3 repeats each session. Run `npm run register` after any change to the command definitions.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs the server with reload on save |
| `npm run build` / `npm start` | Compiles to `dist/` and runs the compiled server |
| `npm run register` | Overwrites the dev guild's slash commands with the ones in `scripts/register-commands.ts` |
| `npm run db:setup` | Builds every League DB tab in the workbook at `GOOGLE_LEAGUE_DB_ID` |
| `npm run sheets-smoke` | Checks the service account can read and write the workbook |

## Setting up a League DB workbook

1. Create an empty Google Sheets workbook.
2. Share it with the service account's email (the `client_email` in its JSON key) as Editor.
3. Put its ID in `GOOGLE_LEAGUE_DB_ID` and run `npm run db:setup`.

The script adds any missing tabs with the Spec's headers, freezes and bolds each header row, puts tabs in Spec order, and removes the empty default `Sheet1`. It's safe to re-run. If an existing tab's header doesn't match the schema, it lists the problem and writes nothing.

## Testing the import

The import reads the Discord member list once and writes the Gyms and Trainers tabs (Spec: "Initial population"). Test it against the dev test server and dev workbook, never the real ones.

> The import script is the next piece being built. The commands below are what it will take.

### 1. Test server

As server owner, in the Discord client:

1. **Channel.** Create a private text channel `#bot-staff`. Under the channel's Permissions, add the bot with View Channel and Send Messages. Copy its ID into `DISCORD_STAFF_CHANNEL_ID`.
2. **Roles.** Create these, with no permissions (they're labels only). Names must match exactly.

    | Role(s) | Purpose |
    |---|---|
    | `Participating Trainer`, `Gym Leader`, `Gym Manager`, `Non-Player` | Import marker roles |
    | `Phoenix` + `Phoenix Fan`, `Frog EX` + `Frog EX Fan`, `Daybreak` + `Daybreak Fan` | Three active gyms |
    | `Team Skull` + `Team Skull Fan` | An S4 relegated gym; must come out `relegated`, not active |

3. **Accounts.** You plus 3 alts. Create alts with Gmail plus-addressing (`you+ggb1@gmail.com`) and switch between them with Discord's account switcher (click your avatar > Switch Accounts). Invite each with right-click the server > Invite People. A friend works too if Discord demands phone verification.

### 2. Run A

Assign roles (right-click a member > Roles):

| Member | Roles | Expected |
|---|---|---|
| You | Participating Trainer, Phoenix, Gym Leader | Imported, `leader` |
| Alt1 | Participating Trainer, Phoenix, Non-Player | Imported, `non-playing` |
| Alt2 | Participating Trainer, Frog EX, Gym Leader, Gym Manager | Imported, `leadership = none`, flagged |
| Alt3 | Participating Trainer, Phoenix, Frog EX | Not imported: more than one gym role |

```sh
npm run import -- --season 5 --dry-run
```

Check the report printed to the terminal and posted to `#bot-staff`. Daybreak and Frog EX should show `[Needs 1]` on Leaders, and every gym `[Needs 8-15]` on Participating trainers.

### 3. Run B

Keep your roles; change the alts:

| Member | Roles | Expected |
|---|---|---|
| Alt1 | Participating Trainer, Daybreak, Gym Manager | Imported to Daybreak, `manager` |
| Alt2 | Participating Trainer, Phoenix, Team Skull | Not imported: more than one gym role (relegated gym roles count) |
| Alt3 | Frog EX only | Not imported: gym role without Participating Trainer |

Run the dry run again. Phoenix should show 1 Leader and 1 Participating trainer, Daybreak 1 Manager and 1 Participating trainer, Frog EX nobody, and "Both Gym Leader and Gym Manager" none.

### 4. Commit

1. Run `npm run db:setup` if the dev workbook is new.
2. `npm run import -- --season 5 --commit`
3. In the dev workbook, check the Gyms tab (three `active` gyms plus the four S4 gyms as `relegated`), the Trainers tab (one row per imported trainer) and Roster history (one `import` row per trainer).
4. Run the commit again: it should refuse because Trainers already has rows. `--force` resets and re-imports.
