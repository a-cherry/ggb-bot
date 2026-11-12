// Which Trainers rows need a new name. Pure: no I/O, so tests import it directly.
// Bot Spec: "Nickname sync".
import { displayName, type Member } from '../discord.js';
import type { Row, SheetRow } from '../sheet-rows.js';

export type TrainerRow = SheetRow<'trainers'>;
type Trainer = Row<'trainers'>;

// A run aborts, writing and recording nothing, when fewer than this share of the
// rostered Trainers have a matching server member. Almost every rostered Trainer
// should still be in the server, so a low share means the member list is bad.
export const MIN_MATCH_RATE = 0.9;

// A run aborts, writing and recording nothing, when more rostered Trainers than
// this have left the server since the last run: a real exit that large is rare
// enough for staff to look at first.
export const MAX_DEPARTURES = 5;

// A rostered Trainer who is no longer in the server: taken off their gym as a
// remove would, and marked inactive. Suspended and banned keep their status,
// since a ban from Discord also takes someone out of the member list.
export interface Departure {
  rowNumber: number;
  before: Trainer;
  after: Trainer;
}

export interface NameDiff {
  // Rows with their new names. Only rows that changed; only the two name
  // columns differ from the row as read.
  changes: TrainerRow[];
  // Rostered Trainers rows whose discord_id is not in the member list.
  departures: Departure[];
  // Rostered Trainers rows (a discord_id and a gym_id) whose discord_id is in the member list.
  matched: number;
  // Rostered Trainers rows. The floor is checked over these only: a removed
  // Trainer keeps their row with no gym_id, and many of them leave the server
  // over the seasons. Server members who are not Trainers never enter this.
  total: number;
}

// Walks the Trainers rows and looks each up by discord_id, so the count of
// server members doesn't matter. Every matched row is renamed, rostered or not.
// A rostered Trainer who left the server is a departure; a Trainer with no gym
// who left is left untouched, since they were on no roster. A name that comes back empty
// is skipped, so an empty name is never written over a stored one. Names are
// trimmed because a read trims the sheet's cells; an untrimmed name would look
// changed every night.
export function diffNames(members: Member[], rows: TrainerRow[]): NameDiff {
  const byId = new Map(members.map((m) => [m.user.id, m]));
  const changes: TrainerRow[] = [];
  const departures: Departure[] = [];
  let matched = 0;
  let total = 0;

  for (const row of rows) {
    const id = row.values.discord_id;
    if (!id) continue;
    const rostered = row.values.gym_id !== '';
    if (rostered) total++;
    const member = byId.get(id);
    if (!member) {
      if (rostered) departures.push({ rowNumber: row.rowNumber, before: row.values, after: departed(row.values) });
      continue;
    }
    if (rostered) matched++;

    const name = displayName(member).trim();
    const username = member.user.username.trim();
    const next = {
      server_nickname: name || row.values.server_nickname,
      username: username || row.values.username,
    };
    if (next.server_nickname === row.values.server_nickname && next.username === row.values.username) continue;
    changes.push({ rowNumber: row.rowNumber, values: { ...row.values, ...next } });
  }
  return { changes, departures, matched, total };
}

const KEEP_STATUS = new Set(['suspended', 'banned']);

const departed = (t: Trainer): Trainer => ({
  ...t,
  gym_id: '',
  role: 'trainer',
  leadership: 'none',
  status: KEEP_STATUS.has(t.status) ? t.status : 'inactive',
});

// Whether the member list looks wrong: under the floor. With no rostered
// Trainers there is nothing to measure, so it never trips.
export const belowFloor = ({ matched, total }: Pick<NameDiff, 'matched' | 'total'>) =>
  total > 0 && matched / total < MIN_MATCH_RATE;
