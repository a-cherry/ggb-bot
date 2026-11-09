// Replaces the real players in the captured match fixtures with made-up ones,
// so the fixtures can live in a public repo. Pure: no Sheets imports.
//
// Each roster name in AK4:AL13 becomes "Left Player NN" or "Right Player NN"
// (a gym tag before " | " is kept, so tagged names still look tagged). Every
// cell that exactly matches a real name is rewritten with the same fake name,
// so the roster, game rows, name table and League DB rows still agree. Each
// Trainer's Discord ID becomes a fake 19-digit ID, their username a slug of
// the fake name, and their country is blanked.

type Cells = Record<string, string[][]>;
interface Row {
  values: Record<string, string>;
}

export function anonymizeFixtures<M extends { ranges: Cells }, L extends { trainers: Row[] }>(
  match: M,
  league: L,
): { match: M; league: L } {
  const helper = match.ranges['AK1:AP13'];
  const names = new Map<string, string>();
  helper.slice(3, 13).forEach((row, i) => {
    const n = String(i + 1).padStart(2, '0');
    [`Left Player ${n}`, `Right Player ${n}`].forEach((fake, side) => {
      const real = row[side];
      if (!real) return;
      const tag = real.includes(' | ') ? real.slice(0, real.indexOf(' | ') + 3) : '';
      names.set(real, tag + fake);
    });
  });

  // AO4:AP13: the name of each Trainer who played and their Discord ID.
  const ids = new Map<string, string>();
  const usernames = new Map<string, string>();
  for (const row of helper.slice(3, 13)) {
    const [name, id] = [row[4], row[5]];
    const fake = names.get(name);
    if (!fake || !id) throw new Error(`Name table entry ${JSON.stringify(name)} isn't on either roster`);
    const [side, n] = [fake.includes('Left Player') ? '1' : '2', fake.slice(-2)];
    ids.set(id, `1${side}000000000000000${n}`);
    usernames.set(id, fake.replace(/^.* \| /, '').toLowerCase().replaceAll(' ', '_'));
  }

  const swap = (s: string) => names.get(s) ?? ids.get(s) ?? s;
  const ranges = Object.fromEntries(
    Object.entries(match.ranges).map(([r, rows]) => [r, rows.map((row) => row.map(swap))]),
  );
  const trainers = league.trainers.map((t) => {
    const id = t.values.discord_id;
    if (!ids.has(id)) throw new Error(`Trainer ${id} isn't in the name table`);
    return {
      ...t,
      values: {
        ...t.values,
        discord_id: ids.get(id)!,
        server_nickname: swap(t.values.server_nickname),
        username: usernames.get(id)!,
        country: '',
      },
    };
  });
  const out = { match: { ...match, ranges }, league: { ...league, trainers } };

  // Nothing real may survive: no name, ID or username anywhere in the output.
  const text = JSON.stringify(out);
  const real = [...names.keys(), ...ids.keys(), ...league.trainers.map((t) => t.values.username)];
  const leaked = real.filter((s) => s && text.includes(JSON.stringify(s)));
  if (leaked.length) throw new Error(`Anonymizing left real values in the fixtures: ${leaked.join(', ')}`);
  return out;
}
