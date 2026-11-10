// The nightly name sync as the bot runs it: the real Discord and League DB
// calls behind syncNames, on the schedule in runner.ts. Started from server.ts
// once startup has finished.
import { getState, setState } from '../bot-state.js';
import { listMembers } from '../discord.js';
import { alertStaff } from '../interactions.js';
import { postStaffAlert } from '../roster/requests.js';
import { readTabs, SheetLayoutError, updateColumns } from '../sheet-rows.js';
import { rebuildViews } from '../views.js';
import { syncNames, type NameSyncDeps } from './name-sync.js';
import { RETRY_DELAY_MS, startRunner, type Runner } from './runner.js';

export const LAST_RUN_KEY = 'nickname_sync_last_run';

// The sync's reads and writes against the live bot, for one guild.
export function liveNameSyncDeps(guildId: string): NameSyncDeps {
  return {
    listMembers: () => listMembers(guildId),
    readGymIds: async () => (await readTabs('gyms'))[0].map((g) => g.values.gym_id),
    readTrainers: async () => (await readTabs('trainers'))[0],
    writeNames: (rows) => updateColumns('trainers', ['server_nickname', 'username'], rows),
    rebuildViews,
    recordRun: (at) => setState(LAST_RUN_KEY, at.toISOString()),
    now: () => new Date(),
    log: (message) => console.error(`name sync: ${message}`),
  };
}

// Discord and Google errors can carry a response body, so keep the line short.
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

// For testing in a dev server only: NAME_SYNC_RETRY_DELAY_MS shortens the wait
// between attempts. Unset (as in production), it's the 10 minutes in runner.ts.
function retryDelayMs(): number {
  const raw = process.env.NAME_SYNC_RETRY_DELAY_MS;
  if (!raw) return RETRY_DELAY_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1000) throw new Error('NAME_SYNC_RETRY_DELAY_MS must be a whole number of ms, at least 1000');
  console.log(`name sync: retries ${ms / 1000}s apart (NAME_SYNC_RETRY_DELAY_MS)`);
  return ms;
}

export function startNameSync(guildId: string): Runner {
  const deps = liveNameSyncDeps(guildId);
  const delayMs = retryDelayMs();
  return startRunner({
    attempt: async () => {
      const result = await syncNames(deps);
      console.log(
        `name sync: ${result.changed} renamed; ${result.matched} of ${result.total} rostered Trainers have a server member`,
      );
      if (result.viewsError) {
        console.error('name sync: League Stats views not rebuilt:', result.viewsError);
        // The names are already written and recorded, so a failed alert must not fail the run.
        try {
          await postStaffAlert(
            guildId,
            `**Nickname sync:** names were updated, but the League Stats views were not rebuilt (${describe(result.viewsError)}). They show the old names until someone rebuilds them.`,
          );
        } catch (err) {
          console.error('name sync: the views alert did not post:', err);
        }
      }
    },
    getLastRun: () => getState(LAST_RUN_KEY),
    noRetry: (err) => err instanceof SheetLayoutError,
    // Staff get a general alert; the bot logs say which step failed and what was written.
    onFailure: async (err, attempts) => {
      if (err instanceof SheetLayoutError) {
        await alertStaff(guildId, err, "The nightly nickname sync can't finish until it's fixed. The bot logs have the details.");
        return;
      }
      await postStaffAlert(
        guildId,
        `**Nightly nickname sync failed** after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}: ${describe(err)}. ` +
          'The bot logs have the details. It tries again at 9 PM Denver tomorrow, or when the bot restarts.',
      );
    },
    now: () => new Date(),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return { clear: () => clearTimeout(t) };
    },
    log: (message) => console.error(`name sync: ${message}`),
  }, { retryDelayMs: delayMs });
}
