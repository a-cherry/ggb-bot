// Builds every League DB tab in an existing workbook (GOOGLE_LEAGUE_DB_ID).
// Safe to re-run: a tab with the right header is left alone, a missing tab is
// added, and any header mismatch stops the run before anything is written.
import dotenv from 'dotenv';
dotenv.config();
import type { sheets_v4 } from 'googleapis';
import { getSheets } from '../src/google.js';
import { checkTabs, getLeagueDbId, getTabIds, isTabEmpty } from '../src/league-db.js';
import { TABS, tabRange } from '../src/schema.js';

// The tab a new Google Sheets workbook starts with. Removed when empty.
const DEFAULT_TAB = 'Sheet1';

const spreadsheetId = getLeagueDbId();
const sheets = getSheets();
const schema = Object.values(TABS);

// Plan: check every existing schema tab's header before writing anything.
const status = await checkTabs(spreadsheetId);
const problems = [...status].flatMap(([name, s]) => (s.kind === 'problem' ? [`${name}: ${s.message}`] : []));
if (problems.length) {
  console.error('Nothing was written. Fix these tabs and re-run:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const toAdd = schema.filter((t) => status.get(t.name)!.kind === 'missing').map((t) => t.name);
const needHeader = schema.filter((t) => status.get(t.name)!.kind !== 'ok').map((t) => t.name);
const existing = await getTabIds(spreadsheetId);
const removeDefault = existing.has(DEFAULT_TAB) && (await isTabEmpty(spreadsheetId, DEFAULT_TAB));

// Add missing tabs (and drop the empty default tab, now that others exist).
const structural: sheets_v4.Schema$Request[] = toAdd.map((title) => ({ addSheet: { properties: { title } } }));
if (removeDefault) structural.push({ deleteSheet: { sheetId: existing.get(DEFAULT_TAB)! } });
if (structural.length) {
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: structural } });
}

if (needHeader.length) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: needHeader.map((name) => ({
        range: `${tabRange(name)}!A1`,
        values: [[...schema.find((t) => t.name === name)!.columns]],
      })),
    },
  });
}

// Every schema tab: schema order, frozen bold header row.
const ids = await getTabIds(spreadsheetId);
await sheets.spreadsheets.batchUpdate({
  spreadsheetId,
  requestBody: {
    requests: schema.flatMap((tab, index) => {
      const sheetId = ids.get(tab.name)!;
      return [
        {
          updateSheetProperties: {
            properties: { sheetId, index, gridProperties: { frozenRowCount: 1 } },
            fields: 'index,gridProperties.frozenRowCount',
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: tab.columns.length },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
      ];
    }),
  },
});

for (const tab of schema) {
  const action = toAdd.includes(tab.name) ? 'added' : needHeader.includes(tab.name) ? 'header written' : 'ok';
  console.log(`${tab.name.padEnd(16)} ${action}`);
}
if (removeDefault) console.log(`${DEFAULT_TAB.padEnd(16)} removed (empty)`);
