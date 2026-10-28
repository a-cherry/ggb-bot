// Approve and Reject on a staff approval card (Spec: "Approval").
import { getLeagueConfig } from '../config.js';
import { cachedRoles, displayName, getMember, postMessage, type Member } from '../discord.js';
import type { ComponentHandler, ComponentInteraction, ComponentResult } from '../interactions.js';
import { withLock } from '../locks.js';
import { appendRows, readTabs, updateRows, type Row, type SheetRow } from '../sheet-rows.js';
import { rebuildViews } from '../views.js';
import { checkAdd, checkRequester, type Leadership } from './checks.js';
import { applyRoleChanges, type RoleChange } from './discord-roles.js';
import { findGym, gymName, loadLeague, mention, type Gym, type League } from './league.js';
import { parseChange, type RequestType, type RosterRequest } from './requests.js';

async function isStaff(guildId: string, member: Member): Promise<boolean> {
  const staff = new Set(getLeagueConfig().staffRoles);
  const roles = await cachedRoles(guildId);
  return member.roles.some((id) => staff.has(roles.find((r) => r.id === id)?.name ?? ''));
}

export const handleDecision: ComponentHandler = async (interaction) => {
  const [action, requestId] = interaction.data.custom_id.split(':');
  if (!(await isStaff(interaction.guild_id, interaction.member))) {
    return { reply: 'Only staff can approve or reject roster requests.' };
  }

  // The request's gym picks the lock; everything is read again once it's held.
  const [requests] = await readTabs('rosterRequests');
  const found = requests.find((r) => r.values.request_id === requestId);
  if (!found) return { reply: `${requestId} isn't in the Roster requests tab.` };

  // Approvals for one gym run one at a time, so two can't both pass the
  // non-playing limit or both change leadership. Rejects take it too, so a
  // reject can't land in the middle of an approval of the same request.
  return withLock(`gym:${found.values.gym_id}`, () => decide(interaction, requestId, action === 'approve'));
};

// The card's text plus its outcome line; the runner removes the buttons.
const withOutcome = (card: string, outcome: string) => `${card}\n${outcome}`;

function outcomeLine(req: RosterRequest): string {
  switch (req.status) {
    case 'approved': return '**Approved**';
    case 'rejected': return '**Rejected**';
    case 'cancelled': return '**Cancelled**';
    default: return `**Refused**: ${req.refusal_message}`;
  }
}

async function decide(interaction: ComponentInteraction, requestId: string, approve: boolean): Promise<ComponentResult> {
  const league = await loadLeague();
  const row = league.requests.find((r) => r.values.request_id === requestId)!;
  const card = interaction.message.content;
  if (row.values.status !== 'pending') {
    return {
      message: withOutcome(card, outcomeLine(row.values)),
      reply: `${requestId} was already ${row.values.status}.`,
    };
  }

  const decided: RosterRequest = {
    ...row.values,
    decided_by: interaction.member.user.id,
    decided_at: new Date().toISOString(),
  };
  const finish = async (req: RosterRequest) => {
    await updateRows('rosterRequests', [{ rowNumber: row.rowNumber, values: req }]);
    return { message: withOutcome(card, outcomeLine(req)) };
  };

  if (!approve) return finish({ ...decided, status: 'rejected' });

  const outdated = outdatedReason(league, row.values);
  if (outdated) return finish({ ...decided, status: 'outdated', refusal_message: outdated });

  const gym = findGym(league, row.values.gym_id)!; // the requester check above guarantees an active gym
  const refusal = recheck(league, row.values, gym);
  if (refusal) return finish({ ...decided, status: 'refused', refusal_message: refusal });

  const { announcement, roles } = await apply(interaction.guild_id, league, row.values, gym);
  // Last write: if the bot dies before this, crash recovery finishes the request.
  const result = await finish({ ...decided, status: 'approved' });

  await rebuildViews();
  const roleFailure = await applyRoleChanges(interaction.guild_id, roles);
  await announce(announcement);
  return roleFailure ? { message: `${result.message}\nDiscord roles not updated: ${roleFailure}` } : result;
}

function requiredLeadership(req: RosterRequest): Leadership[] {
  switch (req.type as RequestType) {
    case 'add':
      return ['leader', 'manager'];
    default:
      throw new Error(`approving ${req.type} requests isn't built yet`);
  }
}

// A member with no Trainers row compares as the row an add would create for them.
const NO_ROW = { gym_id: '', role: 'trainer', leadership: 'none', status: 'active' };

