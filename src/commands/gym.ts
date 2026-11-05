// /gym: rebrand and disband requests from a gym's leader (Roster Spec: "Commands").
import { cachedRoles, escapeMarkdown, parseEmote, renderEmote, type ActionRow } from '../discord.js';
import type { CommandHandler, CommandInteraction, ComponentHandler, ComponentResult } from '../interactions.js';
import { checkDisband, checkRebrand, checkRequester } from '../roster/checks.js';
import { loadLeague, type Gym } from '../roster/league.js';
import { isGymRequest } from '../roster/requests.js';
import { cancel, submit, type Requester } from '../roster/submit.js';

// Gym names become Discord role names, which Discord caps at 100 characters,
// and the fan role adds " Fan".
const NAME_MAX = 90;

export const gymCommand = {
  name: 'gym',
  description: 'Rebrand or disband your gym',
  type: 1,
  options: [
    {
      type: 1,
      name: 'rebrand',
      description: "Request to change your gym's name, abbreviation and emote (off-season only)",
      options: [
        { type: 3, name: 'name', description: 'The new gym name', required: true, max_length: NAME_MAX },
        {
          type: 3, name: 'abbreviation', description: 'The new abbreviation, 2 to 5 characters with no spaces',
          required: true, min_length: 2, max_length: 5,
        },
        { type: 3, name: 'emote', description: "The gym's emote: one of this server's emotes, or an emoji", required: true },
      ],
    },
    { type: 1, name: 'disband', description: 'Request to disband your gym (off-season only)' },
    { type: 1, name: 'cancel-request', description: "Withdraw your gym's pending rebrand or disband request" },
  ],
};

export const handleGym: CommandHandler = async (interaction) => {
  const sub = interaction.data.options?.[0]?.name;
  if (sub === 'rebrand') return rebrand(interaction);
  if (sub === 'disband') return disband(interaction);
  if (sub === 'cancel-request') return cancelRequest(interaction);
  return `Unknown subcommand: ${sub}`;
};

const subOptions = (interaction: CommandInteraction) =>
  Object.fromEntries((interaction.data.options?.[0]?.options ?? []).map((o) => [o.name, String(o.value)]));

const requesterOf = (interaction: { member: { user: { id: string } }; guild_id: string }): Requester => ({
  id: interaction.member.user.id,
  guildId: interaction.guild_id,
});

const rebrand: CommandHandler = async (interaction) => {
  const opts = subOptions(interaction);
  const name = opts.name.trim().replace(/\s+/g, ' ');
  if (!name) return 'The new name is blank.';
  const abbreviation = opts.abbreviation.trim().toUpperCase();
  // Characters, not UTF-16 units, so an accented letter counts once.
  if (/\s/.test(abbreviation) || [...abbreviation].length < 2 || [...abbreviation].length > 5) {
    return 'The abbreviation must be 2 to 5 characters with no spaces.';
  }
  const emote = await parseEmote(interaction.guild_id, opts.emote);
  if (!emote) return "The emote must be one of this server's emotes, or an emoji.";
  // Re-read, so a role staff just made is seen.
  const roleNames = (await cachedRoles(interaction.guild_id, true)).map((r) => r.name);

  return submit(requesterOf(interaction), {
    type: 'rebrand',
    targetId: '',
    // The emote is kept as Discord sends it, so the card and replies show it;
    // approval writes it to the Gyms tab as staff would type it.
    change: () => ({ name, abbreviation, emote: emote.display }),
    check: (league, gym, change) => {
      if (gym.name === name && gym.abbreviation.toUpperCase() === abbreviation && gym.emote === emote.sheet) {
        return `${escapeMarkdown(gym.name)} already has that name, abbreviation and emote, so there's nothing to request.`;
      }
      return checkRebrand(league, gym, change, roleNames);
    },
  });
};

// Disband asks twice before making the request (Roster Spec: "Commands").
// Nothing is written until the second confirm. Both prompts are private, so
// only the leader who ran the command can press their buttons.
const disband: CommandHandler = async (interaction) => {
  const ready = await disbandable(requesterOf(interaction));
  if (typeof ready === 'string') return ready;
  return {
    reply:
      `You are about to disband ${await gymLine(interaction.guild_id, ready)}. All Trainers will be removed from the gym ` +
      'and the gym will be removed from GGB. Are you sure you want to disband?',
    components: disbandButtons(ready.gym_id, 'confirm', 'Disband'),
  };
};

// The requester's gym when they could request a disband now, else why not.
async function disbandable(requester: Requester, gymId?: string): Promise<Gym | string> {
  const league = await loadLeague();
  const checked = checkRequester(league, requester.id, ['leader']);
  if ('refusal' in checked) return checked.refusal;
  // The prompt named a gym; if they now lead another, they start again.
  if (gymId && checked.gym.gym_id !== gymId) return "You're no longer that gym's leader. Run /gym disband again.";
  return checkDisband(league, checked.gym) ?? checked.gym;
}

const gymLine = async (guildId: string, gym: Gym) =>
  `${gym.emote ? `${await renderEmote(guildId, gym.emote)} ` : ''}**${escapeMarkdown(gym.name)}**`;

const disbandButtons = (gymId: string, step: 'confirm' | 'final', label: string): ActionRow[] => [
  {
    type: 1,
    components: [
      { type: 2, style: 4, label, custom_id: `disband:${step}:${gymId}` },
      { type: 2, style: 2, label: 'Cancel', custom_id: 'disband:cancel' },
    ],
  },
];

// The buttons on the two disband prompts.
export const handleDisbandButton: ComponentHandler = async (interaction): Promise<ComponentResult> => {
  const [, step, gymId] = interaction.data.custom_id.split(':');
  const requester = requesterOf(interaction);
  if (step === 'cancel') return { message: 'Disband cancelled. Nothing was requested.' };

  if (step === 'confirm') {
    const ready = await disbandable(requester, gymId);
    if (typeof ready === 'string') return { message: ready };
    return {
      message: 'Last chance. Are you certain you want to disband?',
      components: disbandButtons(gymId, 'final', 'Yes, disband'),
    };
  }

  const result = await submit(requester, {
    type: 'disband',
    targetId: '',
    change: () => ({}),
    check: (league, gym) =>
      gym.gym_id !== gymId ? "You're no longer that gym's leader. Run /gym disband again." : checkDisband(league, gym),
  });
  return typeof result === 'string' ? { message: result } : { message: result.reply, publicMessage: result.publicMessage };
};

// A gym has at most one pending rebrand or disband, so there's nothing to choose.
const cancelRequest: CommandHandler = async (interaction) => {
  const requester = requesterOf(interaction);
  const league = await loadLeague();
  const checked = checkRequester(league, requester.id, ['leader']);
  if ('refusal' in checked) return checked.refusal;
  const found = league.requests.find(
    (r) => r.values.gym_id === checked.gym.gym_id && isGymRequest(r.values.type) && r.values.status === 'pending',
  );
  if (!found) return `${escapeMarkdown(checked.gym.name)} has no pending rebrand or disband request.`;
  return cancel(requester, found, ['leader'], `${escapeMarkdown(checked.gym.name)}'s ${found.values.type} request`);
};
