// Typed rows of League DB tabs. Cells come back as strings keyed by the
// column names in src/schema.ts; checkTabs() is what guarantees the headers match.
import { getSheets } from './google.js';
import { getLeagueDbId } from './league-db.js';
import { TABS, tabRange, type TabKey } from './schema.js';

export type Row<K extends TabKey> = Record<(typeof TABS)[K]['columns'][number], string>;

// A row as read, with its 1-based sheet row number for updating it later.
export interface SheetRow<K extends TabKey> {
  rowNumber: number;
  values: Row<K>;
}

type RowsOf<Keys extends readonly TabKey[]> = { [I in keyof Keys]: SheetRow<Keys[I]>[] };

// Every tab here has at most 26 columns.
const lastColumn = (key: TabKey) => String.fromCharCode(64 + TABS[key].columns.length);

function toRow<K extends TabKey>(key: K, cells: unknown[]): Row<K> {
  const row: Record<string, string> = {};
  TABS[key].columns.forEach((col, i) => {
    row[col] = cells[i] === undefined || cells[i] === null ? '' : String(cells[i]).trim();
  });
  return row as Row<K>;
}

// Reads several tabs in one request. Blank rows are skipped but keep their numbering.
export async function readTabs<const Keys extends readonly TabKey[]>(...keys: Keys): Promise<RowsOf<Keys>> {
  const res = await getSheets().spreadsheets.values.batchGet({
    spreadsheetId: getLeagueDbId(),
    ranges: keys.map((k) => `${tabRange(TABS[k].name)}!A2:${lastColumn(k)}`),
    // Unformatted, so a number or date reads the same whatever the sheet's display
    // format. Dates come back as serial numbers; see sheetDate() in seasons.ts.
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  return keys.map((key, t) =>
    (res.data.valueRanges![t].values ?? [])
      .map((cells, i) => ({ rowNumber: i + 2, values: toRow(key, cells) }))
      .filter((r) => Object.values(r.values).some((v) => v !== '')),
  ) as RowsOf<Keys>;
}

const toCells = <K extends TabKey>(key: K, row: Row<K>) =>
  TABS[key].columns.map((col) => row[col as keyof Row<K>]);

// RAW keeps Discord IDs as text; parsed, they'd become numbers and lose digits.
export async function appendRows<K extends TabKey>(key: K, rows: Row<K>[]): Promise<void> {
  if (!rows.length) return;
  await getSheets().spreadsheets.values.append({
    spreadsheetId: getLeagueDbId(),
    range: `${tabRange(TABS[key].name)}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows.map((r) => toCells(key, r)) },
  });
}

export async function updateRows<K extends TabKey>(key: K, rows: SheetRow<K>[]): Promise<void> {
  if (!rows.length) return;
  await getSheets().spreadsheets.values.batchUpdate({
    spreadsheetId: getLeagueDbId(),
    requestBody: {
      valueInputOption: 'RAW',
      data: rows.map((r) => ({
        range: `${tabRange(TABS[key].name)}!A${r.rowNumber}`,
        values: [toCells(key, r.values)],
      })),
    },
  });
}
