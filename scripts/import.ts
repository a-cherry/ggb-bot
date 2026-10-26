// One-shot import of gyms and trainers from Discord (Spec: "Initial population").
//   npm run import -- --season 5 --dry-run   reads Discord, writes nothing, posts the report
//   npm run import -- --season 5 --commit    (not built yet)
import dotenv from 'dotenv';
dotenv.config();
import { parseArgs } from 'node:util';
import { getLeagueConfig } from '../src/config.js';
import { listMembers, listRoles, MESSAGE_LIMIT, postMessage } from '../src/discord.js';
import { classify, missingMarkerRoles } from './import/classify.js';
import { buildReport, splitMessages } from './import/report.js';

const { values: args } = parseArgs({
  options: {
    season: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    commit: { type: 'boolean', default: false },
  },
});

const season = Number(args.season);
if (!Number.isInteger(season) || season < 1) fail('--season <number> is required');
if (args['dry-run'] === args.commit) fail('pass exactly one of --dry-run or --commit');
if (args.commit) fail('--commit is not built yet');

const guildId = process.env.DISCORD_DEV_GUILD_ID;
if (!guildId) fail('DISCORD_DEV_GUILD_ID is not set');
const staffChannelId = process.env.DISCORD_STAFF_CHANNEL_ID;

const config = getLeagueConfig();
const [roles, members] = await Promise.all([listRoles(guildId), listMembers(guildId)]);

const missing = missingMarkerRoles(roles, config);
if (missing.length) {
  fail(`these roles from config/league.json don't exist in the server: ${missing.join(', ')}`);
}

const result = classify(roles, members, config);
const title = `GGB import: dry run, season ${season}`;
const memberCount = members.filter((m) => !m.user.bot).length;

const terminal = buildReport(result, { title, memberCount, mention: (m) => m.name });
console.log(terminal.join('\n').replace(/\*\*/g, ''));

if (!staffChannelId) {
  console.warn('\nDISCORD_STAFF_CHANNEL_ID is not set; report not posted.');
} else {
  const discord = buildReport(result, { title, memberCount, mention: (m) => `<@${m.discordId}>` });
  for (const message of splitMessages(discord, MESSAGE_LIMIT)) await postMessage(staffChannelId, message);
  console.log('\nReport posted to the staff channel.');
}

function fail(message: string): never {
  console.error(`import: ${message}`);
  process.exit(1);
}
