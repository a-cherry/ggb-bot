// The nightly nickname sync as the bot runs it: the real Discord and League DB
// calls behind syncNames, on the schedule in runner.ts. Started from server.ts
// once startup has finished.
import { getState, setState } from '../bot-state.js';
import { listMembers } from '../discord.js';
import { alertStaff } from '../interactions.js';
import { postStaffAlert } from '../roster/requests.js';
import { activeSeason } from '../seasons.js';
import { appendRows, readTabs, SheetLayoutError, updateColumns } from '../sheet-rows.js';
import { rebuildViews } from '../views.js';
import { NameSyncAbort, syncNames, type LostLeader, type NameSyncDeps } from './name-sync.js';
import { RETRY_DELAY_MS, startRunner, type Runner } from './runner.js';

export const LAST_RUN_KEY = 'nickname_sync_last_run';

// The sync's reads and writes against the live bot, for one guild.
export function liveNameSyncDeps(guildId: string): NameSyncDeps {
  return {
    listMembers: () => listMembers(guildId),
    readContext: async () => {
      const [gyms, seasons] = await readTabs('gyms', 'seasons');
      const season = activeSeason(seasons);
      return {
        gyms: gyms.map((g) => ({ gym_id: g.values.gym_id, name: g.values.name })),
        season: season ? String(season.season) : '',
      };
    },
    readTrainers: async () => (await readTabs('trainers'))[0],
    appendHistory: (rows) => appendRows('rosterHistory', rows),
    writeMembership: (rows) => updateColumns('trainers', ['gym_id', 'role', 'leadership', 'status'], rows),
    writeNames: (rows) => updateColumns('trainers', ['server_nickname', 'username'], rows),
    rebuildViews,
    recordRun: (at) => setState(LAST_RUN_KEY, at.toISOString()),
    now: () => new Date(),
    log: (message) => console.error(`name sync: ${message}`),
  };
}

// Discord and Google errors can carry a response body, so keep the line short.
// The sync's own aborts are written for staff and kept whole.
const describe = (err: unknown) =>
  err instanceof NameSyncAbort ? err.message : (err instanceof Error ? err.message : String(err)).slice(0, 500);

const lostLeaderAlert = (lost: LostLeader[]) =>
  lost
    .map((l) => `**Nickname sync:** ${l.name} (${l.discordId}), ${l.gymName}'s leader, left the server and was taken off the roster. ` +
      `${l.gymName} has no leader until staff appoint one.`)
    .join('\n');

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
        `name sync: ${result.changed} renamed; ${result.departed} rostered Trainers left the server and were taken off their gyms; ` +
          `${result.matched} of ${result.total} rostered Trainers have a server member`,
      );
      if (result.lostLeaders.length) {
        // Written and recorded already, so a failed alert must not fail the run.
        try {
          await postStaffAlert(guildId, lostLeaderAlert(result.lostLeaders));
        } catch (err) {
          console.error('name sync: the lost-leader alert did not post:', err);
        }
      }
      if (result.viewsError) {
        console.error('name sync: League Stats views not rebuilt:', result.viewsError);
        // The names are already written and recorded, so a failed alert must not fail the run.
        try {
          await postStaffAlert(
            guildId,
            `**Nickname sync:** the League DB was updated, but the League Stats views were not rebuilt (${describe(result.viewsError)}). They show the old names and rosters until someone rebuilds them.`,
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
