// One run of the nightly sync (Bot Spec: "Nickname sync"): refreshes names, and
// takes rostered Trainers who left the server off their gyms. Everything that
// touches Discord or the League DB comes in through `deps`, so the guards can be
// tested without either; src/jobs/name-sync-job.ts supplies the real ones.
// Runs never overlap: the runner (runner.ts) starts one only after the last ends.
import type { Member } from '../discord.js';
import type { Row } from '../sheet-rows.js';
import { withAllGymLocks } from './gym-locks.js';
import {
  belowFloor, diffNames, MAX_DEPARTURES, MIN_MATCH_RATE, type Departure, type TrainerRow,
} from './name-diff.js';

// The run stopped on purpose; `message` says why, for staff.
export class NameSyncAbort extends Error {}

export interface SyncContext {
  gyms: { gym_id: string; name: string }[];
  // The active season's number, or '' off-season, for Roster history.
  season: string;
}

export interface NameSyncDeps {
  listMembers(): Promise<Member[]>;
  readContext(): Promise<SyncContext>;
  // A fresh read of the Trainers tab, with its header check.
  readTrainers(): Promise<TrainerRow[]>;
  appendHistory(rows: Row<'rosterHistory'>[]): Promise<void>;
  // Writes only gym_id, role, leadership and status of these rows, in one batch.
  writeMembership(rows: TrainerRow[]): Promise<void>;
  // Writes only server_nickname and username of these rows, in one batch.
  writeNames(rows: TrainerRow[]): Promise<void>;
  rebuildViews(): Promise<void>;
  // Records the run's time as nickname_sync_last_run.
  recordRun(at: Date): Promise<void>;
  now(): Date;
  log(message: string): void;
}

// A gym whose leader left the server, so it has none until staff appoint one.
export interface LostLeader {
  gymName: string;
  name: string;
  discordId: string;
}

export interface NameSyncResult {
  changed: number;
  departed: number;
  matched: number;
  total: number;
  lostLeaders: LostLeader[];
  // Set when the League DB was written but the views rebuild failed.
  viewsError?: unknown;
}

// The most departures an abort message names; the log has them all.
const NAMED = 10;

export async function syncNames(deps: NameSyncDeps): Promise<NameSyncResult> {
  // Outside every gym lock, so Discord paging and rate limits never hold up an
  // approval. listMembers throws if any page fails, so a partial list can't get here.
  const members = await deps.listMembers();
  if (!members.length) throw new NameSyncAbort('Discord returned an empty member list');

  const { gyms, season } = await deps.readContext();
  const gymName = (id: string) => gyms.find((g) => g.gym_id === id)?.name ?? id;
  const who = (d: Departure) => `${d.before.server_nickname || d.before.username} (${d.before.discord_id}) of ${gymName(d.before.gym_id)}`;

  const diff = await withAllGymLocks(gyms.map((g) => g.gym_id), async () => {
    const result = diffNames(members, await deps.readTrainers());
    if (belowFloor(result)) {
      throw new NameSyncAbort(
        `only ${result.matched} of ${result.total} rostered Trainers have a matching server member ` +
          `(the floor is ${Math.round(MIN_MATCH_RATE * 100)}%), so the member list looks wrong`,
      );
    }
    const { departures } = result;
    if (departures.length > MAX_DEPARTURES) {
      for (const d of departures) deps.log(`would have taken ${who(d)} off their gym; not done, too many at once`);
      const named = departures.slice(0, NAMED).map(who).join(', ');
      const more = departures.length > NAMED ? `, and ${departures.length - NAMED} more` : '';
      throw new NameSyncAbort(
        `${departures.length} rostered Trainers are no longer in the server, more than the ${MAX_DEPARTURES} ` +
          `one run takes off their gyms, so nothing was changed: ${named}${more}. ` +
          'Remove the ones who really left, by hand or with /roster remove, and the next run goes ahead',
      );
    }

    if (departures.length) {
      // History first, as an approval writes it, so a stop between the two still leaves a record.
      const timestamp = deps.now().toISOString();
      await deps.appendHistory(departures.map((d) => historyRow(d, season, timestamp)));
      await deps.writeMembership(departures.map((d) => ({ rowNumber: d.rowNumber, values: d.after })));
      for (const d of departures) {
        const lead = d.before.leadership === 'none' ? '' : `, was ${d.before.leadership}`;
        deps.log(`${who(d)} left the server: taken off the gym${lead}, status now ${d.after.status}`);
      }
    }
    if (result.changes.length) await deps.writeNames(result.changes);
    return result;
  });

  const lostLeaders = diff.departures
    .filter((d) => d.before.leadership === 'leader')
    .map((d) => ({
      gymName: gymName(d.before.gym_id),
      name: d.before.server_nickname || d.before.username,
      discordId: d.before.discord_id,
    }));

  // Everything is written by now. A failed rebuild is reported by the caller, and the
  // run is still recorded, since running the sync again would find nothing to change.
  let viewsError: unknown;
  if (diff.changes.length || diff.departures.length) {
    try {
      await deps.rebuildViews();
    } catch (err) {
      viewsError = err;
    }
  }

  try {
    await deps.recordRun(deps.now());
  } catch (err) {
    // The error alone reads like nothing happened; say what did.
    deps.log(
      `${diff.changes.length} Trainers rows were renamed and ${diff.departures.length} taken off their gyms, ` +
        'but recording the run failed, so the attempt counts as failed and a retry will find nothing left to change',
    );
    throw err;
  }
  return {
    changed: diff.changes.length,
    departed: diff.departures.length,
    matched: diff.matched,
    total: diff.total,
    lostLeaders,
    viewsError,
  };
}

// As a remove's history row (src/roster/approval.ts), with no request behind it.
const historyRow = (d: Departure, season: string, timestamp: string): Row<'rosterHistory'> => ({
  season,
  timestamp,
  discord_id: d.before.discord_id,
  before_gym_id: d.before.gym_id,
  before_role: d.before.role,
  before_leadership: d.before.leadership,
  after_gym_id: d.after.gym_id,
  after_role: d.after.role,
  after_leadership: d.after.leadership,
  source: 'sync',
  request_id: '',
});
