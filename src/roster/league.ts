// The League DB data a roster request is checked against, read in one request.
import { activeSeason, todayUtc, type Season } from '../seasons.js';
import { readTabs, type Row, type SheetRow } from '../sheet-rows.js';

export type Trainer = Row<'trainers'>;
export type Gym = Row<'gyms'>;

export interface League {
  trainers: SheetRow<'trainers'>[];
  gyms: SheetRow<'gyms'>[];
  requests: SheetRow<'rosterRequests'>[];
  history: SheetRow<'rosterHistory'>[];
  season: Season | undefined;
  today: string; // YYYY-MM-DD, UTC
}

export async function loadLeague(): Promise<League> {
  const [trainers, gyms, requests, history, seasons] = await readTabs(
    'trainers', 'gyms', 'rosterRequests', 'rosterHistory', 'seasons',
  );
  return { trainers, gyms, requests, history, season: activeSeason(seasons), today: todayUtc() };
}

export const findTrainer = (league: League, discordId: string) =>
  league.trainers.find((t) => t.values.discord_id === discordId)?.values;

export const findGym = (league: League, gymId: string) =>
  league.gyms.find((g) => g.values.gym_id === gymId)?.values;

export const gymName = (league: League, gymId: string) => findGym(league, gymId)?.name ?? gymId;

export const mention = (discordId: string) => `<@${discordId}>`;

export interface SeasonMoves {
  gyms: string[]; // gym_ids the trainer has been on since the start date, in order
  left: Map<string, string>; // gym_id -> date (YYYY-MM-DD) they last left it this season
}

// From Roster history: their gym at the start date, plus every gym joined or left
// since. Import rows count as their gym at the start whatever their timestamp,
// so the import never counts as the season's one switch (Spec: "Initial population").
export function seasonMoves(league: League, discordId: string, start: string): SeasonMoves {
  const rows = league.history
    .map((r) => r.values)
    .filter((r) => r.discord_id === discordId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let atStart = '';
  const joined: string[] = [];
  const left = new Map<string, string>();
  for (const r of rows) {
    const date = r.timestamp.slice(0, 10);
    if (r.source === 'import' || date < start) {
      atStart = r.after_gym_id;
      continue;
    }
    if (r.after_gym_id && r.after_gym_id !== r.before_gym_id) joined.push(r.after_gym_id);
    if (r.before_gym_id && r.before_gym_id !== r.after_gym_id) left.set(r.before_gym_id, date);
  }
  return { gyms: [...new Set([atStart, ...joined].filter(Boolean))], left };
}
