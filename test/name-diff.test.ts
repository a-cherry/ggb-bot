import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Member } from '../src/discord.js';
import { belowFloor, diffNames, type TrainerRow } from '../src/jobs/name-diff.js';

interface MemberOptions {
  nick?: string | null;
  global?: string | null;
  username?: string;
  bot?: boolean;
}

const member = (id: string, o: MemberOptions = {}): Member => ({
  user: { id, username: o.username ?? `user${id}`, global_name: o.global ?? null, bot: o.bot },
  nick: o.nick ?? null,
  roles: [],
});

const row = (rowNumber: number, id: string, name: string, username: string, gymId = 'G001'): TrainerRow => ({
  rowNumber,
  values: {
    discord_id: id,
    server_nickname: name,
    username,
    country: 'Testland',
    gym_id: gymId,
    role: 'trainer',
    leadership: 'none',
    status: 'active',
  },
});

test('nothing changes when the names already match', () => {
  const members = [member('1', { nick: 'Aster' }), member('2', { global: 'Birch' })];
  const rows = [row(2, '1', 'Aster', 'user1'), row(3, '2', 'Birch', 'user2')];
  assert.deepEqual(diffNames(members, rows), { changes: [], matched: 2, total: 2 });
});

test('a new nickname changes only that row, keeping its other columns and row number', () => {
  const rows = [row(2, '1', 'Aster', 'user1'), row(7, '2', 'Birch', 'user2')];
  const { changes } = diffNames([member('1', { nick: 'Aster' }), member('2', { nick: 'Birch Prime' })], rows);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].rowNumber, 7);
  assert.deepEqual(changes[0].values, { ...rows[1].values, server_nickname: 'Birch Prime' });
});

test('a new username changes the row too', () => {
  const rows = [row(2, '1', 'user1', 'user1')];
  const { changes } = diffNames([member('1', { username: 'renamed' })], rows);
  assert.deepEqual(changes.map((c) => [c.values.server_nickname, c.values.username]), [['renamed', 'renamed']]);
});

test('a cleared nickname falls back to the global name, then the username', () => {
  const rows = [row(2, '1', 'Old Nick', 'user1'), row(3, '2', 'Old Nick', 'user2')];
  const { changes } = diffNames([member('1', { global: 'Global One' }), member('2')], rows);
  assert.deepEqual(changes.map((c) => c.values.server_nickname), ['Global One', 'user2']);
});

test('a Trainer who left the server is left untouched but counts in the total', () => {
  const rows = [row(2, '1', 'Aster', 'user1'), row(3, '9', 'Gone', 'gone')];
  assert.deepEqual(diffNames([member('1', { nick: 'Aster' })], rows), { changes: [], matched: 1, total: 2 });
});

test('server members with no Trainers row are ignored and do not enter the counts', () => {
  const members = Array.from({ length: 1200 }, (_, i) => member(String(1000 + i), { nick: `Name ${i}` }));
  const rows = Array.from({ length: 380 }, (_, i) => row(i + 2, String(1000 + i * 3), `Name ${i * 3}`, `user${1000 + i * 3}`));
  const { changes, matched, total } = diffNames(members, rows);
  assert.equal(changes.length, 0);
  assert.equal(matched, 380);
  assert.equal(total, 380);
});

test('rows with no discord_id are skipped and not counted', () => {
  const rows = [row(2, '', 'Blank', 'blank'), row(3, '1', 'Aster', 'user1')];
  assert.deepEqual(diffNames([member('1', { nick: 'Aster' })], rows), { changes: [], matched: 1, total: 1 });
});

test('an empty name never overwrites a stored one', () => {
  const rows = [row(2, '1', 'Aster', 'olduser')];
  // A nickname of only spaces and an empty username both come back empty once trimmed.
  assert.deepEqual(diffNames([member('1', { nick: '   ', username: '' })], rows), { changes: [], matched: 1, total: 1 });
});

test('names are trimmed, so stray spaces do not make a row look changed every night', () => {
  const rows = [row(2, '1', 'Aster', 'user1')];
  assert.equal(diffNames([member('1', { nick: ' Aster ' })], rows).changes.length, 0);
});

test('a name that starts with = is carried through as typed', () => {
  const rows = [row(2, '1', 'Aster', 'user1')];
  const { changes } = diffNames([member('1', { nick: '=SUM(A1:A9)' })], rows);
  assert.equal(changes[0].values.server_nickname, '=SUM(A1:A9)');
});

test('bot accounts are handled like any member: matched by id, so only a Trainers row can pick one up', () => {
  const rows = [row(2, '5', 'Helper', 'helperbot')];
  const { changes, matched } = diffNames([member('5', { nick: 'Helper', bot: true, username: 'helperbot' })], rows);
  assert.equal(changes.length, 0);
  assert.equal(matched, 1);
});

test('rows with no gym_id are renamed like any other, but stay out of the counts', () => {
  const rows = [row(2, '1', 'Aster', 'user1'), row(3, '2', 'Old', 'user2', ''), row(4, '3', 'Gone', 'gone', '')];
  const { changes, matched, total } = diffNames([member('1', { nick: 'Aster' }), member('2', { nick: 'New' })], rows);
  assert.deepEqual(changes.map((c) => [c.rowNumber, c.values.server_nickname]), [[3, 'New']]);
  assert.deepEqual([matched, total], [1, 1]);
});

test('a discord_id on two rows renames both rows the same way', () => {
  const rows = [row(2, '1', 'Aster', 'user1'), row(9, '1', 'Aster Old', 'user1')];
  const { changes, matched, total } = diffNames([member('1', { nick: 'Aster New' })], rows);
  assert.deepEqual(changes.map((c) => [c.rowNumber, c.values.server_nickname]), [[2, 'Aster New'], [9, 'Aster New']]);
  assert.deepEqual([matched, total], [2, 2]);
});

test('the floor trips under 90% only, and never with nothing rostered', () => {
  assert.equal(belowFloor({ matched: 342, total: 380 }), false); // exactly 90%
  assert.equal(belowFloor({ matched: 341, total: 380 }), true);
  assert.equal(belowFloor({ matched: 0, total: 0 }), false);
});