// The target changed since the request was made, or the requester can no
// longer make it: the request is outdated rather than re-checked.
function outdatedReason(league: League, req: RosterRequest): string | undefined {
  const row = league.trainers.find((t) => t.values.discord_id === req.target)?.values;
  const now = row ?? NO_ROW;
  const then = req.snapshot_status
    ? { gym_id: req.snapshot_gym_id, role: req.snapshot_role, leadership: req.snapshot_leadership, status: req.snapshot_status }
    : NO_ROW;
  const plain = (v: string) => v;
  const fields: [string, string, string, (v: string) => string][] = [
    ['gym', then.gym_id, now.gym_id, (id) => (id ? gymName(league, id) : 'none')],
    ['role', then.role, now.role, plain],
    ['leadership', then.leadership, now.leadership, plain],
    ['status', then.status, now.status, plain],
  ];
  const changed = fields
    .filter(([, before, after]) => before !== after)
    .map(([name, before, after, fmt]) => `${name} changed from ${fmt(before)} to ${fmt(after)}`);
  if (changed.length) return `${mention(req.target)}'s ${changed.join(', ')} since the request was made.`;

  const requester = checkRequester(league, req.requester, requiredLeadership(req));
  if ('refusal' in requester || requester.gym.gym_id !== req.gym_id) {
    return `${mention(req.requester)} can no longer make this request for ${gymName(league, req.gym_id)}.`;
  }
  return undefined;
}

function recheck(league: League, req: RosterRequest, gym: Gym): string | undefined {
  const change = parseChange(req.change);
  switch (req.type as RequestType) {
    case 'add':
      return checkAdd(league, req.target, gym, change.role, req.request_id);
    default:
      throw new Error(`approving ${req.type} requests isn't built yet`);
  }
}

interface Applied {
  announcement: string;
  roles: RoleChange[]; // Discord roles to change once the request is approved
}

// Writes Roster history and Trainers (Spec: "What each change writes") and
// returns the announcement and role changes. Names are refreshed from Discord
// in the same write (Spec: "Refresh on touch").
async function apply(guildId: string, league: League, req: RosterRequest, gym: Gym): Promise<Applied> {
  const change = parseChange(req.change);
  switch (req.type as RequestType) {
    case 'add': {
      const existing = league.trainers.find((t) => t.values.discord_id === req.target);
      const before = existing?.values;
      const member = await getMember(guildId, req.target);
      const after: Row<'trainers'> = {
        discord_id: req.target,
        server_nickname: member ? displayName(member) : before?.server_nickname ?? '',
        username: member ? member.user.username : before?.username ?? '',
        country: before?.country ?? '',
        gym_id: gym.gym_id,
        role: change.role,
        leadership: 'none',
        status: before?.status ?? 'active',
      };
      await appendRows('rosterHistory', [historyRow(league, req, before, after)]);
      await writeTrainer(existing, after);
      const { roles } = getLeagueConfig();
      return {
        announcement: `${emotePrefix(gym)}**${gym.name}** has added ${mention(req.target)} to their roster`,
        roles: [{
          userId: req.target,
          add: [gym.name, roles.participatingTrainer, ...(change.role === 'non-playing' ? [roles.nonPlayer] : [])],
          remove: [],
        }],
      };
    }
    default:
      throw new Error(`approving ${req.type} requests isn't built yet`);
  }
}

const writeTrainer = (existing: SheetRow<'trainers'> | undefined, after: Row<'trainers'>) =>
  existing ? updateRows('trainers', [{ rowNumber: existing.rowNumber, values: after }]) : appendRows('trainers', [after]);

function historyRow(
  league: League, req: RosterRequest, before: Row<'trainers'> | undefined, after: Row<'trainers'>,
): Row<'rosterHistory'> {
  return {
    season: league.season ? String(league.season.season) : '',
    timestamp: new Date().toISOString(),
    discord_id: after.discord_id,
    before_gym_id: before?.gym_id ?? '',
    before_role: before?.role ?? '',
    before_leadership: before?.leadership ?? '',
    after_gym_id: after.gym_id,
    after_role: after.role,
    after_leadership: after.leadership,
    source: 'request',
    request_id: req.request_id,
  };
}

const emotePrefix = (gym: Gym) => (gym.emote ? `${gym.emote} ` : '');

async function announce(text: string): Promise<void> {
  const channelId = process.env.DISCORD_TRANSFER_ANNOUNCEMENTS_CHANNEL_ID;
  if (!channelId) {
    console.error('DISCORD_TRANSFER_ANNOUNCEMENTS_CHANNEL_ID is not set; announcement not posted:', text);
    return;
  }
  try {
    await postMessage(channelId, text);
  } catch (err) {
    console.error('transfer announcement failed to post:', text, err);
  }
}
