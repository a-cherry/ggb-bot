// /roster: roster requests from leaders and managers (Spec: "Roster requests").
import { displayName, type Member } from '../discord.js';
import type { CommandHandler, CommandInteraction } from '../interactions.js';
import { checkAdd, checkRemove, checkUpdate, removeWarnings } from '../roster/checks.js';
import { findTrainer, mention, type League, type Trainer } from '../roster/league.js';
import { roleLabel } from '../roster/requests.js';
import { cancel, submit, type Requester } from '../roster/submit.js';
import { readTabs } from '../sheet-rows.js';

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
  ],
};

export const handleRoster: CommandHandler = async (interaction) => {
  const sub = interaction.data.options?.[0]?.name;
  if (sub === 'add') return add(interaction);
  if (sub === 'remove') return remove(interaction);
  if (sub === 'update-trainer') return updateTrainer(interaction);
  if (sub === 'cancel-request') return cancelRequest(interaction);
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

const requesterOf = (interaction: CommandInteraction): Requester => ({
  id: interaction.member.user.id,
  guildId: interaction.guild_id,
});

// The target's name on the staff card: their server name, else the Trainers
// row's, else their username.
const targetName = (interaction: CommandInteraction, targetId: string) => (target: Trainer | undefined) => {
  const member = resolvedMember(interaction, targetId);
  const user = interaction.data.resolved?.users?.[targetId];
  return member ? displayName(member) : target?.server_nickname || user?.username || targetId;
};

const add: CommandHandler = async (interaction) => {
  const opts = subOptions(interaction);
  const targetId = String(opts.trainer);
  const role = String(opts.role ?? 'trainer');
  const target = resolvedMember(interaction, targetId);
  if (!target) return `${mention(targetId)} isn't a member of this server.`;
  if (target.user.bot) return "Bots can't be added to a gym.";
  return submit(requesterOf(interaction), {
    type: 'add',
    targetId,
    targetName: targetName(interaction, targetId),
    change: () => ({ role }),
    check: (league, gym) => checkAdd(league, targetId, gym, role),
  });
};

// A trainer who has left the server can still be removed.
const remove: CommandHandler = async (interaction) => {
  const targetId = String(subOptions(interaction).trainer);
  return submit(requesterOf(interaction), {
    type: 'remove',
    targetId,
    targetName: targetName(interaction, targetId),
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
  return submit(requesterOf(interaction), {
    type: 'update-trainer',
    targetId,
    targetName: targetName(interaction, targetId),
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
  // Either of the gym's leader and manager can cancel, whoever made it.
  return cancel(requesterOf(interaction), found, ['leader', 'manager'], `${mention(targetId)}'s request`);
};
