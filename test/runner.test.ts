import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startRunner, type RunnerDeps } from '../src/jobs/runner.js';

// Lets chains of awaited promises run to their next real wait.
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const TO_SLOT_MS = 33 * 60_000; // 20:27 to 21:00 Denver
const NOW = new Date('2026-11-10T03:27:00Z'); // 2026-11-09 20:27 Denver; the last slot was 2026-11-09T04:00Z

interface Options {
  lastRun?: string | Error;
  attempt?: (n: number) => Promise<void> | void;
  noRetry?: (err: unknown) => boolean;
  onFailure?: (err: unknown, attempts: number) => Promise<void>;
}

// A runner on a fake clock whose timers only fire when the test says so.
function harness(options: Options = {}) {
  interface FakeTimer {
    fn: () => void;
    ms: number;
    cleared: boolean;
    fired: boolean;
  }
  const timers: FakeTimer[] = [];
  const failures: [unknown, number][] = [];
  const logs: string[] = [];
  let attempts = 0;
  let now = NOW;

  const deps: RunnerDeps = {
    attempt: async () => {
      attempts++;
      await options.attempt?.(attempts);
    },
    getLastRun: async () => {
      if (options.lastRun instanceof Error) throw options.lastRun;
      return options.lastRun;
    },
    onFailure: async (err, n) => {
      failures.push([err, n]);
      await options.onFailure?.(err, n);
    },
    noRetry: (err) => options.noRetry?.(err) ?? false,
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer: FakeTimer = { fn, ms, cleared: false, fired: false };
      timers.push(timer);
      return { clear: () => void (timer.cleared = true) };
    },
    log: (message) => void logs.push(message),
  };

  // Fires the oldest timer that is still waiting.
  const fireNext = async () => {
    const timer = timers.find((t) => !t.fired && !t.cleared);
    assert.ok(timer, 'a timer should be waiting');
    timer.fired = true;
    timer.fn();
    await settle();
  };

  return {
    deps,
    timers,
    failures,
    logs,
    attempts: () => attempts,
    waiting: () => timers.filter((t) => !t.fired && !t.cleared).map((t) => t.ms),
    setNow: (date: Date) => void (now = date),
    fireNext,
  };
}

test('with no run recorded it runs at boot, then waits for the next 21:00', async () => {
  const h = harness();
  startRunner(h.deps);
  await settle();
  assert.equal(h.attempts(), 1);
  assert.deepEqual(h.waiting(), [TO_SLOT_MS]);
});

test('with a run recorded since the last slot it does not run at boot, and still arms the timer', async () => {
  const h = harness({ lastRun: '2026-11-09T04:01:00.000Z' });
  startRunner(h.deps);
  await settle();
  assert.equal(h.attempts(), 0);
  assert.deepEqual(h.waiting(), [TO_SLOT_MS]);
});

test('a run recorded before the last slot is caught up at boot', async () => {
  const h = harness({ lastRun: '2026-11-08T04:00:30.000Z' });
  startRunner(h.deps);
  await settle();
  assert.equal(h.attempts(), 1);
});

test('when the timer fires the job runs and the next night is armed', async () => {
  const h = harness({ lastRun: '2026-11-09T04:01:00.000Z' });
  startRunner(h.deps);
  await settle();
  h.setNow(new Date('2026-11-10T04:00:05Z')); // five seconds after the slot
  await h.fireNext();
  assert.equal(h.attempts(), 1);
  assert.deepEqual(h.waiting(), [24 * 3_600_000 - 5000]);
});

test('an unreadable last run is treated as due', async () => {
  const h = harness({ lastRun: new Error('Sheets 503') });
  startRunner(h.deps);
  await settle();
  assert.equal(h.attempts(), 1);
  assert.ok(h.logs.some((l) => /could not read the last run/.test(l)));
});

