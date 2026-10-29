// In-memory locks: callers with the same key run one at a time, in arrival order.
// Correct only because exactly one bot process runs (Spec: "Platform").
const tails = new Map<string, Promise<void>>();

// How long a caller waits for the lock before giving up. Calls inside a lock
// time out on their own, so this is a backstop, longer than any normal
// approval (a large disband makes dozens of Discord calls).
const WAIT_MS = 5 * 60_000;

// Shown to the person whose command or button gave up waiting.
export class LockTimeout extends Error {
  constructor() {
    super('The bot is still busy with an earlier request. Please try again in a few minutes.');
  }
}

export async function withLock<T>(key: string, fn: () => Promise<T>, waitMs = WAIT_MS): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  // The next caller waits for the one before this caller too, so giving up
  // early never lets it in while that one still runs.
  const tail = prev.then(() => mine);
  tails.set(key, tail);

  let timer: NodeJS.Timeout | undefined;
  const acquired = await Promise.race([
    prev.then(() => true),
    new Promise<false>((r) => (timer = setTimeout(() => r(false), waitMs))),
  ]);
  clearTimeout(timer);
  if (!acquired) {
    release();
    throw new LockTimeout();
  }
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
