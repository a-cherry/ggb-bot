// /roster: roster requests from leaders and managers (Spec: "Roster requests").
import { displayName } from '../discord.js';
import type { CommandHandler } from '../interactions.js';
import { activeSeason, isInSeason, todayUtc } from '../seasons.js';
import { readTabs } from '../sheet-rows.js';

export const rosterCommand = {
  name: 'roster',
  description: 'Roster requests for your gym',
  type: 1,
  options: [
    // Temporary, for testing the plumbing; removed once /roster add works.
    { type: 1, name: 'whoami', description: 'Show what the bot reads about you from the League DB' },
  ],
};

export const handleRoster: CommandHandler = async (interaction) => {
  const sub = interaction.data.options?.[0]?.name;
  if (sub === 'whoami') return whoami(interaction);
  return `Unknown subcommand: ${sub}`;
};

const whoami: CommandHandler = async ({ member }) => {
  const [trainers, gyms, seasons] = await readTabs('trainers', 'gyms', 'seasons');
  const season = activeSeason(seasons);
  const today = todayUtc();
  const lines = [`Discord: ${displayName(member)} (${member.user.username}, ${member.user.id})`];

  const trainer = trainers.find((t) => t.values.discord_id === member.user.id);
  if (!trainer) {
    lines.push('Trainers: no row for you');
  } else {
    const t = trainer.values;
    const gym = gyms.find((g) => g.values.gym_id === t.gym_id);
    lines.push(
      `Trainers row ${trainer.rowNumber}: ${t.server_nickname} (${t.username}), status ${t.status}`,
      `Gym: ${t.gym_id ? `${t.gym_id} ${gym ? `${gym.values.name} (${gym.values.status})` : '(no such gym)'}` : 'none'}`,
      `Role ${t.role}, leadership ${t.leadership}`,
    );
  }

  lines.push(
    season
      ? `Season ${season.season}: ${season.start} to ${season.end}; ${isInSeason(season, today) ? 'in season' : 'off-season'} on ${today} (UTC)`
      : `No active season: off-season on ${today} (UTC)`,
  );
  return lines.join('\n');
};
