// Runs a job at each nightly slot, with a catch-up at boot and retries. Knows
// nothing about Discord or Sheets: the job, the clock and the timers come in
// through `deps`, so the retry and catch-up rules can be tested. One timer chain
// (not an interval), so a long run can't stack up behind the next one.
import { isCatchUpDue, nextSlot } from './slots.js';

// Three attempts, 10 minutes apart, and a staff alert only after the last fails.
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 10 * 60_000;

export interface Timer {
  clear(): void;
}

export interface RunnerDeps {
  // One try. Throws when it fails.
  attempt(): Promise<void>;
  // When the last verified run finished, as the job recorded it.
  getLastRun(): Promise<string | undefined>;
  // Called once when a run is given up on: after the last attempt, or at once for
  // an error `noRetry` accepts. Not called when the runner is stopped mid-retry.
  onFailure(err: unknown, attempts: number): Promise<void>;
  // Errors a retry can't fix, e.g. a sheet header a person has to repair.
  noRetry(err: unknown): boolean;
  now(): Date;
  setTimeout(fn: () => void, ms: number): Timer;
  log(message: string): void;
}

export interface Runner {
  // Stops scheduling, wakes a retry that is waiting, and resolves once a run in
  // progress has finished.
  stop(): Promise<void>;
}

export function startRunner(
  deps: RunnerDeps,
  { maxAttempts = MAX_ATTEMPTS, retryDelayMs = RETRY_DELAY_MS } = {},
): Runner {
  let stopped = false;
  let timer: Timer | undefined;
  let wake: (() => void) | undefined;
  let current: Promise<void> = Promise.resolve();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = deps.setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = () => {
        t.clear();
        wake = undefined;
        resolve();
      };
    });

  const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function runWithRetries(): Promise<void> {
    for (let n = 1; ; n++) {
      try {
        await deps.attempt();
        return;
      } catch (err) {
        deps.log(`attempt ${n} of ${maxAttempts} failed: ${describe(err)}`);
        if (n >= maxAttempts || deps.noRetry(err)) {
          try {
            await deps.onFailure(err, n);
          } catch (alertErr) {
            deps.log(`could not report the failure: ${describe(alertErr)}`);
          }
          return;
        }
        // Stopped while this attempt ran: no retry, so stop() isn't left waiting on one.
        if (stopped) return;
        await sleep(retryDelayMs);
        if (stopped) return;
      }
    }
  }

  const runOnce = () => (current = runWithRetries());

  // The slot the timer was last armed for. The next one is armed from it, not
  // from the clock, so a timer that fires a moment before its slot (and a run
  // that ends before the slot) can't arm the same slot a second time.
  let armedFor: Date | undefined;

  const arm = () => {
    if (stopped) return;
    const now = deps.now();
    const target = nextSlot(armedFor && armedFor > now ? armedFor : now);
    armedFor = target;
    timer = deps.setTimeout(() => void runOnce().then(arm), target.getTime() - now.getTime());
  };

  // At boot: run now if a slot has passed since the last verified run, then wait
  // for the next slot. The wait starts after the catch-up, so they can't overlap.
  void (async () => {
    try {
      let due = true;
      try {
        due = isCatchUpDue(await deps.getLastRun(), deps.now());
      } catch (err) {
        // Can't tell, and a run with nothing to change is harmless, so run.
        deps.log(`could not read the last run (${describe(err)}); running now`);
      }
      if (due && !stopped) await runOnce();
    } finally {
      arm();
    }
  })();

  return {
    async stop() {
      stopped = true;
      timer?.clear();
      wake?.();
      await current;
    },
  };
}
