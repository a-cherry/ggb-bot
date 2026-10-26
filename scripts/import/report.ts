// The import report staff review before committing. Built as lines so the
// same report prints to the terminal and posts to Discord.
import type { Classification, ImportedTrainer } from './classify.js';

// Roster limits the report flags (Spec: "Report also lists").
const TRAINERS_MIN = 8;
const TRAINERS_MAX = 15;
const LEADERS_REQUIRED = 1;
const MANAGERS_MAX = 1;
const NON_PLAYING_MAX = 3;

export interface ReportOptions {
  title: string;
  memberCount: number;
  // How a member is shown: a mention in Discord, a name in the terminal.
  mention: (m: { discordId: string; name: string }) => string;
}

export function buildReport(c: Classification, opts: ReportOptions): string[] {
  const { mention } = opts;
  const lines: string[] = [];
  const section = (heading: string) => lines.push('', `**${heading}**`);
  const list = (items: string[]) => lines.push(...(items.length ? items.map((i) => `- ${i}`) : ['- none']));

  lines.push(
    `**${opts.title}**`,
    `Read ${opts.memberCount} members. ${c.trainers.length} trainers will be imported into ${c.activeGyms.length} active gyms.`,
  );

  const byGym = new Map<string, ImportedTrainer[]>(c.activeGyms.map((g) => [g, []]));
  for (const t of c.trainers) byGym.get(t.gym)!.push(t);

  section(`Active gyms (${c.activeGyms.length})`);
  list(
    c.activeGyms.map((gym) => {
      const ts = byGym.get(gym)!;
      const trainers = ts.filter((t) => t.role === 'trainer').length;
      const nonPlaying = ts.length - trainers;
      const leaders = ts.filter((t) => t.leadership === 'leader').length;
      const managers = ts.filter((t) => t.leadership === 'manager').length;
      const leaderError = leaders !== LEADERS_REQUIRED ? ` [Needs ${LEADERS_REQUIRED}]` : '';
      const managerError = managers > MANAGERS_MAX ? ` [Max ${MANAGERS_MAX}]` : '';
      const trainerError =
        trainers < TRAINERS_MIN || trainers > TRAINERS_MAX ? ` [Needs ${TRAINERS_MIN}-${TRAINERS_MAX}]` : '';
      const nonPlayingError = nonPlaying > NON_PLAYING_MAX ? ` [Max ${NON_PLAYING_MAX}]` : '';
      return (
        `**${gym}**: ` +
        [
          `${count(leaders, 'Leader')}${leaderError}`,
          `${count(managers, 'Manager')}${managerError}`,
          `${count(trainers, 'Participating trainer')}${trainerError}`,
          `${count(nonPlaying, 'Non-Player')}${nonPlayingError}`,
        ].join(', ')
      );
    }),
  );

  section(`Relegated gyms (${c.relegatedGyms.length})`);
  lines.push('Added with status `relegated` so their names stay reserved.');
  list(c.relegatedGyms);

  lines.push('', 'Abbreviations are blank for every gym. Staff fill them in the Gyms tab after the commit.');

  section('Not imported');
  lines.push(`More than one gym role (${c.multipleGymRoles.length}):`);
  list(c.multipleGymRoles.map((m) => `${mention(m)} (${m.gyms.join(', ')})`));
  lines.push(`Gym role without Participating Trainer (${c.gymRoleWithoutParticipating.length}):`);
  list(c.gymRoleWithoutParticipating.map((m) => `${mention(m)} (${m.gyms.join(', ')})`));

  const both = c.trainers.filter((t) => t.bothLeaderAndManager);
  section(`Both Gym Leader and Gym Manager (${both.length})`);
  lines.push('Imported with leadership `none`.');
  list(both.map((t) => `${mention(t)} (${t.gym})`));

  return lines;
}

// Packs lines into messages under Discord's length limit, breaking only between lines.
export function splitMessages(lines: string[], limit: number): string[] {
  const messages: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= limit) {
      current = next;
    } else {
      if (current) messages.push(current);
      current = line.slice(0, limit);
    }
  }
  if (current) messages.push(current);
  return messages;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
