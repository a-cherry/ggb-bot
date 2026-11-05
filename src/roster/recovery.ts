// Recovery of approvals that stopped partway (Roster Spec: "When
// something fails"). An approval's first write stamps decided_by on the
// still-pending request; its last marks it approved. A pending request with
// decided_by set stopped in between, because the bot died or a call failed:
// one that had written nothing goes back to pending, and one that had started
// writing is finished without re-checking.
import { getLeagueConfig } from '../config.js';
import { displayName, getMember, sheetEmote } from '../discord.js';
import { withLock } from '../locks.js';
import { appendRows, updateRows, type Row, type SheetRow } from '../sheet-rows.js';
import { afterApproval, announcementFor, closeGym, crashPoint, outcomeLine } from './approval.js';
import { FAN_SUFFIX } from './checks.js';
import type { RoleChange } from './discord-roles.js';
import { findGym, gymName, loadLeague, type Gym, type League, type Trainer } from './league.js';
import { closeApprovalCard, closeCard, parseChange, processingCards, reopenCard, type RosterRequest } from './requests.js';

type History = Row<'rosterHistory'>;

// An approval claimed this recently may still be running in the process that
// is stopping for a deploy. Render's disk keeps deploys from overlapping, but
// if they ever do, the old process lives up to 60 seconds after the new one
// takes traffic, then drains (DRAIN_MS in server.ts), with room to spare for a
// longer shutdown delay. Startup leaves it until it's this old.
const SETTLE_MS = 150_000;

export async function recoverApprovals(guildId: string): Promise<void> {
  const league = await loadLeague();
  const started = league.requests.filter((r) => r.values.status === 'pending' && r.values.decided_by);
  for (const { values } of started) {
    const wait = SETTLE_MS - (Date.now() - Date.parse(values.decided_at));
    if (wait > 0) {
      console.log(`${values.request_id}: approval claimed ${Math.round((SETTLE_MS - wait) / 1000)}s ago; recovering it in ${Math.ceil(wait / 1000)}s`);
      setTimeout(() => void recoverOne(guildId, values.request_id, values.gym_id), wait);
      continue;
    }
    await recoverOne(guildId, values.request_id, values.gym_id);
  }
}

async function recoverOne(guildId: string, requestId: string, gymId: string): Promise<void> {
  try {
    await withLock(`gym:${gymId}`, async () => {
      const outcome = await recoverRequest(guildId, requestId);
      if (!outcome) {
        await settleProcessingCards(requestId);
      } else if (!(await closeApprovalCard(requestId, outcome))) {
        console.error(`${requestId}: staff card not found to mark approved`);
      }
    });
  } catch (err) {
    console.error(`${requestId}: crash recovery failed:`, err);
  }
}

// Cards a stopped process left on the processing line, or just `requestId`'s.
// Run only when no press can be in progress on them: at startup, or under the
// gym's lock. A claimed request is left to recovery, which closes its card.
export async function settleProcessingCards(requestId?: string): Promise<void> {
  try {
    const cards = (await processingCards()).filter((c) => !requestId || c.requestId === requestId);
    if (!cards.length) return;
    const { requests } = await loadLeague();
    for (const card of cards) {
      const req = requests.find((r) => r.values.request_id === card.requestId)?.values;
      if (!req || (req.status === 'pending' && req.decided_by)) continue;
      try {
        if (req.status === 'pending') await reopenCard(card);
        else await closeCard(card, stoppedOutcome(req));
      } catch (err) {
        console.error(`${card.requestId}: staff card could not be settled:`, err);
      }
    }
  } catch (err) {
    console.error('settling staff cards failed:', err);
  }
}

// An approved request's roles and announcement may not have happened: the bot
// can't tell how far past the approved mark it got (Roster Spec: "Not recovered").
const stoppedOutcome = (req: RosterRequest) =>
  req.status === 'approved'
    ? `${outcomeLine(req)}\nThe bot stopped during this approval: check the Discord roles and the announcement.`
    : outcomeLine(req);

// Finishes or resets one stopped approval; the caller holds the gym's lock.
// Returns the card's outcome lines when it finished the approval, or nothing
// when the request is plain pending again or no longer needs recovering.
export async function recoverRequest(guildId: string, requestId: string): Promise<string | undefined> {
  crashPoint('recovery');
  // Read again for each request: finishing one can change what the next sees.
  const league = await loadLeague();
  const row = league.requests.find((r) => r.values.request_id === requestId)!;
  const req = row.values;
  // Already finished, e.g. by a staff button press while recovery waited.
  if (req.status !== 'pending' || !req.decided_by) return undefined;
  const gym = findGym(league, req.gym_id)!;
  const history = league.history.map((h) => h.values).filter((h) => h.request_id === requestId);

  if (!started(req, gym, history)) {
    // Staff approve it again from its card; the caller puts back any buttons a press removed.
    await updateRows('rosterRequests', [{ rowNumber: row.rowNumber, values: { ...req, decided_by: '', decided_at: '' } }]);
    console.log(`${requestId}: the approval stopped before it wrote anything; it's pending again`);
    return undefined;
  }

  // History is written in one call before anything else, so it holds every
  // trainer's intended values; writing them again is harmless.
  await reapplyTrainers(guildId, league, history);
  const outdated = req.type === 'disband' ? await closeGym(league, req, gym) : [];
  const approved: RosterRequest = { ...req, status: 'approved' };
  await updateRows('rosterRequests', [{ rowNumber: row.rowNumber, values: approved }]);
  console.log(`${requestId}: finished an approval that stopped partway`);

  const change = parseChange(req.change);
  // The claim write kept a rebrand's old name and emote; the Gyms row already has the new ones.
  const before: Gym = req.type === 'rebrand' ? { ...gym, name: change.old_name, emote: change.old_emote } : gym;
  const problems = await afterApproval(guildId, {
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

  return [outcomeLine(approved), ...problems].join('\n');
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
// gives the same roles as the Roster Spec's "What each change does" table for every request type.
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
    toggle(roles.gymViceLeader, h.before_leadership === 'vice-leader', h.after_leadership === 'vice-leader');
    return change;
  });
}
