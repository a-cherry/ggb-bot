// Crash recovery (Spec: "Approve", step 6). An approval's first write stamps
// decided_by on the still-pending request; its last marks it approved. On
// startup, a pending request with decided_by set was mid-approval when the bot
// stopped: one that had written nothing goes back to pending, and one that had
// started writing is finished without re-checking.
import { getLeagueConfig } from '../config.js';
import { displayName, getMember, sheetEmote } from '../discord.js';
import { withLock } from '../locks.js';
import { appendRows, updateRows, type Row, type SheetRow } from '../sheet-rows.js';
import { afterApproval, announcementFor, closeGym, outcomeLine } from './approval.js';
import { FAN_SUFFIX } from './checks.js';
import type { RoleChange } from './discord-roles.js';
import { findGym, gymName, loadLeague, type Gym, type League, type Trainer } from './league.js';
import { closeApprovalCard, parseChange, type RosterRequest } from './requests.js';

type History = Row<'rosterHistory'>;

export async function recoverApprovals(guildId: string): Promise<void> {
  const league = await loadLeague();
  const started = league.requests.filter((r) => r.values.status === 'pending' && r.values.decided_by);
  for (const { values } of started) {
    try {
      await withLock(`gym:${values.gym_id}`, () => recover(guildId, values.request_id));
    } catch (err) {
      console.error(`${values.request_id}: crash recovery failed:`, err);
    }
  }
}

async function recover(guildId: string, requestId: string): Promise<void> {
  // Read again for each request: finishing one can change what the next sees.
  const league = await loadLeague();
  const row = league.requests.find((r) => r.values.request_id === requestId)!;
  const req = row.values;
  const gym = findGym(league, req.gym_id)!;
  const history = league.history.map((h) => h.values).filter((h) => h.request_id === requestId);

  if (!started(req, gym, history)) {
    // Staff approve it again from its card, which still has its buttons.
    await updateRows('rosterRequests', [{ rowNumber: row.rowNumber, values: { ...req, decided_by: '', decided_at: '' } }]);
    console.log(`${requestId}: the bot stopped before this approval wrote anything; it's pending again`);
    return;
  }

  // History is written in one call before anything else, so it holds every
  // trainer's intended values; writing them again is harmless.
  await reapplyTrainers(guildId, league, history);
  const outdated = req.type === 'disband' ? await closeGym(league, req, gym) : [];
  const approved: RosterRequest = { ...req, status: 'approved' };
  await updateRows('rosterRequests', [{ rowNumber: row.rowNumber, values: approved }]);
  console.log(`${requestId}: finished an approval the bot stopped in the middle of`);

  const change = parseChange(req.change);
  // The claim write kept a rebrand's old name and emote; the Gyms row already has the new ones.
  const before: Gym = req.type === 'rebrand' ? { ...gym, name: change.old_name, emote: change.old_emote } : gym;
  const roleFailure = await afterApproval(guildId, {
    announcement: await announcementFor(guildId, req, before),
    roles: roleChanges(league, history),
    renames: req.type === 'rebrand'
      ? [
          { from: change.old_name, to: change.name },
          { from: `${change.old_name}${FAN_SUFFIX}`, to: `${change.name}${FAN_SUFFIX}`, optional: true },
        ]
      : [],
    // Outdated by this disband, whether just now or before the bot stopped.
    outdated: [
      ...outdated,
      ...league.requests
        .map((r) => r.values)
        .filter((r) => r.status === 'outdated' && r.refusal_message.endsWith(`(${requestId}).`)),
    ],
  });

  const outcome = [outcomeLine(approved), ...(roleFailure ? [`Discord roles not updated: ${roleFailure}`] : [])];
  try {
    if (!(await closeApprovalCard(requestId, outcome.join('\n')))) console.error(`${requestId}: staff card not found to mark approved`);
  } catch (err) {
    console.error(`${requestId}: staff card could not be marked approved:`, err);
  }
}

// Whether the approval wrote anything to the League DB before the bot stopped.
function started(req: RosterRequest, gym: Gym, history: History[]): boolean {
  const change = parseChange(req.change);
  switch (req.type) {
    case 'rebrand': // writes only the Gyms row
      return gym.name === change.name && gym.abbreviation === change.abbreviation && gym.emote === sheetEmote(change.emote);
    case 'disband': // a gym with no trainers writes no history
      return history.length > 0 || gym.status === 'inactive';
    default:
      return history.length > 0;
  }
}

// Sets each trainer's gym, role and leadership to their history row's after
// values, creating the Trainers row an add makes if it's missing.
async function reapplyTrainers(guildId: string, league: League, history: History[]): Promise<void> {
  const updates: SheetRow<'trainers'>[] = [];
  const appends: Trainer[] = [];
  for (const h of history) {
    const set = { gym_id: h.after_gym_id, role: h.after_role, leadership: h.after_leadership };
    const existing = league.trainers.find((t) => t.values.discord_id === h.discord_id);
    if (existing) {
      const v = existing.values;
      if (v.gym_id !== set.gym_id || v.role !== set.role || v.leadership !== set.leadership) {
        updates.push({ rowNumber: existing.rowNumber, values: { ...v, ...set } });
      }
      continue;
    }
    const member = await getMember(guildId, h.discord_id);
    appends.push({
      discord_id: h.discord_id,
      server_nickname: member ? displayName(member) : '',
      username: member?.user.username ?? '',
      country: '',
      status: 'active',
      ...set,
    });
  }
  await updateRows('trainers', updates);
  await appendRows('trainers', appends);
}

// The Discord roles each history row's before and after values call for. This
// gives the same roles as the Spec's "Discord roles" table for every request type.
function roleChanges(league: League, history: History[]): RoleChange[] {
  const { roles } = getLeagueConfig();
  return history.map((h) => {
    const change: RoleChange = { userId: h.discord_id, add: [], remove: [] };
    if (h.before_gym_id !== h.after_gym_id) {
      if (h.before_gym_id) change.remove.push(gymName(league, h.before_gym_id));
      if (h.after_gym_id) change.add.push(gymName(league, h.after_gym_id), roles.participatingTrainer);
    }
    const toggle = (role: string, had: boolean, has: boolean) => {
      if (has && !had) change.add.push(role);
      if (had && !has) change.remove.push(role);
    };
    toggle(roles.nonPlayer, h.before_role === 'non-playing', h.after_role === 'non-playing');
    toggle(roles.gymLeader, h.before_leadership === 'leader', h.after_leadership === 'leader');
    toggle(roles.gymManager, h.before_leadership === 'manager', h.after_leadership === 'manager');
    return change;
  });
}
