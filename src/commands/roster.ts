// /roster: roster requests from leaders and managers (Spec: "Roster requests").
import { displayName, type Member } from '../discord.js';
import type { CommandHandler, CommandInteraction } from '../interactions.js';
import { withLock } from '../locks.js';
import { checkAdd, checkRequester } from '../roster/checks.js';
import { findTrainer, loadLeague, mention } from '../roster/league.js';
import {
  cardText, describeChange, formatChange, gymMention, nextRequestId, postApprovalCard,
  type RosterRequest,
} from '../roster/requests.js';
import { activeSeason, formatDate, isInSeason, todayUtc } from '../seasons.js';
import { appendRows, readTabs } from '../sheet-rows.js';

export const rosterCommand = {
  name: 'roster',
  description: 'Roster requests for your gym',
  type: 1,
  options: [
    {
      type: 1,
      name: 'add',
      description: 'Request to add a trainer with no gym to your gym',
      options: [
        { type: 6, name: 'trainer', description: 'The member to add', required: true },
        {
          type: 3,
          name: 'role',
          description: 'trainer (default) or non-playing',
          choices: [
            { name: 'trainer', value: 'trainer' },
            { name: 'non-playing', value: 'non-playing' },
          ],
        },
      ],
    },
    // Temporary, for testing the plumbing; removed once /roster add works.
    { type: 1, name: 'whoami', description: 'Show what the bot reads about you from the League DB' },
  ],
};

export const handleRoster: CommandHandler = async (interaction) => {
  const sub = interaction.data.options?.[0]?.name;
  if (sub === 'add') return add(interaction);
  if (sub === 'whoami') return whoami(interaction);
  return `Unknown subcommand: ${sub}`;
};

// The chosen subcommand's options, by name.
const subOptions = (interaction: CommandInteraction) =>
  Object.fromEntries((interaction.data.options?.[0]?.options ?? []).map((o) => [o.name, o.value]));

// A user option's member, from the data Discord sends with the command.
function resolvedMember(interaction: CommandInteraction, userId: string): Member | undefined {
  const user = interaction.data.resolved?.users?.[userId];
  const member = interaction.data.resolved?.members?.[userId];
  return user && member ? { ...member, user } : undefined;
}

const add: CommandHandler = async (interaction) => {
  const opts = subOptions(interaction);
  const targetId = String(opts.trainer);
  const role = String(opts.role ?? 'trainer');
  const target = resolvedMember(interaction, targetId);
  if (!target) return `${mention(targetId)} isn't a member of this server.`;
  if (target.user.bot) return "Bots can't be added to a gym.";

  // Held from reading Roster requests to writing the new row: request IDs and the
  // "no other pending request" check depend on no other request landing in between.
  const result = await withLock('requests', async () => {
    const league = await loadLeague();
    const requester = checkRequester(league, interaction.member.user.id, ['leader', 'manager']);
    if ('refusal' in requester) return requester.refusal;
    const refusal = checkAdd(league, targetId, requester.gym, role);
    if (refusal) return refusal;

    const current = findTrainer(league, targetId);
    const req: RosterRequest = {
      request_id: nextRequestId(league),
      type: 'add',
      requester: interaction.member.user.id,
      target: targetId,
      gym_id: requester.gym.gym_id,
      change: formatChange({ role }),
      status: 'pending',
      created_at: new Date().toISOString(),
      decided_by: '',
      decided_at: '',
      refusal_message: '',
      snapshot_gym_id: current?.gym_id ?? '',
      snapshot_role: current?.role ?? '',
      snapshot_leadership: current?.leadership ?? '',
      snapshot_status: current?.status ?? '',
    };
    await appendRows('rosterRequests', [req]);
    return { req, gymName: requester.gym.name };
  });
  if (typeof result === 'string') return result;

  const { req, gymName } = result;
  const gym = await gymMention(interaction.guild_id, gymName);
  const change = describeChange(req, gym);
  try {
    await postApprovalCard(cardText(req, gym, displayName(target), []), req.request_id);
  } catch (err) {
    console.error(`${req.request_id}: approval card failed to post:`, err);
    return `Request ${req.request_id} is saved (${change}), but its staff card failed to post. Please tell staff.`;
  }
  return {
    reply: `Request ${req.request_id} submitted: ${change}. Staff will review it.`,
    publicMessage: `**Transfer Request**: ${change}`,
  };
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
      ? `Season ${season.season}: ${formatDate(season.start)} to ${formatDate(season.end)}; ${isInSeason(season, today) ? 'in season' : 'off-season'} on ${formatDate(today)} (UTC)`
      : `No active season: off-season on ${formatDate(today)} (UTC)`,
  );
  return lines.join('\n');
};
