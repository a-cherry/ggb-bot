// Approve and Reject on a staff approval card (Roster Spec: "Approval").
import { getLeagueConfig } from '../config.js';
import { cachedRoles, displayName, escapeMarkdown, getMember, postMessage, renderEmote, sheetEmote, type Member } from '../discord.js';
import type { ComponentHandler, ComponentInteraction, ComponentResult } from '../interactions.js';
import { withLock } from '../locks.js';
import { appendRows, updateRows, type Row, type SheetRow } from '../sheet-rows.js';
import { rebuildViews } from '../views.js';
import {
  checkAdd, checkDisband, checkRebrand, checkRemove, checkRequester, checkUpdate, FAN_SUFFIX, leadershipFor,
} from './checks.js';
import { applyRoleChanges, renameRoles, type RoleChange, type RoleRename } from './discord-roles.js';
import { findGym, gymName, loadLeague, mention, requestInfo, type Gym, type League, type Trainer } from './league.js';
import {
  closeApprovalCards, describeUpdate, formatChange, isGymRequest, leadershipTitle, parseChange, playerOrCoach, type RequestType, type RosterRequest,
} from './requests.js';
import { recoverRequest } from './recovery.js';

// By role ID, not name: anyone who can create or rename a role could give one a staff role's name.
export function isStaff(member: Member): boolean {
  const staff = new Set((process.env.DISCORD_STAFF_ROLE_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  if (!staff.size) throw new Error('DISCORD_STAFF_ROLE_IDS is not set');
  return member.roles.some((id) => staff.has(id));
}

export const handleDecision: ComponentHandler = async (interaction) => {
  const [action, requestId] = interaction.data.custom_id.split(':');
  if (!isStaff(interaction.member)) {
    return { reply: 'Only staff can approve or reject roster requests.' };
  }

  // The request's gym picks the lock; everything is read again once it's held.
  const info = await requestInfo(requestId);
  if (!info) return { reply: `${requestId} isn't in the Roster requests tab.` };

  // Approvals for one gym run one at a time, so two can't both pass the
  // non-playing limit or both change leadership. Rejects take it too, so a
  // reject can't land in the middle of an approval of the same request.
  const run = () => decide(interaction, requestId, action === 'approve');
  // Rebrands of different gyms also run one at a time, so two can't take the same name.
  return withLock(`gym:${info.gym_id}`, () => (info.type === 'rebrand' ? withLock('rebrand', run) : run()));
};

// The card's text plus its outcome line; the runner removes the buttons.
const withOutcome = (card: string, outcome: string) => `${card}\n${outcome}`;

export function outcomeLine(req: RosterRequest): string {
  switch (req.status) {
    case 'approved': return `**Approved** by ${mention(req.decided_by)}`;
    case 'rejected': return `**Rejected** by ${mention(req.decided_by)}`;
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
  // An approval that stopped partway: finish it rather than check it again,
  // since its trainers may already have moved. Reject finishes it too.
  if (row.values.decided_by) {
    const outcome = await recoverRequest(interaction.guild_id, requestId);
    // Nothing had been written, so it's plain pending again: decide it as usual.
    if (!outcome) return decide(interaction, requestId, approve);
    return {
      message: withOutcome(card, outcome),
      reply: approve ? undefined : `${requestId} was already partly approved, so the approval was finished instead.`,
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
  // Re-read for a rebrand, so a role staff just made is seen; nothing else uses them.
  const roleNames = row.values.type === 'rebrand' ? (await cachedRoles(interaction.guild_id, true)).map((r) => r.name) : [];
  const refusal = recheck(league, row.values, gym, roleNames);
  if (refusal) return finish({ ...decided, status: 'refused', refusal_message: refusal });

  // First write: marks the approval as started, so if the bot dies before the
  // last write, crash recovery finds it (Roster Spec: "When something fails"). A rebrand also keeps
  // the gym's old name and emote here, for the announcement.
  const claimed: RosterRequest = { ...decided, change: claimChange(decided, gym) };
  await updateRows('rosterRequests', [{ rowNumber: row.rowNumber, values: claimed }]);

  let applied: Applied;
  let result: ComponentResult;
  try {
    crashPoint('claimed');
    applied = await apply(interaction.guild_id, league, claimed, gym);
    crashPoint('written');
    // Last write: if the approval stops before this, recovery finishes the request.
    result = await finish({ ...claimed, status: 'approved' });
  } catch (err) {
    return stoppedPartway(interaction.guild_id, requestId, card, err);
  }
  crashPoint('approved');

  const problems = await afterApproval(interaction.guild_id, applied);
  return problems.length ? { message: [result.message, ...problems].join('\n') } : result;
}

// A call failed between the claim and the approved mark. Recovery finishes the
// approval now if it can; otherwise the request stays claimed, and the next
// Approve or Reject press finishes it.
async function stoppedPartway(guildId: string, requestId: string, card: string, err: unknown): Promise<ComponentResult> {
  console.error(`${requestId}: approval stopped partway:`, err);
  try {
    const outcome = await recoverRequest(guildId, requestId);
    if (outcome) return { message: withOutcome(card, outcome) };
    return { reply: `${requestId}'s approval failed before it changed anything, so it's pending again. Press Approve to try again.` };
  } catch (err2) {
    console.error(`${requestId}: finishing the stopped approval failed:`, err2);
    return { reply: `${requestId}'s approval stopped partway. Press Approve again to finish it.` };
  }
}

function claimChange(req: RosterRequest, gym: Gym): string {
  if (req.type !== 'rebrand') return req.change;
  return formatChange({ ...parseChange(req.change), old_name: gym.name, old_emote: gym.emote });
}

// For testing failures in development. GGB_CRASH_AT=claimed, history, written,
// approved or recovery stops the bot at that point. GGB_FAIL_AT, a comma-separated list
// of those points, card (posting a new request's staff card), views, role (one
// member's role) or announce, throws once at each, as a failed Sheets or
// Discord call would.
const failed = new Set<string>();
export function crashPoint(
  point: 'claimed' | 'history' | 'written' | 'approved' | 'recovery' | 'card' | 'views' | 'role' | 'announce',
): void {
  if (process.env.GGB_CRASH_AT === point) {
    console.error(`GGB_CRASH_AT=${point}: stopping the bot mid-approval`);
    process.exit(1);
  }
  if ((process.env.GGB_FAIL_AT ?? '').split(',').includes(point) && !failed.has(point)) {
    failed.add(point);
    throw new Error(`GGB_FAIL_AT=${point}: failing here once`);
  }
}

// Everything after the approved mark (Roster Spec: "Approval", step 8), apart from
// the card, which the caller edits. Each step runs even if an earlier one
// failed. Returns a line for the card for each step that failed, for staff to
// fix by hand.
export async function afterApproval(guildId: string, applied: Applied): Promise<string[]> {
  const problems: string[] = [];
  const step = async (problem: string, run: () => Promise<string | undefined>) => {
    try {
      const failure = await run();
      if (failure) problems.push(`${problem}: ${failure}`);
    } catch (err) {
      console.error(`${problem}:`, err);
      problems.push(`${problem}: an error, see the bot's log`);
    }
  };
  await step('League Stats views not rebuilt', async () => {
    crashPoint('views');
    await rebuildViews();
    return undefined;
  });
  await step('Discord roles not renamed', () => renameRoles(guildId, applied.renames ?? []));
  await step('Discord roles not updated', () => applyRoleChanges(guildId, applied.roles));
  await step('Announcement not posted', () => announce(applied.announcement));
  await step('Cards not closed', () => closeCards(applied.outdated ?? []));
  return problems;
}

// The cards of requests a disband made outdated, found in one scan of the
// staff channel. Returns the ones not closed.
async function closeCards(requests: RosterRequest[]): Promise<string | undefined> {
  if (!requests.length) return undefined;
  const notClosed = await closeApprovalCards(new Map(requests.map((r) => [r.request_id, outcomeLine(r)])));
  return notClosed.length ? `${notClosed.join(', ')}, now outdated` : undefined;
}

// A member with no Trainers row compares as the row an add would create for them.
const NO_ROW = { gym_id: '', role: 'trainer', leadership: 'none', status: 'active' };

// The target changed since the request was made, or the requester can no
// longer make it: the request is outdated rather than re-checked.
function outdatedReason(league: League, req: RosterRequest): string | undefined {
  // A rebrand or disband has no target; only the requester is re-checked.
  const row = isGymRequest(req.type) ? undefined : league.trainers.find((t) => t.values.discord_id === req.target)?.values;
  const now = row ?? NO_ROW;
  const then = req.snapshot_status
    ? { gym_id: req.snapshot_gym_id, role: req.snapshot_role, leadership: req.snapshot_leadership, status: req.snapshot_status }
    : NO_ROW;
  const plain = (v: string) => v;
  const fields: [string, string, string, (v: string) => string][] = [
    ['gym', then.gym_id, now.gym_id, (id) => (id ? escapeMarkdown(gymName(league, id)) : 'none')],
    ['role', then.role, now.role, playerOrCoach],
    ['leadership', then.leadership, now.leadership, (v) => leadershipTitle(v) ?? v],
    ['status', then.status, now.status, plain],
  ];
  const changed = (isGymRequest(req.type) ? [] : fields)
    .filter(([, before, after]) => before !== after)
    .map(([name, before, after, fmt]) => `${name} changed from ${fmt(before)} to ${fmt(after)}`);
  if (changed.length) return `${mention(req.target)}'s ${changed.join(', ')} since the request was made.`;

  const allowed = leadershipFor(req.type as RequestType, parseChange(req.change), row);
  const requester = checkRequester(league, req.requester, allowed);
  if ('refusal' in requester || requester.gym.gym_id !== req.gym_id) {
    return `${mention(req.requester)} can no longer make this request for ${escapeMarkdown(gymName(league, req.gym_id))}.`;
  }
  return undefined;
}

function recheck(league: League, req: RosterRequest, gym: Gym, roleNames: string[]): string | undefined {
  const change = parseChange(req.change);
  switch (req.type as RequestType) {
    case 'add':
      return checkAdd(league, req.target, gym, change.role, req.request_id);
    case 'remove':
      return checkRemove(league, req.target, gym, req.request_id);
    case 'update-trainer':
      return checkUpdate(league, req.target, gym, change, req.request_id);
    case 'rebrand':
      return checkRebrand(league, gym, change, roleNames, req.request_id);
    case 'disband':
      return checkDisband(league, gym, req.request_id);
  }
}

export interface Applied {
  announcement: string;
  roles: RoleChange[]; // Discord roles to change once the request is approved
  renames?: RoleRename[];
  outdated?: RosterRequest[]; // other requests the approval made outdated, whose cards need closing
}

// Writes Roster history and Trainers (Roster Spec: "What each change does") and
// returns the announcement and role changes (same section). `req`
// carries who decided and when, for requests a disband makes outdated.
async function apply(guildId: string, league: League, req: RosterRequest, gym: Gym): Promise<Applied> {
  // The members writeTrainers reads for their names; their roles let the role
  // changes skip roles a member already has or doesn't hold, without reading them again.
  const members = new Map<string, Member | undefined>();
  const applied = await applyChange(guildId, league, req, gym, members);
  return {
    ...applied,
    roles: applied.roles.map((c) => (members.has(c.userId) ? { ...c, member: members.get(c.userId) ?? null } : c)),
  };
}

async function applyChange(
  guildId: string, league: League, req: RosterRequest, gym: Gym, members: Map<string, Member | undefined>,
): Promise<Applied> {
  const change = parseChange(req.change);
  const { roles } = getLeagueConfig();
  const announcement = await announcementFor(guildId, req, gym);
  switch (req.type as RequestType) {
    case 'add': {
      await writeTrainers(guildId, league, req, members, [
        { discordId: req.target, set: { gym_id: gym.gym_id, role: change.role, leadership: 'none' } },
      ]);
      return {
        announcement,
        roles: [{
          userId: req.target,
          add: [gym.name, roles.participatingTrainer, ...(change.role === 'non-playing' ? [roles.nonPlayer] : [])],
          remove: [],
        }],
      };
    }
    case 'remove': {
      await writeTrainers(guildId, league, req, members, [
        { discordId: req.target, set: { gym_id: '', role: 'trainer', leadership: 'none' } },
      ]);
      return {
        announcement,
        // They keep Participating Trainer: with no gym role, that reads as a free agent.
        roles: [{ userId: req.target, add: [], remove: [gym.name, roles.gymLeader, roles.gymViceLeader, roles.nonPlayer] }],
      };
    }
    case 'update-trainer': {
      const set: Partial<Trainer> = {};
      const target: RoleChange = { userId: req.target, add: [], remove: [] };
      const others: TrainerChange[] = [];
      const otherRoles: RoleChange[] = [];
      if (change.role) {
        set.role = change.role;
        (change.role === 'non-playing' ? target.add : target.remove).push(roles.nonPlayer);
      }
      if (change.leadership === 'vice-leader') {
        set.leadership = 'vice-leader';
        target.add.push(roles.gymViceLeader);
        // The current vice-leader steps down.
        for (const { values: t } of league.trainers) {
          if (t.gym_id === gym.gym_id && t.leadership === 'vice-leader' && t.discord_id !== req.target) {
            others.push({ discordId: t.discord_id, set: { leadership: 'none' } });
            otherRoles.push({ userId: t.discord_id, add: [], remove: [roles.gymViceLeader] });
          }
        }
      } else if (change.leadership === 'leader') {
        set.leadership = 'leader';
        target.add.push(roles.gymLeader);
        target.remove.push(roles.gymViceLeader);
        // The requester hands off; the outdated check confirmed they're still this gym's leader.
        others.push({ discordId: req.requester, set: { leadership: 'none' } });
        otherRoles.push({ userId: req.requester, add: [], remove: [roles.gymLeader] });
      } else if (change.leadership === 'none') {
        set.leadership = 'none';
        target.remove.push(roles.gymViceLeader);
      }
      await writeTrainers(guildId, league, req, members, [{ discordId: req.target, set }, ...others]);
      return {
        announcement,
        roles: [target, ...otherRoles],
      };
    }
    case 'rebrand': {
      // Every other tab refers to the gym by gym_id, so only the Gyms row changes.
      const rebranded: Gym = { ...gym, name: change.name, abbreviation: change.abbreviation, emote: sheetEmote(change.emote) };
      await updateGym(league, rebranded);
      return {
        announcement,
        roles: [],
        // Renamed, not replaced: members keep the role, and any channel access it grants.
        renames: [
          { from: gym.name, to: change.name },
          { from: `${gym.name}${FAN_SUFFIX}`, to: `${change.name}${FAN_SUFFIX}`, optional: true },
        ],
      };
    }
    case 'disband': {
      const onGym = league.trainers.map((t) => t.values).filter((t) => t.gym_id === gym.gym_id);
      await writeTrainers(guildId, league, req, members, onGym.map((t) => ({
        discordId: t.discord_id,
        set: { gym_id: '', role: 'trainer', leadership: 'none' },
      })));
      const outdated = await closeGym(league, req, gym);
      return {
        announcement,
        // The gym role itself is kept; members keep Participating Trainer, as on a remove.
        roles: onGym.map((t) => ({
          userId: t.discord_id,
          add: [],
          remove: [gym.name, roles.gymLeader, roles.gymViceLeader, roles.nonPlayer],
        })),
        outdated,
      };
    }
  }
}

// A disband's Gyms write: the gym becomes inactive, and its other pending
// requests, which can no longer be approved, become outdated. Returns those.
export async function closeGym(league: League, req: RosterRequest, gym: Gym): Promise<RosterRequest[]> {
  await updateGym(league, { ...gym, status: 'inactive' });
  const outdated = league.requests
    .filter((r) => r.values.gym_id === gym.gym_id && r.values.status === 'pending' && r.values.request_id !== req.request_id)
    .map((r) => ({
      rowNumber: r.rowNumber,
      values: {
        ...r.values,
        status: 'outdated',
        decided_by: req.decided_by,
        decided_at: req.decided_at,
        refusal_message: `${escapeMarkdown(gym.name)} was disbanded (${req.request_id}).`,
      },
    }));
  await updateRows('rosterRequests', outdated);
  return outdated.map((r) => r.values);
}

// The transfer announcement (Roster Spec: "Announcements"). `gym` is the gym as it was
// before the request: a rebrand announces its old name and emote.
export async function announcementFor(guildId: string, req: RosterRequest, gym: Gym): Promise<string> {
  const change = parseChange(req.change);
  const gymLine = `${await emotePrefix(guildId, gym)}**${escapeMarkdown(gym.name)}**`;
  switch (req.type as RequestType) {
    case 'add':
      return `${gymLine} has added ${mention(req.target)} to their roster`;
    case 'remove':
      return `${gymLine} has removed ${mention(req.target)} from their roster`;
    case 'update-trainer':
      return `${gymLine} has ${describeUpdate(req, true)}`;
    case 'rebrand':
      return `${gymLine} has rebranded to ${change.emote} **${escapeMarkdown(change.name)}**`;
    case 'disband':
      return `${gymLine} has disbanded`;
  }
}

export async function updateGym(league: League, gym: Gym): Promise<void> {
  const row = league.gyms.find((g) => g.values.gym_id === gym.gym_id)!;
  await updateRows('gyms', [{ rowNumber: row.rowNumber, values: gym }]);
}

interface TrainerChange {
  discordId: string;
  set: Partial<Trainer>; // the columns that change
}

// One Roster history row per changed trainer, then their Trainers rows. A member
// with no Trainers row gets one. Names are refreshed from Discord in the same
// write (Bot Spec: "Nickname sync"); the members read are kept in `members`.
async function writeTrainers(
  guildId: string, league: League, req: RosterRequest, members: Map<string, Member | undefined>, changes: TrainerChange[],
): Promise<void> {
  const history: Row<'rosterHistory'>[] = [];
  const updates: SheetRow<'trainers'>[] = [];
  const appends: Trainer[] = [];
  for (const c of changes) {
    const existing = league.trainers.find((t) => t.values.discord_id === c.discordId);
    const before = existing?.values;
    const member = await getMember(guildId, c.discordId);
    members.set(c.discordId, member);
    const after: Trainer = {
      discord_id: c.discordId,
      server_nickname: member ? displayName(member) : before?.server_nickname ?? '',
      username: member ? member.user.username : before?.username ?? '',
      country: before?.country ?? '',
      gym_id: before?.gym_id ?? '',
      role: before?.role ?? 'trainer',
      leadership: before?.leadership ?? 'none',
      status: before?.status ?? 'active',
      ...c.set,
    };
    // Someone the nickname sync marked inactive when they left the server is active again once on a gym.
    if (after.gym_id && after.status === 'inactive') after.status = 'active';
    history.push(historyRow(league, req, before, after));
    if (existing) updates.push({ rowNumber: existing.rowNumber, values: after });
    else appends.push(after);
  }
  await appendRows('rosterHistory', history);
  crashPoint('history');
  await updateRows('trainers', updates);
  await appendRows('trainers', appends);
}

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

const emotePrefix = async (guildId: string, gym: Gym) => (gym.emote ? `${await renderEmote(guildId, gym.emote)} ` : '');

async function announce(text: string): Promise<string | undefined> {
  const channelId = process.env.DISCORD_TRANSFER_ANNOUNCEMENTS_CHANNEL_ID;
  if (!channelId) return 'DISCORD_TRANSFER_ANNOUNCEMENTS_CHANNEL_ID is not set';
  crashPoint('announce');
  await postMessage(channelId, text);
  return undefined;
}
