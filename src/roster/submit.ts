// Making and cancelling roster requests, shared by /roster and /gym (Spec: "Roster requests").
import { displayName, getMember } from '../discord.js';
import type { CommandResult } from '../interactions.js';
import { withLock } from '../locks.js';
import { appendRows, readTabs, updateRows, type SheetRow } from '../sheet-rows.js';
import { crashPoint } from './approval.js';
import { checkRequester, leadershipFor, removeWarnings, type Leadership } from './checks.js';
import { findGym, findTrainer, gymName, loadLeague, type Gym, type League, type Trainer } from './league.js';
import {
  cardText, closeApprovalCard, describeChange, gymMention, isGymRequest, newRequest, postApprovalCard, postStaffNotice,
  type RequestType,
} from './requests.js';

// Who is asking, and in which server.
export interface Requester {
  id: string;
  guildId: string;
}

export interface Submission {
  type: RequestType;
  targetId: string; // blank for a rebrand or disband
  // The change column's values, or a reply when there's nothing to request.
  change: (league: League) => Record<string, string> | string;
  check: (league: League, gym: Gym, change: Record<string, string>) => string | undefined;
  warnings?: (league: League, gym: Gym) => string[];
  // The target's name on the card; left out for a rebrand or disband.
  targetName?: (target: Trainer | undefined) => string;
}

// Checks the requester and the request, writes the Roster requests row and
// posts the staff card (Spec: "On a valid request").
export async function submit(requester: Requester, s: Submission): Promise<string | CommandResult> {
  // Held from reading Roster requests to writing the new row: request IDs and the
  // "no other pending request" checks depend on no other request landing in between.
  const result = await withLock('requests', async () => {
    const league = await loadLeague();
    const target = findTrainer(league, s.targetId);
    const change = s.change(league);
    if (typeof change === 'string') return change;
    const checked = checkRequester(league, requester.id, leadershipFor(s.type, change, target));
    if ('refusal' in checked) return checked.refusal;
    const refusal = s.check(league, checked.gym, change);
    if (refusal) return refusal;

    const req = newRequest(league, s.type, requester.id, s.targetId, checked.gym.gym_id, change);
    await appendRows('rosterRequests', [req]);
    return { req, gymName: checked.gym.name, warnings: s.warnings?.(league, checked.gym) ?? [], target };
  });
  if (typeof result === 'string') return result;

  const { req, warnings, target } = result;
  let gym = result.gymName; // the plain name, if the role lookup fails
  try {
    gym = await gymMention(requester.guildId, result.gymName);
    crashPoint('card');
    await postApprovalCard(cardText(req, gym, s.targetName?.(target), warnings), req.request_id);
  } catch (err) {
    console.error(`${req.request_id}: approval card failed to post:`, err);
    return cardFailed(req.request_id, describeChange(req, gym));
  }
  const change = describeChange(req, gym);
  return {
    reply: `Request ${req.request_id} submitted: ${change}. Staff will review it.`,
    publicMessage: `**Transfer Request**: ${change}`,
  };
}

// The request is saved but staff have no card to decide it from. Staff are told
// in their channel and, in case that's what failed, in the public message too.
async function cardFailed(requestId: string, change: string): Promise<CommandResult> {
  const fix = `run /roster repost-request ${requestId} to post it again`;
  try {
    await postStaffNotice(`**Missing card**: request ${requestId} (${change}) is saved, but its approval card failed to post. Staff: ${fix}.`);
  } catch (err) {
    console.error(`${requestId}: staff notice about the missing card failed:`, err);
  }
  return {
    reply: `Request ${requestId} is saved (${change}), but its staff card failed to post. Staff have been told.`,
    publicMessage: `**Transfer Request**: ${change}\nStaff: the approval card for ${requestId} failed to post; ${fix}.`,
  };
}

// Posts a new staff card for a pending request, e.g. one whose card failed to
// post. An old card that still has buttons is closed first, so only one is live.
export async function repostCard(guildId: string, requestId: string): Promise<string> {
  const [requests] = await readTabs('rosterRequests');
  const found = requests.find((r) => r.values.request_id === requestId);
  if (!found) return `${requestId} isn't in the Roster requests tab.`;
  // The gym's lock, as in approval, so the request can't be decided while its card is replaced.
  return withLock(`gym:${found.values.gym_id}`, async () => {
    const league = await loadLeague();
    const req = league.requests.find((r) => r.values.request_id === requestId)!.values;
    if (req.status !== 'pending') return `${requestId} was already ${req.status}, so there's nothing to repost.`;
    await closeApprovalCard(requestId, '**Reposted** as a new card below');
    const gym = findGym(league, req.gym_id);
    const mentionText = await gymMention(guildId, gymName(league, req.gym_id));
    let name: string | undefined;
    if (!isGymRequest(req.type)) {
      const member = await getMember(guildId, req.target);
      name = member ? displayName(member) : findTrainer(league, req.target)?.server_nickname || req.target;
    }
    const warnings = req.type === 'remove' && gym ? removeWarnings(league, req.target, gym) : [];
    await postApprovalCard(cardText(req, mentionText, name, warnings), requestId);
    return `Reposted the staff card for ${requestId}.`;
  });
}

// Marks a pending request cancelled, closes its staff card and announces the
// cancel. `allowed` is the leadership on the request's gym that may cancel it.
export async function cancel(
  requester: Requester, found: SheetRow<'rosterRequests'>, allowed: Leadership[], what: string,
): Promise<string | CommandResult> {
  const requestId = found.values.request_id;
  // The gym's lock, as in approval, so a cancel can't land in the middle of an approval.
  const result = await withLock(`gym:${found.values.gym_id}`, async () => {
    const league = await loadLeague();
    const row = league.requests.find((r) => r.values.request_id === requestId)!;
    if (row.values.status !== 'pending') return `${what} ${requestId} was already ${row.values.status}.`;
    // An approval that stopped partway; staff finish it from the card.
    if (row.values.decided_by) return `Staff are approving ${what} ${requestId}, so it can't be cancelled.`;
    const checked = checkRequester(league, requester.id, allowed);
    if ('refusal' in checked) return checked.refusal;
    if (checked.gym.gym_id !== row.values.gym_id) {
      const who = allowed.length === 1 ? `its ${allowed[0]}` : 'its leader or manager';
      return `${what} ${requestId} is for ${gymName(league, row.values.gym_id)}, so only ${who} can cancel it.`;
    }
    const req = {
      ...row.values,
      status: 'cancelled',
      decided_by: requester.id,
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
  const change = describeChange(req, await gymMention(requester.guildId, result.gymName));
  return {
    reply: `Request ${requestId} cancelled.`,
    publicMessage: `**Transfer Request cancelled**: ${change}`,
  };
}
