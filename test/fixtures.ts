// Loads the captured fixtures (see scripts/capture-match-fixtures.ts).
// Each call returns a fresh copy, so a test can mutate it freely.
import { readFileSync } from 'node:fs';
import type { MatchCells } from '../src/match/parse.js';
import type { SheetRow } from '../src/sheet-rows.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));

export interface MatchFixture {
  tab: string;
  ranges: MatchCells;
}

export interface LeagueFixture {
  gyms: SheetRow<'gyms'>[];
  trainers: SheetRow<'trainers'>[];
  seasons: SheetRow<'seasons'>[];
  matches: SheetRow<'matches'>[];
  decks: SheetRow<'decks'>[];
}

export const exampleMatch = (): MatchFixture => read('example-match.json');
export const league = (): LeagueFixture => read('league.json');

