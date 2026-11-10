import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gymLockKeys, withAllGymLocks } from '../src/jobs/gym-locks.js';
import { withLock } from '../src/locks.js';

// Lets queued promise callbacks run.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('gymLockKeys sorts, drops duplicates and blanks', () => {
  assert.deepEqual(gymLockKeys(['G010', '', 'G002', 'G010', 'G001']), ['gym:G001', 'gym:G002', 'gym:G010']);
  assert.deepEqual(gymLockKeys([]), []);
});

test('an approval on one gym waits until the sync is done', { timeout: 5000 }, async () => {
  const events: string[] = [];
  let finishSync!: () => void;
  const sync = withAllGymLocks(['LA-1', 'LA-2', 'LA-3'], async () => {
    events.push('sync holds every gym');
    await new Promise<void>((resolve) => (finishSync = resolve));
    events.push('sync done');
  });
  await settle();
  const approval = withLock('gym:LA-2', async () => void events.push('approval runs'));
  await settle();
  assert.deepEqual(events, ['sync holds every gym']);
  finishSync();
  await Promise.all([sync, approval]);
  assert.deepEqual(events, ['sync holds every gym', 'sync done', 'approval runs']);
});

test('the sync waits for an approval already running on a gym', { timeout: 5000 }, async () => {
  const events: string[] = [];
  let finishApproval!: () => void;
  const approval = withLock('gym:LB-2', async () => {
    events.push('approval starts');
    await new Promise<void>((resolve) => (finishApproval = resolve));
    events.push('approval done');
  });
  await settle();
  const sync = withAllGymLocks(['LB-1', 'LB-2'], async () => void events.push('sync runs'));
  await settle();
  assert.deepEqual(events, ['approval starts']);
  finishApproval();
  await Promise.all([approval, sync]);
  assert.deepEqual(events, ['approval starts', 'approval done', 'sync runs']);
});

test('a rebrand approval (gym key, then rebrand) and the sync do not deadlock', { timeout: 5000 }, async () => {
  const events: string[] = [];
  const rebrand = withLock('gym:LC-2', () =>
    withLock('rebrand', async () => {
      await settle();
      events.push('rebrand done');
    }),
  );
  const sync = withAllGymLocks(['LC-1', 'LC-2', 'LC-3'], async () => void events.push('sync done'));
  // A second rebrand on another gym, queued behind the first on the shared key.
  const other = withLock('gym:LC-3', () => withLock('rebrand', async () => void events.push('other rebrand done')));
  await Promise.all([rebrand, sync, other]);
  assert.equal(events.length, 3);
  assert.ok(events.includes('sync done'));
});

test('the lock is released when the sync throws', { timeout: 5000 }, async () => {
  await assert.rejects(
    withAllGymLocks(['LD-1', 'LD-2'], async () => {
      throw new Error('sheet failed');
    }),
    /sheet failed/,
  );
  // Both keys are free again.
  const ran: string[] = [];
  await withLock('gym:LD-1', async () => void ran.push('LD-1'));
  await withLock('gym:LD-2', async () => void ran.push('LD-2'));
  assert.deepEqual(ran, ['LD-1', 'LD-2']);
});

test('with no gyms the function just runs', async () => {
  assert.equal(await withAllGymLocks([], async () => 'ok'), 'ok');
});
