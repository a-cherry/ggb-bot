// Bookkeeping that must survive a restart, in the League DB's Bot state tab
// (key, value). Bot Spec: "Data model".
import { withLock } from './locks.js';
import { appendRows, readTabs, updateRows } from './sheet-rows.js';

// Undefined when the key has no row, or its value is blank.
export async function getState(key: string): Promise<string | undefined> {
  const [rows] = await readTabs('botState');
  return rows.find((r) => r.values.key === key)?.values.value || undefined;
}

// Updates the key's row, or adds one. The lock covers the read and the write, so
// two writers can't both add a row for the same key.
export function setState(key: string, value: string): Promise<void> {
  return withLock('bot-state', async () => {
    const [rows] = await readTabs('botState');
    const existing = rows.find((r) => r.values.key === key);
    if (existing) await updateRows('botState', [{ rowNumber: existing.rowNumber, values: { key, value } }]);
    else await appendRows('botState', [{ key, value }]);
  });
}
