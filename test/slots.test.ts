import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCatchUpDue, lastSlot, nextSlot } from '../src/jobs/slots.js';

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

test('an ordinary evening: the next slot is 21:00 Denver tonight, the last was last night', () => {
  // 2026-11-09 20:27 Denver (MST, UTC-7)
  const now = at('2026-11-10T03:27:00Z');
  assert.equal(nextSlot(now).toISOString(), '2026-11-10T04:00:00.000Z');
  assert.equal(lastSlot(now).toISOString(), '2026-11-09T04:00:00.000Z');
});

test('after 21:00 the next slot is tomorrow night', () => {
  const now = at('2026-11-10T05:00:00Z'); // 22:00 Denver
  assert.equal(lastSlot(now).toISOString(), '2026-11-10T04:00:00.000Z');
  assert.equal(nextSlot(now).toISOString(), '2026-11-11T04:00:00.000Z');
});

test('at exactly 21:00 that slot is the last one, and the next is a day later', () => {
  const now = at('2026-11-10T04:00:00Z');
  assert.equal(lastSlot(now).toISOString(), '2026-11-10T04:00:00.000Z');
  assert.equal(nextSlot(now).toISOString(), '2026-11-11T04:00:00.000Z');
});

test('daylight saving ends 2026-11-01: 21:00 stays 21:00 local, so that day is 25 hours long', () => {
  const now = at('2026-11-01T12:00:00Z'); // 05:00 Denver, after the clocks went back
  const last = lastSlot(now);
  const next = nextSlot(now);
  assert.equal(last.toISOString(), '2026-11-01T03:00:00.000Z'); // Oct 31 21:00 MDT
  assert.equal(next.toISOString(), '2026-11-02T04:00:00.000Z'); // Nov 1 21:00 MST
  assert.equal((next.getTime() - last.getTime()) / HOUR, 25);
});

test('daylight saving starts 2027-03-14: 21:00 stays 21:00 local, so that day is 23 hours long', () => {
  const now = at('2027-03-14T12:00:00Z'); // 06:00 Denver, after the clocks went forward
  const last = lastSlot(now);
  const next = nextSlot(now);
  assert.equal(last.toISOString(), '2027-03-14T04:00:00.000Z'); // Mar 13 21:00 MST
  assert.equal(next.toISOString(), '2027-03-15T03:00:00.000Z'); // Mar 14 21:00 MDT
  assert.equal((next.getTime() - last.getTime()) / HOUR, 23);
});

test('slots roll over month and year ends', () => {
  const now = at('2027-01-01T06:30:00Z'); // 2026-12-31 23:30 Denver
  assert.equal(lastSlot(now).toISOString(), '2027-01-01T04:00:00.000Z');
  assert.equal(nextSlot(now).toISOString(), '2027-01-02T04:00:00.000Z');
  const early = at('2027-01-01T08:00:00Z'); // 2027-01-01 01:00 Denver
  assert.equal(lastSlot(early).toISOString(), '2027-01-01T04:00:00.000Z');
});

test('catch-up is due when nothing was ever recorded, or the value is unreadable', () => {
  const now = at('2026-11-10T03:27:00Z');
  assert.equal(isCatchUpDue(undefined, now), true);
  assert.equal(isCatchUpDue('', now), true);
  assert.equal(isCatchUpDue('not a date', now), true);
});

test('catch-up is due only when the last run is older than the most recent slot', () => {
  const now = at('2026-11-10T03:27:00Z'); // last slot was 2026-11-09T04:00Z
  assert.equal(isCatchUpDue('2026-11-09T03:59:59.000Z', now), true); // missed that slot
  assert.equal(isCatchUpDue('2026-11-09T04:00:00.000Z', now), false); // ran exactly at it
  assert.equal(isCatchUpDue('2026-11-09T04:07:12.000Z', now), false); // ran a few minutes late, after retries
});

test('a restart just after 21:00 with no run recorded for tonight owes one', () => {
  const now = at('2026-11-10T04:05:00Z'); // 21:05 Denver
  assert.equal(isCatchUpDue('2026-11-09T04:00:41.000Z', now), true);
  assert.equal(isCatchUpDue('2026-11-10T04:00:41.000Z', now), false);
});
