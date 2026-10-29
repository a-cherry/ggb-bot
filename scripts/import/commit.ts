// Writes the classified import to the Gyms, Trainers and Roster history tabs.
// Callers check the tabs and the --force rules first (see scripts/import.ts).
import { getSheets } from '../../src/google.js';
import { TABS, tabRange } from '../../src/schema.js';
import type { Classification } from './classify.js';

export interface CommitCounts {
  activeGyms: number;
  relegatedGyms: number;
  trainers: number;
}

// gym_id: G001, G002, ... in name order. Short and sequential so staff can
// mint the next one by hand when they add a gym in the sheet.
function mintGymIds(names: string[]): Map<string, string> {
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  return new Map(sorted.map((name, i) => [name, `G${String(i + 1).padStart(3, '0')}`]));
}

export async function writeImport(
  spreadsheetId: string,
  c: Classification,
  season: number,
): Promise<CommitCounts> {
  const ids = mintGymIds([...c.activeGyms, ...c.relegatedGyms]);
  const now = new Date().toISOString();

  // Column order must match src/schema.ts.
  const gyms = [
    ...c.activeGyms.map((name) => [ids.get(name)!, name, '', 'active', '']),
    ...c.relegatedGyms.map((name) => [ids.get(name)!, name, '', 'relegated', '']),
  ].sort((a, b) => a[0].localeCompare(b[0]));

  const trainers = c.trainers.map((t) => [
    t.discordId, t.name, t.username, '', ids.get(t.gym)!, t.role, t.leadership, 'active',
  ]);

  // Before: no gym. After: their gym, role and leadership (Bot Spec: "Initial population").
  const history = c.trainers.map((t) => [
    season, now, t.discordId, '', '', '', ids.get(t.gym)!, t.role, t.leadership, 'import', '',
  ]);

  const tabs = [TABS.gyms.name, TABS.trainers.name, TABS.rosterHistory.name];
  const sheets = getSheets();
  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges: tabs.map((n) => `${tabRange(n)}!A2:ZZ`) },
  });
  // RAW keeps Discord IDs as text; parsed, they'd become numbers and lose digits.
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${tabRange(TABS.gyms.name)}!A2`, values: gyms },
        { range: `${tabRange(TABS.trainers.name)}!A2`, values: trainers },
        { range: `${tabRange(TABS.rosterHistory.name)}!A2`, values: history },
      ].filter((d) => d.values.length > 0),
    },
  });

  return { activeGyms: c.activeGyms.length, relegatedGyms: c.relegatedGyms.length, trainers: trainers.length };
}
