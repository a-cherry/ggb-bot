// /roster: roster requests from leaders and managers (Spec: "Roster requests").
import { displayName, type Member } from '../discord.js';
import type { CommandHandler, CommandInteraction, CommandResult } from '../interactions.js';
import { withLock } from '../locks.js';
import {
  checkAdd, checkRemove, checkRequester, checkUpdate, leadershipFor, removeWarnings,
} from '../roster/checks.js';
import { findTrainer, gymName, loadLeague, mention, type Gym, type League } from '../roster/league.js';
import {
  cardText, closeApprovalCard, describeChange, gymMention, newRequest, postApprovalCard, roleLabel,
  type RequestType,
} from '../roster/requests.js';
import { activeSeason, formatDate, isInSeason, todayUtc } from '../seasons.js';
import { appendRows, readTabs, updateRows } from '../sheet-rows.js';

const trainerOption = (description: string) => ({ type: 6, name: 'trainer', description, required: true });
const roleOption = (description: string) => ({
  type: 3,
  name: 'role',
  description,
  choices: [
    // Shown by their Discord role names; the League DB keeps trainer and non-playing.
    { name: 'Participating Trainer', value: 'trainer' },
    { name: 'Non-Player', value: 'non-playing' },
  ],
});

export const rosterCommand = {
  name: 'roster',
  description: 'Roster requests for your gym',
  type: 1,
  options: [
    {
      type: 1,
      name: 'add',
      description: 'Request to add a trainer with no gym to your gym',
      options: [trainerOption('The member to add'), roleOption('Participating Trainer (default) or Non-Player')],
    },
    {
      type: 1,
      name: 'remove',
      description: 'Request to remove a trainer from your gym',
      options: [trainerOption('The trainer to remove')],
    },
    {
      type: 1,
      name: 'update-trainer',
      description: "Request to change a trainer's role or leadership on your gym",
      options: [
        trainerOption('The trainer to change'),
        roleOption('The new role'),
        {
          type: 3,
          name: 'leadership',
          description: 'Gym Leader hands off your leadership; Gym Manager appoints one; None removes the manager',
          choices: [
            { name: 'Gym Leader', value: 'leader' },
            { name: 'Gym Manager', value: 'manager' },
            { name: 'None', value: 'none' },
          ],
        },
      ],
    },
    {
      type: 1,
      name: 'cancel-request',
      description: "Withdraw a pending request for a trainer on your gym",
      options: [trainerOption('The trainer the request is for')],
    },
    // Temporary, for testing the plumbing; removed once /roster add works.
    { type: 1, name: 'whoami', description: 'Show what the bot reads about you from the League DB' },
  ],
};

export const handleRoster: CommandHandler = async (interaction) => {
  const sub = interaction.data.options?.[0]?.name;
  if (sub === 'add') return add(interaction);
  if (sub === 'remove') return remove(interaction);
  if (sub === 'update-trainer') return updateTrainer(interaction);
  if (sub === 'cancel-request') return cancelRequest(interaction);
  if (sub === 'whoami') return whoami(interaction);
  return `Unknown subcommand: ${sub}`;
};

// The chosen subcommand's options, by name.
const subOptions = (interaction: CommandInteraction) =>
  Object.fromEntries((interaction.data.options?.[0]?.options ?? []).map((o) => [o.name, o.value]));

// A user option's member, from the data Discord sends with the command.
// Undefined when the user isn't in the server.
function resolvedMember(interaction: CommandInteraction, userId: string): Member | undefined {
  const user = interaction.data.resolved?.users?.[userId];
  const member = interaction.data.resolved?.members?.[userId];
  return user && member ? { ...member, user } : undefined;
}

interface Submission {
  type: RequestType;
  targetId: string;
  // The change column's values, or a reply when there's nothing to request.
  change: (league: League) => Record<string, string> | string;
  check: (league: League, gym: Gym, change: Record<string, string>) => string | undefined;
  warnings?: (league: League, gym: Gym) => string[];
}

// Checks the requester and the request, writes the Roster requests row and
// posts the staff card (Spec: "On a valid request").
async function submit(interaction: CommandInteraction, s: Submission): Promise<string | CommandResult> {
  // Held from reading Roster requests to writing the new row: request IDs and the
  // "no other pending request" check depend on no other request landing in between.
  const result = await withLock('requests', async () => {
    const league = await loadLeague();
    const target = findTrainer(league, s.targetId);
    const change = s.change(league);
    if (typeof change === 'string') return change;
    const allowed = leadershipFor(s.type, change, target);
    const requester = checkRequester(league, interaction.member.user.id, allowed);
    if ('refusal' in requester) return requester.refusal;
    const refusal = s.check(league, requester.gym, change);
    if (refusal) return refusal;

    const req = newRequest(league, s.type, interaction.member.user.id, s.targetId, requester.gym.gym_id, change);
    await appendRows('rosterRequests', [req]);
    return { req, gymName: requester.gym.name, warnings: s.warnings?.(league, requester.gym) ?? [], target };
  });
  if (typeof result === 'string') return result;

  const { req, warnings, target } = result;
  const gym = await gymMention(interaction.guild_id, result.gymName);
  const change = describeChange(req, gym);
  const member = resolvedMember(interaction, s.targetId);
  const user = interaction.data.resolved?.users?.[s.targetId];
  const targetName = member ? displayName(member) : target?.server_nickname || user?.username || s.targetId;
  try {
    await postApprovalCard(cardText(req, gym, targetName, warnings), req.request_id);
  } catch (err) {
    console.error(`${req.request_id}: approval card failed to post:`, err);
    return `Request ${req.request_id} is saved (${change}), but its staff card failed to post. Please tell staff.`;
  }
  return {
    reply: `Request ${req.request_id} submitted: ${change}. Staff will review it.`,
    publicMessage: `**Transfer Request**: ${change}`,
  };
}

