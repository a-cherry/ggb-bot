// Typed rows of League DB tabs. Cells come back as strings keyed by the
// column names in src/schema.ts. Reads and writes go by column position, so
// every read checks the tab's header row first.
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

// A tab's header row isn't the schema's: a column was inserted, moved or
// renamed in the sheet. The message is for staff; `userMessage` is for whoever
// ran the command.
export class SheetLayoutError extends Error {
  readonly userMessage = "The bot can't read the League DB right now, so nothing was changed. Staff have been told.";
  constructor(readonly tab: string, expected: readonly string[], found: string[]) {
    super(
      `The League DB's ${tab} tab doesn't have the columns the bot expects, so the bot can't safely read or write it. ` +
        `Put row 1 back to ${expected.join(', ')} (found ${found.join(', ') || 'nothing'}).`,
    );
  }
}

// Reads several tabs in one request. Blank rows are skipped but keep their numbering.
// Throws SheetLayoutError if a tab's header row doesn't match the schema;
// columns staff add after the schema's are ignored.
export async function readTabs<const Keys extends readonly TabKey[]>(...keys: Keys): Promise<RowsOf<Keys>> {
  const res = await getSheets().spreadsheets.values.batchGet({
    spreadsheetId: getLeagueDbId(),
    ranges: keys.map((k) => `${tabRange(TABS[k].name)}!A1:${lastColumn(k)}`),
    // Unformatted, so a number or date reads the same whatever the sheet's display
    // format. Dates come back as serial numbers; see sheetDate() in seasons.ts.
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  return keys.map((key, t) => {
    const [header = [], ...rows] = res.data.valueRanges![t].values ?? [];
    const found = header.map((v) => String(v).trim());
    const { name, columns } = TABS[key];
    if (found.length !== columns.length || columns.some((c, i) => found[i] !== c)) {
      throw new SheetLayoutError(name, columns, found);
    }
    return rows
      .map((cells, i) => ({ rowNumber: i + 2, values: toRow(key, cells) }))
      .filter((r) => Object.values(r.values).some((v) => v !== ''));
  }) as RowsOf<Keys>;
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
