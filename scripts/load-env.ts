// Loads the env file a script runs against: .env, or the file given with
// --env <path>. Any other file may be production, so the script prints
// what it will touch and waits for confirmation before doing anything.
// Import this first: the scripts' other imports and top-level code run after it.
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const DEFAULT = '.env';

const { values } = parseArgs({ options: { env: { type: 'string' } }, strict: false });
const flag = values.env;
if (flag === true || flag === '') fail('--env needs a path, e.g. --env .env.production');
const file = typeof flag === 'string' ? flag : DEFAULT;

if (resolve(file) === resolve(DEFAULT)) {
  dotenv.config();
} else {
  const { error } = dotenv.config({ path: file });
  if (error) fail(`can't read ${file}: ${error.message}`);

  console.log(`Env file:       ${file}`);
  console.log(`Guild ID:       ${process.env.DISCORD_GUILD_ID || '(not set)'}`);
  console.log(`Spreadsheet ID: ${process.env.GOOGLE_LEAGUE_DB_ID || '(not set)'}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type yes to continue: ');
  rl.close();
  if (answer.trim() !== 'yes') fail('cancelled, nothing was done');
}

function fail(message: string): never {
  console.error(`env: ${message}`);
  process.exit(1);
}
