import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Member } from '../src/discord.js';
import { withLock } from '../src/locks.js';
import { MIN_MATCH_RATE, type TrainerRow } from '../src/jobs/name-diff.js';
import { NameSyncAbort, syncNames, type NameSyncDeps } from '../src/jobs/name-sync.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const member = (id: number, nick: string): Member => ({
  user: { id: String(id), username: `user${id}`, global_name: null },
  nick,
  roles: [],
});

const trainer = (id: number, name: string, gymId = 'G001'): TrainerRow => ({
  rowNumber: id + 1,
  values: {
    discord_id: String(id),
    server_nickname: name,
    username: `user${id}`,
    country: 'Testland',
    gym_id: gymId,
    role: 'trainer',
    leadership: 'none',
    status: 'active',
  },
});

// Ten Trainers named "T1".."T10", and ten members; `renamed` of them have a new nickname.
const ids = Array.from({ length: 10 }, (_, i) => i + 1);
const rows = ids.map((i) => trainer(i, `T${i}`));
const membersWith = (renamed: number[] = []) => ids.map((i) => member(i, renamed.includes(i) ? `New ${i}` : `T${i}`));

const AT = new Date('2026-11-10T04:00:07.000Z');

// Deps that log each call, so a test can assert the order and what never happened.
function deps(log: string[], over: Partial<NameSyncDeps> = {}): NameSyncDeps {
  return {
    listMembers: async () => (log.push('list'), membersWith([2, 5])),
    readGymIds: async () => (log.push('gyms'), ['G001', 'G002']),
    readTrainers: async () => (log.push('read'), rows),
    writeNames: async (written) => void log.push(`write ${written.map((r) => r.rowNumber).join(',')}`),
    rebuildViews: async () => void log.push('views'),
    recordRun: async (at) => void log.push(`record ${at.toISOString()}`),
    now: () => AT,
    log: (message) => void log.push(`log ${message}`),
    ...over,
  };
}

test('a run lists, reads, writes the changed rows, rebuilds the views once, then records', async () => {
  const log: string[] = [];
  const result = await syncNames(deps(log));
  assert.deepEqual(log, ['list', 'gyms', 'read', 'write 3,6', 'views', `record ${AT.toISOString()}`]);
  assert.deepEqual(result, { changed: 2, matched: 10, total: 10, viewsError: undefined });
});

test('with nothing to change it writes no rows and rebuilds nothing, but still records', async () => {
  const log: string[] = [];
  const result = await syncNames(deps(log, { listMembers: async () => (log.push('list'), membersWith()) }));
  assert.deepEqual(log, ['list', 'gyms', 'read', `record ${AT.toISOString()}`]);
  assert.equal(result.changed, 0);
});

test('an empty member list aborts before anything is read, written or recorded', async () => {
  const log: string[] = [];
  await assert.rejects(
    syncNames(deps(log, { listMembers: async () => (log.push('list'), []) })),
    (err) => err instanceof NameSyncAbort && /empty member list/.test(err.message),
  );
  assert.deepEqual(log, ['list']);
});

test('a failed member list writes and records nothing', async () => {
  const log: string[] = [];
  await assert.rejects(
    syncNames(deps(log, { listMembers: async () => (log.push('list'), Promise.reject(new Error('Discord 403'))) })),
    /Discord 403/,
  );
  assert.deepEqual(log, ['list']);
});

test('a match rate under the floor aborts without a write or a record', async () => {
  const log: string[] = [];
  // 8 of the 10 Trainers are in the member list.
  await assert.rejects(
    syncNames(deps(log, { listMembers: async () => (log.push('list'), membersWith([2]).slice(0, 8)) })),
    (err) => err instanceof NameSyncAbort && /only 8 of 10/.test(err.message),
  );
  assert.deepEqual(log, ['list', 'gyms', 'read']);
});

