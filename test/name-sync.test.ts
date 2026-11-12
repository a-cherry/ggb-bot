import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Member } from '../src/discord.js';
import { withLock } from '../src/locks.js';
import { MAX_DEPARTURES, MIN_MATCH_RATE, type TrainerRow } from '../src/jobs/name-diff.js';
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
    readContext: async () => (log.push('gyms'), { gyms: [{ gym_id: 'G001', name: 'Gym One' }, { gym_id: 'G002', name: 'Gym Two' }], season: '7' }),
    readTrainers: async () => (log.push('read'), rows),
    appendHistory: async (h) => void log.push(`history ${h.map((r) => `${r.discord_id}:${r.before_gym_id}>${r.after_gym_id}:${r.source}:${r.season}`).join(',')}`),
    writeMembership: async (written) => void log.push(`membership ${written.map((r) => `${r.rowNumber}:${r.values.status}`).join(',')}`),
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
  assert.deepEqual(result, { changed: 2, departed: 0, matched: 10, total: 10, lostLeaders: [], viewsError: undefined });
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
      readContext: async () => ({ gyms: [{ gym_id: 'NS-1', name: 'One' }, { gym_id: 'NS-2', name: 'Two' }], season: '' }),
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
  assert.ok(log.some((l) => /^log 2 Trainers rows were renamed and 0 taken off their gyms, but recording the run failed/.test(l)));
});

// The ten rostered Trainers with the last `n` of them gone from the server; T1 is G001's leader.
const leaderRows = rows.map((r, i) => (i === 0 ? { ...r, values: { ...r.values, leadership: 'leader' } } : r));
const allBut = (gone: number[]) => membersWith().filter((m) => !gone.includes(Number(m.user.id)));

test('a rostered Trainer who left is written to history, then taken off the gym, then the views rebuilt', async () => {
  const log: string[] = [];
  const result = await syncNames(deps(log, { listMembers: async () => (log.push('list'), allBut([4])) }));
  assert.deepEqual(log.filter((l) => !l.startsWith('log ')), [
    'list', 'gyms', 'read', 'history 4:G001>:sync:7', 'membership 5:inactive', 'views', `record ${AT.toISOString()}`,
  ]);
  assert.ok(log.includes('log T4 (4) of Gym One left the server: taken off the gym, status now inactive'));
  assert.deepEqual([result.departed, result.changed, result.lostLeaders], [1, 0, []]);
});

test('departures and renames in one run both write', async () => {
  const log: string[] = [];
  const result = await syncNames(deps(log, {
    listMembers: async () => membersWith([2]).filter((m) => m.user.id !== '4'),
  }));
  assert.ok(log.includes('membership 5:inactive'));
  assert.ok(log.includes('write 3'));
  assert.deepEqual([result.departed, result.changed], [1, 1]);
});

test('a leader who left is returned, so the job can tell staff the gym has no leader', async () => {
  const log: string[] = [];
  const result = await syncNames(deps(log, {
    listMembers: async () => allBut([1]),
    readTrainers: async () => leaderRows,
  }));
  assert.deepEqual(result.lostLeaders, [{ gymName: 'Gym One', name: 'T1', discordId: '1' }]);
  assert.ok(log.some((l) => l.endsWith('taken off the gym, was leader, status now inactive')));
});

test(`exactly ${MAX_DEPARTURES} departures go ahead`, async () => {
  // A hundred rostered Trainers, so the floor stays met.
  const many = Array.from({ length: 100 }, (_, i) => trainer(i + 1, `T${i + 1}`));
  const present = many.slice(MAX_DEPARTURES).map((r) => member(Number(r.values.discord_id), r.values.server_nickname));
  const log: string[] = [];
  const result = await syncNames(deps(log, { listMembers: async () => present, readTrainers: async () => many }));
  assert.equal(result.departed, MAX_DEPARTURES);
});

test(`more than ${MAX_DEPARTURES} departures abort with nothing written, naming them for staff`, async () => {
  const many = Array.from({ length: 100 }, (_, i) => trainer(i + 1, `T${i + 1}`));
  const present = many.slice(MAX_DEPARTURES + 1).map((r) => member(Number(r.values.discord_id), `New ${r.values.discord_id}`));
  const log: string[] = [];
  await assert.rejects(
    syncNames(deps(log, { listMembers: async () => (log.push('list'), present), readTrainers: async () => (log.push('read'), many) })),
    (err) => err instanceof NameSyncAbort &&
      /^6 rostered Trainers are no longer in the server, more than the 5 one run takes off their gyms, so nothing was changed: T1 \(1\) of Gym One, /.test(err.message),
  );
  assert.deepEqual(log.filter((l) => !l.startsWith('log ')), ['list', 'gyms', 'read']);
  assert.equal(log.filter((l) => l.startsWith('log would have taken')).length, 6);
});

test('a failed history write takes no one off a gym and records nothing', async () => {
  const log: string[] = [];
  await assert.rejects(
    syncNames(deps(log, {
      listMembers: async () => (log.push('list'), allBut([4])),
      appendHistory: async () => Promise.reject(new Error('Sheets 500')),
    })),
    /Sheets 500/,
  );
  assert.deepEqual(log, ['list', 'gyms', 'read']);
});
