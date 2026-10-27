// In season vs off-season (Spec: "Roster requests"). In season means today falls
// between the active season's start and end dates, both inclusive, in UTC.
import type { SheetRow } from './sheet-rows.js';

export interface Season {
  season: number;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

// Google Sheets day 0 is 1899-12-30.
const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 24 * 60 * 60 * 1000;

// A date cell as YYYY-MM-DD. Staff-typed dates read as serial numbers (see
// readTabs); dates written as text are expected as YYYY-MM-DD already.
export function sheetDate(value: string): string {
  if (/^\d+(\.\d+)?$/.test(value)) {
    return new Date(SHEETS_EPOCH + Math.floor(Number(value)) * DAY_MS).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new Error(`not a date: "${value}"`);
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);

// The Seasons row marked active, if any. More than one is a sheet mistake staff must fix.
export function activeSeason(rows: SheetRow<'seasons'>[]): Season | undefined {
  const active = rows.filter((r) => r.values.active.toLowerCase() === 'true');
  if (active.length > 1) {
    throw new Error(`Seasons has ${active.length} active rows (sheet rows ${active.map((r) => r.rowNumber).join(', ')})`);
  }
  if (!active.length) return undefined;
  const v = active[0].values;
  return { season: Number(v.season), start: sheetDate(v.start_date), end: sheetDate(v.end_date) };
}

// ISO dates compare correctly as strings.
export const isInSeason = (season: Season | undefined, today = todayUtc()) =>
  season !== undefined && season.start <= today && today <= season.end;
