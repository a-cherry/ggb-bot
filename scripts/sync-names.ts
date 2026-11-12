// Previews the nightly name sync: reads the Discord members and the Trainers
// tab, prints the names the bot would change and the rostered Trainers it would
// take off their gyms for leaving the server, and writes nothing.
//   npm run sync-names                          against the workbook in .env
//   npm run sync-names -- --env .env.production against another env file
// Read-only on purpose. The bot's locks live in its own process, so a write from
// here could race an approval; the bot writes the names itself (see
// src/jobs/name-sync.ts), and catches up at boot if a night was missed.
// Names print to the terminal only, never to Discord.
import './load-env.js';
import { parseArgs } from 'node:util';
import { listMembers } from '../src/discord.js';
import { belowFloor, diffNames, MAX_DEPARTURES, MIN_MATCH_RATE } from '../src/jobs/name-diff.js';
import { readTabs } from '../src/sheet-rows.js';

parseArgs({ options: { env: { type: 'string' } } }); // --env is read by load-env; anything else is refused

const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) {
  console.error('sync-names: DISCORD_GUILD_ID is not set');
  process.exit(1);
}

const members = await listMembers(guildId);
const [trainers, gyms] = await readTabs('trainers', 'gyms');
const { changes, departures, matched, total } = diffNames(members, trainers);
const gymName = (id: string) => gyms.find((g) => g.values.gym_id === id)?.values.name ?? id;

const percent = total ? Math.round((matched / total) * 1000) / 10 : 100;
const wouldAbort = members.length === 0 || belowFloor({ matched, total }) || departures.length > MAX_DEPARTURES;

console.log(`Server members:         ${members.length}`);
console.log(`Rostered Trainers:      ${total} (of ${trainers.length} Trainers rows)`);
console.log(`In the server:          ${matched} (${percent}%; the bot aborts below ${MIN_MATCH_RATE * 100}%)`);
console.log(`Rows the bot would rename: ${changes.length}`);
console.log(`Left the server:        ${departures.length} rostered (the bot aborts above ${MAX_DEPARTURES})`);
if (wouldAbort) console.log('\nThe bot would ABORT this run. Nothing would be written.');

for (const d of departures) {
  const lead = d.before.leadership === 'none' ? '' : `, ${d.before.leadership}`;
  console.log(`  row ${d.rowNumber}: ${d.before.server_nickname || d.before.username} (${d.before.discord_id}) ` +
    `off ${gymName(d.before.gym_id)}${lead}; status ${d.before.status} -> ${d.after.status}`);
}
if (departures.length) console.log('');

const before = new Map(trainers.map((t) => [t.rowNumber, t.values]));
const SAMPLE = 25;
for (const change of changes.slice(0, SAMPLE)) {
  const old = before.get(change.rowNumber)!;
  const parts: string[] = [];
  if (old.server_nickname !== change.values.server_nickname) parts.push(`name "${old.server_nickname}" -> "${change.values.server_nickname}"`);
  if (old.username !== change.values.username) parts.push(`username "${old.username}" -> "${change.values.username}"`);
  console.log(`  row ${change.rowNumber}: ${parts.join(', ')}`);
}
if (changes.length > SAMPLE) console.log(`  ... and ${changes.length - SAMPLE} more`);
console.log('\nDry run: nothing was written.');
