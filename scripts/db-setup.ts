// Builds every League DB tab in an existing workbook (GOOGLE_LEAGUE_DB_ID).
// Safe to re-run: a tab with the right header is left alone, a missing tab is
// added, and any header mismatch stops the run before anything is written.
import dotenv from 'dotenv';
dotenv.config();
import type { sheets_v4 } from 'googleapis';
import { getSheets } from '../src/google.js';
import { TABS, tabRange } from '../src/schema.js';

const spreadsheetId = process.env.GOOGLE_LEAGUE_DB_ID;
if (!spreadsheetId) throw new Error('GOOGLE_LEAGUE_DB_ID is not set');

// The tab a new Google Sheets workbook starts with. Removed when empty.
const DEFAULT_TAB = 'Sheet1';

const sheets = getSheets();
const schema = Object.values(TABS);

async function getTabIds() {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  return new Map(res.data.sheets!.map((s) => [s.properties!.title!, s.properties!.sheetId!]));
}

async function isEmpty(name: string) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: tabRange(name) });
  return !res.data.values?.length;
}

const existing = await getTabIds();

// Plan: check every existing schema tab's header before writing anything.
const toAdd: string[] = [];
const needHeader: string[] = [];
const problems: string[] = [];

const present = schema.filter((t) => existing.has(t.name));
const headerRes = present.length
  ? await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: present.map((t) => `${tabRange(t.name)}!1:1`),
    })
  : undefined;

for (const tab of schema) {
  if (!existing.has(tab.name)) {
    toAdd.push(tab.name);
    needHeader.push(tab.name);
    continue;
  }
  const i = present.indexOf(tab);
  const header = (headerRes!.data.valueRanges![i].values?.[0] ?? []).map((v) => String(v).trim());
  if (header.length === 0) {
    if (await isEmpty(tab.name)) needHeader.push(tab.name);
    else problems.push(`${tab.name}: row 1 is blank but the tab has data`);
  } else if (header.join('\t') !== tab.columns.join('\t')) {
    problems.push(
      `${tab.name}: header does not match\n    expected: ${tab.columns.join(', ')}\n    found:    ${header.join(', ')}`,
    );
  }
}

if (problems.length) {
  console.error('Nothing was written. Fix these tabs and re-run:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const removeDefault = existing.has(DEFAULT_TAB) && (await isEmpty(DEFAULT_TAB));

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
const ids = await getTabIds();
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
