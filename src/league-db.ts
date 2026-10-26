// Checks the League DB workbook (GOOGLE_LEAGUE_DB_ID) against src/schema.ts.
import { getSheets } from './google.js';
import { TABS, tabRange } from './schema.js';

export type TabStatus =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'empty' } // exists with nothing in it, not even a header
  | { kind: 'problem'; message: string };

export function getLeagueDbId(): string {
  const id = process.env.GOOGLE_LEAGUE_DB_ID;
  if (!id) throw new Error('GOOGLE_LEAGUE_DB_ID is not set');
  return id;
}

export async function getTabIds(spreadsheetId: string): Promise<Map<string, number>> {
  const res = await getSheets().spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  return new Map(res.data.sheets!.map((s) => [s.properties!.title!, s.properties!.sheetId!]));
}

export async function isTabEmpty(spreadsheetId: string, name: string): Promise<boolean> {
  const res = await getSheets().spreadsheets.values.get({ spreadsheetId, range: tabRange(name) });
  return !res.data.values?.length;
}

// Status of every schema tab, keyed by tab name, in schema order.
export async function checkTabs(spreadsheetId: string): Promise<Map<string, TabStatus>> {
  const schema = Object.values(TABS);
  const existing = await getTabIds(spreadsheetId);
  const present = schema.filter((t) => existing.has(t.name));
  const headers = present.length
    ? (
        await getSheets().spreadsheets.values.batchGet({
          spreadsheetId,
          ranges: present.map((t) => `${tabRange(t.name)}!1:1`),
        })
      ).data.valueRanges!
    : [];

  const result = new Map<string, TabStatus>();
  for (const tab of schema) {
    const i = present.indexOf(tab);
    if (i < 0) {
      result.set(tab.name, { kind: 'missing' });
      continue;
    }
    const header = (headers[i].values?.[0] ?? []).map((v) => String(v).trim());
    if (header.length === 0) {
      result.set(
        tab.name,
        (await isTabEmpty(spreadsheetId, tab.name))
          ? { kind: 'empty' }
          : { kind: 'problem', message: 'row 1 is blank but the tab has data' },
      );
    } else if (header.join('\t') !== tab.columns.join('\t')) {
      result.set(tab.name, {
        kind: 'problem',
        message: `header does not match\n    expected: ${tab.columns.join(', ')}\n    found:    ${header.join(', ')}`,
      });
    } else {
      result.set(tab.name, { kind: 'ok' });
    }
  }
  return result;
}

// Number of data rows (below the header) in each named tab.
export async function countRows(spreadsheetId: string, names: string[]): Promise<Map<string, number>> {
  const res = await getSheets().spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: names.map((n) => `${tabRange(n)}!A2:ZZ`),
  });
  return new Map(names.map((n, i) => [n, res.data.valueRanges![i].values?.length ?? 0]));
}
