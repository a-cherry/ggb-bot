// Every writer of the Trainers tab (approvals, crash recovery) holds its request's
// gym:<id> lock, so holding all of them keeps those writers out between the
// sync's read of Trainers and its write. Approvals hold one gym key plus `rebrand` and never wait
// for a second gym key, and this takes no `rebrand`, so the two cannot deadlock.
import { withLock } from '../locks.js';

// The lock keys for these gyms: sorted, without duplicates or blanks. Any code
// that takes several gym keys must take them in this order.
export const gymLockKeys = (gymIds: string[]): string[] =>
  [...new Set(gymIds.filter(Boolean))].sort().map((id) => `gym:${id}`);

export function withAllGymLocks<T>(gymIds: string[], fn: () => Promise<T>): Promise<T> {
  const keys = gymLockKeys(gymIds);
  const hold = (i: number): Promise<T> => (i === keys.length ? fn() : withLock(keys[i], () => hold(i + 1)));
  return hold(0);
}