test('a match rate exactly at the floor still runs', async () => {
  assert.equal(MIN_MATCH_RATE, 0.9);
  const log: string[] = [];
  const result = await syncNames(deps(log, { listMembers: async () => (log.push('list'), membersWith([2]).slice(0, 9)) }));
  assert.equal(result.matched, 9);
  assert.ok(log.includes('write 3'));
});

test('a server full of non-Trainers does not lower the match rate', async () => {
  const others = Array.from({ length: 1200 }, (_, i) => member(5000 + i, `Spectator ${i}`));
  const log: string[] = [];
  const result = await syncNames(deps(log, { listMembers: async () => [...membersWith([2]), ...others] }));
  assert.deepEqual([result.matched, result.total, result.changed], [10, 10, 1]);
});

test('an empty Trainers tab has nothing to do and is not an abort', async () => {
  const log: string[] = [];
  const result = await syncNames(deps(log, { readTrainers: async () => (log.push('read'), []) }));
  assert.deepEqual([result.changed, result.matched, result.total], [0, 0, 0]);
  assert.ok(log.at(-1)!.startsWith('record'));
});

test('a failed write rebuilds nothing and records nothing', async () => {
  const log: string[] = [];
  await assert.rejects(
    syncNames(deps(log, { writeNames: async () => Promise.reject(new Error('Sheets 500')) })),
    /Sheets 500/,
  );
  assert.deepEqual(log, ['list', 'gyms', 'read']);
});

test('a failed read of the Trainers tab, e.g. a header problem, writes and records nothing', async () => {
  const log: string[] = [];
  await assert.rejects(syncNames(deps(log, { readTrainers: async () => Promise.reject(new Error('bad header')) })), /bad header/);
  assert.deepEqual(log, ['list', 'gyms']);
});

test('a failed views rebuild is returned, and the run is still recorded', async () => {
  const log: string[] = [];
  const boom = new Error('views failed');
  const result = await syncNames(deps(log, { rebuildViews: async () => Promise.reject(boom) }));
  assert.equal(result.viewsError, boom);
  assert.ok(log.at(-1)!.startsWith('record'));
});

test('every gym lock is held from the read through the write, and released after', async () => {
  const events: string[] = [];
  let approval: Promise<void> | undefined;
  const run = syncNames(
    deps([], {
      readGymIds: async () => ['NS-1', 'NS-2'],
      writeNames: async () => {
        events.push('write');
        // An approval on one of the gyms, arriving mid-write: it must wait.
        approval = withLock('gym:NS-2', async () => void events.push('approval'));
        await settle();
        events.push('write finished');
      },
    }),
  );
  await run;
  await approval;
  assert.deepEqual(events, ['write', 'write finished', 'approval']);
});

test('removed Trainers who left the server do not count against the floor, and are not written', async () => {
  const log: string[] = [];
  // Ten rostered Trainers, all in the server, plus five removed ones (no gym_id) who left.
  const removed = [11, 12, 13, 14, 15].map((i) => trainer(i, `Former ${i}`, ''));
  const result = await syncNames(deps(log, { readTrainers: async () => (log.push('read'), [...rows, ...removed]) }));
  assert.deepEqual([result.matched, result.total, result.changed], [10, 10, 2]);
  assert.ok(log.includes('write 3,6'));
});

test('a removed Trainer still in the server is renamed, but not counted', async () => {
  const log: string[] = [];
  const free = trainer(11, 'Old Free', '');
  const result = await syncNames(
    deps(log, {
      listMembers: async () => [...membersWith(), member(11, 'New Free')],
      readTrainers: async () => [...rows, free],
    }),
  );
  assert.deepEqual([result.matched, result.total, result.changed], [10, 10, 1]);
  assert.ok(log.includes('write 12'));
});

test('a failed record after a write logs what was written and fails the attempt', async () => {
  const log: string[] = [];
  await assert.rejects(
    syncNames(deps(log, { recordRun: async () => Promise.reject(new Error('Sheets 503')) })),
    /Sheets 503/,
  );
  assert.ok(log.includes('write 3,6'));
  assert.ok(log.some((l) => /^log 2 Trainers rows were renamed, but recording the run failed/.test(l)));
});
