import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATCH_RANGES } from '../src/match/parse.js';
import { exampleMatch, league } from './fixtures.js';

test('example match fixture has every anchor range', () => {
  const { ranges } = exampleMatch();
  assert.deepEqual(Object.keys(ranges), [...MATCH_RANGES]);
  assert.equal(ranges['AK1:AP13'][1][0], 'G022');
  assert.equal(ranges['AK1:AP13'][1][1], 'G025');
  // K41 and M41: the last row of C21:R41, columns K and M.
  const scores = ranges['C21:R41'][20];
  assert.equal(scores[8], '9');
  assert.equal(scores[10], '10');
});

test('Discord IDs in the fixtures stay strings', () => {
  const ids = exampleMatch().ranges['AK1:AP13'].slice(3, 13).map((row) => row[5]);
  assert.ok(ids.includes('1200000000000000002'));
  assert.ok(league().trainers.some((t) => t.values.discord_id === '1200000000000000002'));
});

test('league fixture has the two match gyms, a relegated gym and ten Trainers', () => {
  const { gyms, trainers, seasons, matches, decks } = league();
  assert.deepEqual(gyms.map((g) => [g.values.gym_id, g.values.status]), [
    ['G022', 'active'],
    ['G025', 'active'],
    ['G007', 'relegated'],
  ]);
  assert.equal(trainers.length, 10);
  assert.ok(seasons.some((s) => s.values.season === '5' && s.values.active === 'true'));
  assert.equal(matches.length, 0);
  assert.equal(decks.length, 0);
});
