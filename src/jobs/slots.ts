// When the nightly name sync is due. Pure: no timers, no I/O.
// 21:00 America/Denver, worked out with Intl so daylight saving needs no library
// and no UTC offset is hard-coded. Most of the league plays in the morning or
// afternoon in North America, and the Europeans are asleep.
export const SYNC_TIME_ZONE = 'America/Denver';
export const SYNC_HOUR = 21;

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

// The wall clock in `tz` at this instant.
function wallClock(instant: number, tz: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: n('year'), m: n('month'), d: n('day'), h: n('hour'), mi: n('minute'), s: n('second') };
}

// How far `tz`'s wall clock is ahead of UTC at this instant, in ms.
function offsetMs(instant: number, tz: string): number {
  const w = wallClock(instant, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(instant / 1000) * 1000;
}

// The instant at which `tz`'s wall clock reads this hour on this date. Two
// passes, because the offset to use depends on the instant being found.
function instantAt(y: number, m: number, d: number, h: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h);
  return guess - offsetMs(guess - offsetMs(guess, tz), tz);
}

// The slot on this calendar date; d may run past the month's ends.
function slotOn(y: number, m: number, d: number): number {
  const day = new Date(Date.UTC(y, m - 1, d));
  return instantAt(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), SYNC_HOUR, SYNC_TIME_ZONE);
}

// The most recent slot at or before `now`.
export function lastSlot(now: Date): Date {
  const w = wallClock(now.getTime(), SYNC_TIME_ZONE);
  const today = slotOn(w.y, w.m, w.d);
  return new Date(today <= now.getTime() ? today : slotOn(w.y, w.m, w.d - 1));
}

// The first slot after `now`.
export function nextSlot(now: Date): Date {
  const w = wallClock(now.getTime(), SYNC_TIME_ZONE);
  const today = slotOn(w.y, w.m, w.d);
  return new Date(today > now.getTime() ? today : slotOn(w.y, w.m, w.d + 1));
}

// Whether a run is owed now: none was ever recorded (or the value is
// unreadable), or the last one is older than the most recent slot. A restart
// after 21:00 that finds yesterday's run therefore runs once, and a restart at
// any other time does not.
export function isCatchUpDue(lastRun: string | undefined, now: Date): boolean {
  const at = lastRun ? Date.parse(lastRun) : NaN;
  return Number.isNaN(at) || at < lastSlot(now).getTime();
}