const add: CommandHandler = async (interaction) => {
  const opts = subOptions(interaction);
  const targetId = String(opts.trainer);
  const role = String(opts.role ?? 'trainer');
  const target = resolvedMember(interaction, targetId);
  if (!target) return `${mention(targetId)} isn't a member of this server.`;
  if (target.user.bot) return "Bots can't be added to a gym.";
  return submit(interaction, {
    type: 'add',
    targetId,
    change: () => ({ role }),
    check: (league, gym) => checkAdd(league, targetId, gym, role),
  });
};

// A trainer who has left the server can still be removed.
const remove: CommandHandler = async (interaction) => {
  const targetId = String(subOptions(interaction).trainer);
  return submit(interaction, {
    type: 'remove',
    targetId,
    change: () => ({}),
    check: (league, gym) => checkRemove(league, targetId, gym),
    warnings: (league, gym) => removeWarnings(league, targetId, gym),
  });
};

const updateTrainer: CommandHandler = async (interaction) => {
  const opts = subOptions(interaction);
  const targetId = String(opts.trainer);
  const role = opts.role ? String(opts.role) : undefined;
  const leadership = opts.leadership ? String(opts.leadership) : undefined;
  if (!role && !leadership) return 'Choose a role, a leadership, or both.';
  return submit(interaction, {
    type: 'update-trainer',
    targetId,
    change: (league) => updateChange(league, targetId, role, leadership),
    check: (league, gym, change) => checkUpdate(league, targetId, gym, change),
  });
};

// Only the parts that change something are requested, so leadership None on a
// trainer with no leadership is ignored rather than refused. A request that
// would change nothing isn't made.
function updateChange(
  league: League, targetId: string, role: string | undefined, leadership: string | undefined,
): Record<string, string> | string {
  const target = findTrainer(league, targetId);
  if (!target) return `${mention(targetId)} isn't on a gym.`;
  const change: Record<string, string> = {};
  if (role && role !== target.role) change.role = role;
  if (leadership && leadership !== target.leadership) change.leadership = leadership;
  if (Object.keys(change).length) return change;
  const labels = [roleLabel(target.role), ...(target.leadership !== 'none' ? [roleLabel(target.leadership)] : [])];
  return `${mention(targetId)} is already ${labels.join(' and ')}, so there's nothing to request.`;
}

// A trainer has at most one pending request (Spec: "No other pending request for
// the same trainer"), so the trainer names the request.
const cancelRequest: CommandHandler = async (interaction) => {
  const targetId = String(subOptions(interaction).trainer);
  const [requests] = await readTabs('rosterRequests');
  const found = requests.find((r) => r.values.target === targetId && r.values.status === 'pending');
  if (!found) return `${mention(targetId)} has no pending request.`;
  const requestId = found.values.request_id;

  // The gym's lock, as in approval, so a cancel can't land in the middle of an approval.
  const result = await withLock(`gym:${found.values.gym_id}`, async () => {
    const league = await loadLeague();
    const row = league.requests.find((r) => r.values.request_id === requestId)!;
    if (row.values.status !== 'pending') return `${mention(targetId)}'s request ${requestId} was already ${row.values.status}.`;
    // Either of the gym's leader and manager can cancel, whoever made it.
    const requester = checkRequester(league, interaction.member.user.id, ['leader', 'manager']);
    if ('refusal' in requester) return requester.refusal;
    if (requester.gym.gym_id !== row.values.gym_id) {
      return `${mention(targetId)}'s pending request ${requestId} is for ${gymName(league, row.values.gym_id)}, so only its leader or manager can cancel it.`;
    }
    const req = {
      ...row.values,
      status: 'cancelled',
      decided_by: interaction.member.user.id,
      decided_at: new Date().toISOString(),
    };
    await updateRows('rosterRequests', [{ rowNumber: row.rowNumber, values: req }]);
    return { req, gymName: gymName(league, req.gym_id) };
  });
  if (typeof result === 'string') return result;

  const { req } = result;
  try {
    if (!(await closeApprovalCard(requestId, '**Cancelled**'))) console.error(`${requestId}: staff card not found to mark cancelled`);
  } catch (err) {
    console.error(`${requestId}: staff card could not be marked cancelled:`, err);
  }
  const change = describeChange(req, await gymMention(interaction.guild_id, result.gymName));
  return {
    reply: `Request ${requestId} cancelled.`,
    publicMessage: `**Transfer Request cancelled**: ${change}`,
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
      `Gym: ${t.gym_id ? `${gym ? `${gym.values.name}` : '(no such gym)'}` : 'none'}`,
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
