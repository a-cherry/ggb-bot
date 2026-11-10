// One run of the nightly name sync (Bot Spec: "Nickname sync"). Everything that
// touches Discord or the League DB comes in through `deps`, so the guards can be
// tested without either; src/jobs/name-sync-job.ts supplies the real ones.
// Runs never overlap: the runner (runner.ts) starts one only after the last ends.
import type { Member } from '../discord.js';
import { withAllGymLocks } from './gym-locks.js';
import { belowFloor, diffNames, MIN_MATCH_RATE, type TrainerRow } from './name-diff.js';

// The run stopped on purpose; `message` says why, for staff.
export class NameSyncAbort extends Error {}

export interface NameSyncDeps {
  listMembers(): Promise<Member[]>;
  readGymIds(): Promise<string[]>;
  // A fresh read of the Trainers tab, with its header check.
  readTrainers(): Promise<TrainerRow[]>;
  // Writes only server_nickname and username of these rows, in one batch.
  writeNames(rows: TrainerRow[]): Promise<void>;
  rebuildViews(): Promise<void>;
  // Records the run's time as nickname_sync_last_run.
  recordRun(at: Date): Promise<void>;
  now(): Date;
  log(message: string): void;
}

export interface NameSyncResult {
  changed: number;
  matched: number;
  total: number;
  // Set when the names were written but the views rebuild failed.
  viewsError?: unknown;
}

export async function syncNames(deps: NameSyncDeps): Promise<NameSyncResult> {
  // Outside every gym lock, so Discord paging and rate limits never hold up an
  // approval. listMembers throws if any page fails, so a partial list can't get here.
  const members = await deps.listMembers();
  if (!members.length) throw new NameSyncAbort('Discord returned an empty member list');

  const gymIds = await deps.readGymIds();
  const diff = await withAllGymLocks(gymIds, async () => {
    const result = diffNames(members, await deps.readTrainers());
    if (belowFloor(result)) {
      throw new NameSyncAbort(
        `only ${result.matched} of ${result.total} rostered Trainers have a matching server member ` +
          `(the floor is ${Math.round(MIN_MATCH_RATE * 100)}%), so the member list looks wrong`,
      );
    }
    if (result.changes.length) await deps.writeNames(result.changes);
    return result;
  });

  // The names are written by now. A failed rebuild is reported by the caller, and the
  // run is still recorded, since running the sync again would find nothing to change.
  let viewsError: unknown;
  if (diff.changes.length) {
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
      `${diff.changes.length} Trainers rows were renamed, but recording the run failed, ` +
        'so the attempt counts as failed and a retry will find nothing left to rename',
    );
    throw err;
  }
  return { changed: diff.changes.length, matched: diff.matched, total: diff.total, viewsError };
}
