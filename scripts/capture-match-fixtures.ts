// Captures the test fixtures for match ingestion. Read-only.
//   test/fixtures/example-match.json  the Example Match tab's anchor ranges, FORMATTED_VALUE
//   test/fixtures/league.json         the League DB rows that tab needs: its two gyms,
//                                     one relegated gym, its ten Trainers, all Seasons
// Run with --env .env.production to read the production League DB, which has
// the real gyms and Trainers the template uses. The players are replaced with
// made-up ones before writing (see anonymize-fixtures.ts), so the fixtures
// hold no real names or Discord IDs.
import './load-env.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { getSheets } from '../src/google.js';
import { MATCH_RANGES } from '../src/match/parse.js';
import { tabRange } from '../src/schema.js';
import { readTabs } from '../src/sheet-rows.js';
import { anonymizeFixtures } from './anonymize-fixtures.js';

// The GGB Match Template workbook and its sample tab.
const TEMPLATE_ID = '1xaTNBCumylo92Q6-_DVXR-CQFw59i5BOu0Xf4aDS6fg';
const TAB = 'Example Match';
const OUT = 'test/fixtures';

const res = await getSheets().spreadsheets.values.batchGet({
  spreadsheetId: TEMPLATE_ID,
  ranges: MATCH_RANGES.map((r) => `${tabRange(TAB)}!${r}`),
  valueRenderOption: 'FORMATTED_VALUE',
});
const ranges = Object.fromEntries(
  MATCH_RANGES.map((r, i) => [r, (res.data.valueRanges![i].values ?? []).map((row) => row.map(String))]),
);
const match = { tab: TAB, ranges };

// AK2:AL2 are the gym IDs; AP4:AP13 the ten Discord IDs (column F of AK1:AP13).
const helper = ranges['AK1:AP13'];
const gymIds = [helper[1]?.[0], helper[1]?.[1]];
const discordIds = helper.slice(3, 13).map((row) => row[5]);
if (gymIds.some((g) => !g) || discordIds.length !== 10 || discordIds.some((d) => !/^\d{17,19}$/.test(d ?? ''))) {
  throw new Error(`Example Match helper block didn't read as expected: ${JSON.stringify(helper)}`);
}

const [gyms, trainers, seasons] = await readTabs('gyms', 'trainers', 'seasons');
const relegated = gyms.find((g) => g.values.status === 'relegated');
if (!relegated) throw new Error('No relegated gym in the League DB to use as a fixture');
const league = {
  gyms: [...gyms.filter((g) => gymIds.includes(g.values.gym_id)), relegated],
  trainers: trainers.filter((t) => discordIds.includes(t.values.discord_id)),
  seasons,
  matches: [],
  decks: [],
};
if (league.gyms.length !== 3) {
  const missing = gymIds.filter((g) => !gyms.some((r) => r.values.gym_id === g));
  throw new Error(`Expected gyms ${gymIds.join(', ')} in the League DB; missing ${missing.join(', ')}`);
}
if (league.trainers.length !== 10) {
  const missing = discordIds.filter((d) => !trainers.some((t) => t.values.discord_id === d));
  throw new Error(`Expected 10 Trainers, found ${league.trainers.length}; missing ${missing.join(', ')}`);
}

const out = anonymizeFixtures(match, league);
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/example-match.json`, JSON.stringify(out.match, null, 2) + '\n');
await writeFile(`${OUT}/league.json`, JSON.stringify(out.league, null, 2) + '\n');
console.log(`Wrote ${OUT}/example-match.json and ${OUT}/league.json`);