test('two failures then a success: retried 10 minutes apart, no alert', async () => {
  const h = harness({
    attempt: (n) => {
      if (n < 3) throw new Error(`failure ${n}`);
    },
  });
  startRunner(h.deps);
  await settle();
  assert.deepEqual(h.waiting(), [600_000]);
  await h.fireNext();
  assert.deepEqual(h.waiting(), [600_000]);
  await h.fireNext();
  assert.equal(h.attempts(), 3);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.waiting(), [TO_SLOT_MS]);
});

test('three failures give one alert after the third, then the next night is armed', async () => {
  const boom = new Error('Discord 500');
  const h = harness({
    attempt: () => {
      throw boom;
    },
  });
  startRunner(h.deps);
  await settle();
  await h.fireNext();
  assert.deepEqual(h.failures, []);
  await h.fireNext();
  assert.equal(h.attempts(), 3);
  assert.deepEqual(h.failures, [[boom, 3]]);
  assert.deepEqual(h.waiting(), [TO_SLOT_MS]);
});

test('an error a retry cannot fix alerts at once, with no retry', async () => {
  const layout = new Error('header does not match');
  const h = harness({
    attempt: () => {
      throw layout;
    },
    noRetry: (err) => err === layout,
  });
  startRunner(h.deps);
  await settle();
  assert.equal(h.attempts(), 1);
  assert.deepEqual(h.failures, [[layout, 1]]);
  assert.deepEqual(h.waiting(), [TO_SLOT_MS]); // no retry timer, only the next night
});

test('a failed alert is logged and does not stop the schedule', async () => {
  const h = harness({
    attempt: () => {
      throw new Error('nope');
    },
    noRetry: () => true,
    onFailure: async () => Promise.reject(new Error('Discord down')),
  });
  startRunner(h.deps);
  await settle();
  assert.ok(h.logs.some((l) => /could not report the failure: Discord down/.test(l)));
  assert.deepEqual(h.waiting(), [TO_SLOT_MS]);
});

test('stopping during a retry wait ends the run quietly: no more attempts, no alert, no timer left', async () => {
  const h = harness({
    attempt: () => {
      throw new Error('failing');
    },
  });
  const runner = startRunner(h.deps);
  await settle();
  assert.deepEqual(h.waiting(), [600_000]);
  await runner.stop();
  assert.equal(h.attempts(), 1);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.waiting(), []);
});

test('stopping clears the timer for the next night', async () => {
  const h = harness({ lastRun: '2026-11-09T04:01:00.000Z' });
  const runner = startRunner(h.deps);
  await settle();
  await runner.stop();
  assert.deepEqual(h.waiting(), []);
});

test('stopping waits for a run in progress to finish', async () => {
  let finish!: () => void;
  const h = harness({ attempt: () => new Promise<void>((resolve) => (finish = resolve)) });
  const runner = startRunner(h.deps);
  await settle();
  let stopped = false;
  const stopping = runner.stop().then(() => (stopped = true));
  await settle();
  assert.equal(stopped, false);
  finish();
  await stopping;
  assert.equal(stopped, true);
  assert.deepEqual(h.waiting(), []); // nothing is armed after a stop
});

test('stopping during an attempt that then fails ends at once, with no retry armed', async () => {
  let fail!: (err: Error) => void;
  const h = harness({ attempt: () => new Promise<void>((_, reject) => (fail = reject)) });
  const runner = startRunner(h.deps);
  await settle();
  let stopped = false;
  const stopping = runner.stop().then(() => (stopped = true));
  fail(new Error('Discord 500'));
  await settle();
  assert.equal(stopped, true);
  await stopping;
  assert.equal(h.attempts(), 1);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.waiting(), []);
});

test('a timer that fires just before its slot does not run that slot twice', async () => {
  const h = harness({ lastRun: '2026-11-09T04:01:00.000Z' });
  startRunner(h.deps);
  await settle();
  // Fires, and the run ends, 50 ms before 21:00 Denver.
  h.setNow(new Date('2026-11-10T03:59:59.950Z'));
  await h.fireNext();
  assert.equal(h.attempts(), 1);
  assert.deepEqual(h.waiting(), [24 * 3_600_000 + 50]); // tomorrow's 21:00, not tonight's
});
