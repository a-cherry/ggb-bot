// One-shot import of gyms and trainers from Discord (Bot Spec: "Initial population").
//   npm run import -- --season 5 --dry-run           reads Discord, writes nothing, posts the report
//   npm run import -- --season 5 --commit            writes Gyms, Trainers and Roster history
//   npm run import -- --season 5 --commit --force    resets those tabs and imports again
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs } from 'node:util';
import { getLeagueConfig } from '../src/config.js';
import { listMembers, listRoles, MESSAGE_LIMIT, postMessage } from '../src/discord.js';
import { checkTabs, countRows, getLeagueDbId } from '../src/league-db.js';
import { TABS } from '../src/schema.js';
import { classify, missingMarkerRoles } from './import/classify.js';
import { writeImport } from './import/commit.js';
import { buildReport, splitMessages } from './import/report.js';

// Tabs the import writes, and tabs that store a gym_id. A reset mints gym_ids
// afresh, so rows in those tabs would silently point at a different gym.
const WRITTEN = [TABS.gyms.name, TABS.trainers.name, TABS.rosterHistory.name];
const DEPENDENT = [TABS.divisions.name, TABS.matches.name, TABS.matchRosters.name, TABS.rosterRequests.name];

const { values: args } = parseArgs({
  options: {
    season: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    commit: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

const season = Number(args.season);
if (!Number.isInteger(season) || season < 1) fail('--season <number> is required');
if (args['dry-run'] === args.commit) fail('pass exactly one of --dry-run or --commit');
if (args.force && !args.commit) fail('--force only applies to --commit');

const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) fail('DISCORD_GUILD_ID is not set');
const staffChannelId = process.env.DISCORD_STAFF_CHANNEL_ID;
const spreadsheetId = getLeagueDbId();

const tabProblems = [...(await checkTabs(spreadsheetId))].filter(([, s]) => s.kind !== 'ok');
if (tabProblems.length) {
  fail(
    'the League DB tabs are not set up. Run npm run db:setup first.\n' +
      tabProblems.map(([name, s]) => `  ${name}: ${s.kind === 'problem' ? s.message : s.kind}`).join('\n'),
  );
}

if (args.commit) {
  const rows = await countRows(spreadsheetId, [...WRITTEN, ...DEPENDENT]);
  const filled = (names: string[]) => names.filter((n) => rows.get(n)! > 0);
  if (filled(WRITTEN).length && !args.force) {
    fail(`${filled(WRITTEN).join(', ')} already have rows. Re-running is a reset; pass --force to replace them.`);
  }
  if (filled(DEPENDENT).length) {
    fail(
      `${filled(DEPENDENT).join(', ')} have rows that store gym IDs. A reset assigns new IDs, ` +
        'so those rows would point at the wrong gyms. Fix rosters with requests or in the sheet instead.',
    );
  }
}

const config = getLeagueConfig();
const [roles, members] = await Promise.all([listRoles(guildId), listMembers(guildId)]);

const missing = missingMarkerRoles(roles, config);
if (missing.length) {
  fail(`these roles from config/league.json don't exist in the server: ${missing.join(', ')}`);
}

const result = classify(roles, members, config);
if (args.commit) await writeImport(spreadsheetId, result, season);

const committed = args.commit;
const title = `GGB import: ${committed ? 'committed' : 'dry run'}, season ${season}`;
const memberCount = members.filter((m) => !m.user.bot).length;

const terminal = buildReport(result, { title, memberCount, committed, mention: (m) => m.name });
console.log(terminal.join('\n').replace(/\*\*/g, ''));

if (!staffChannelId) {
  console.warn('\nDISCORD_STAFF_CHANNEL_ID is not set; report not posted.');
} else {
  const discord = buildReport(result, { title, memberCount, committed, mention: (m) => `<@${m.discordId}>` });
  for (const message of splitMessages(discord, MESSAGE_LIMIT)) await postMessage(staffChannelId, message);
  console.log('\nReport posted to the staff channel.');
}

function fail(message: string): never {
  console.error(`import: ${message}`);
  process.exit(1);
}
