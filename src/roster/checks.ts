// Request-time checks (Roster Spec: "Checks"). Each returns the refusal message,
// or undefined when the check passes. Approval runs the same checks again.
import { escapeMarkdown } from '../discord.js';
import { formatDate, isInSeason } from '../seasons.js';
import { findGym, findTrainer, gymName, mention, seasonMoves, type Gym, type League, type Trainer } from './league.js';
import { isGymRequest, leadershipTitle, type RequestType } from './requests.js';

// A gym's fan role is its gym role's name plus this (Bot Spec: "Initial population").
export const FAN_SUFFIX = ' Fan';

export type Leadership = 'leader' | 'vice-leader';

export const MAX_NON_PLAYING = 3;

// In season, a remove that leaves fewer participating trainers than this gets a warning on the card.
export const MIN_TRAINERS = 8;

export type RequesterResult = { trainer: Trainer; gym: Gym } | { refusal: string };

// The requester must be an active trainer with the required leadership on an active gym.
export function checkRequester(league: League, discordId: string, allowed: Leadership[]): RequesterResult {
  const trainer = findTrainer(league, discordId);
  // Not in the Trainers tab at all reads the same as holding no leadership.
  if (!trainer || !allowed.includes(trainer.leadership as Leadership)) {
    const who = allowed.length === 1 ? `the gym's ${allowed[0]}` : "a gym's leader or vice-leader";
    return { refusal: `Only ${who} can make this request.` };
  }
  if (trainer.status !== 'active') {
    return { refusal: `Your trainer status is ${trainer.status}, so you can't make roster requests.` };
  }
  const gym = trainer.gym_id ? findGym(league, trainer.gym_id) : undefined;
  if (!gym) {
    return { refusal: "The League DB doesn't list you on a gym, so you can't make roster requests." };
  }
  if (gym.status !== 'active') {
    return { refusal: `${escapeMarkdown(gym.name)} is ${gym.status}, so it can't make roster requests.` };
  }
  return { trainer, gym };
}

// Who may make a request. A remove of the vice-leader, any leadership change, a
// rebrand and a disband are the leader's alone.
export function leadershipFor(type: RequestType, change: Record<string, string>, target: Trainer | undefined): Leadership[] {
  if (type === 'rebrand' || type === 'disband') return ['leader'];
  if (type === 'remove' && target?.leadership === 'vice-leader') return ['leader'];
  if (type === 'update-trainer' && change.leadership) return ['leader'];
  return ['leader', 'vice-leader'];
}

export function checkTargetHasNoGym(league: League, targetId: string, gym: Gym): string | undefined {
  const target = findTrainer(league, targetId);
  if (!target?.gym_id) return undefined;
  if (target.gym_id === gym.gym_id) return `${mention(targetId)} is already on ${escapeMarkdown(gym.name)}.`;
  const theirs = escapeMarkdown(gymName(league, target.gym_id));
  return `${mention(targetId)} is on ${theirs}. ${theirs}'s leader or vice-leader must remove them first.`;
}

export function checkTargetOnGym(league: League, targetId: string, gym: Gym): string | undefined {
  const theirs = findTrainer(league, targetId)?.gym_id;
  if (theirs === gym.gym_id) return undefined;
  if (!theirs) return `${mention(targetId)} isn't on ${escapeMarkdown(gym.name)}.`;
  return `${mention(targetId)} is on ${escapeMarkdown(gymName(league, theirs))}, not ${escapeMarkdown(gym.name)}.`;
}

// The leader can't be removed or step down; they hand leadership to someone else first.
export function checkTargetNotLeader(league: League, targetId: string, gym: Gym): string | undefined {
  if (findTrainer(league, targetId)?.leadership !== 'leader') return undefined;
  return `${mention(targetId)} is ${escapeMarkdown(gym.name)}'s ${leadershipTitle('leader')}. They must hand leadership to someone else first, with /roster update-trainer leadership:leader.`;
}

export function checkTargetStatus(league: League, targetId: string): string | undefined {
  const status = findTrainer(league, targetId)?.status;
  if (status === 'suspended' || status === 'banned') return `${mention(targetId)} is ${status}.`;
  return undefined;
}

// In season only: no rejoining a gym left since the start date, and at most one switch.
export function checkSeasonMoves(league: League, targetId: string, gym: Gym): string | undefined {
  const { season, today } = league;
  if (!season || today < season.start || today > season.end) return undefined;
  const moves = seasonMoves(league, targetId, season.start);
  const leftOn = moves.left.get(gym.gym_id);
  if (leftOn) {
    return `${mention(targetId)} left ${escapeMarkdown(gym.name)} on ${formatDate(leftOn)}, so they can't rejoin it until season ${season.season} ends.`;
  }
  if (moves.gyms.length > 1) {
    const names = moves.gyms.map((id) => escapeMarkdown(gymName(league, id))).join(', ');
    return `${mention(targetId)} has already switched gyms in season ${season.season} (${names}).`;
  }
  return undefined;
}

// Counts the gym's current non-playing trainers, other than the target.
export function checkNonPlaying(league: League, targetId: string, gym: Gym): string | undefined {
  const current = league.trainers
    .map((t) => t.values)
    .filter((t) => t.gym_id === gym.gym_id && t.role === 'non-playing' && t.discord_id !== targetId);
  if (current.length < MAX_NON_PLAYING) return undefined;
  const names = current.map((t) => mention(t.discord_id)).join(', ');
  return `${escapeMarkdown(gym.name)} already has ${MAX_NON_PLAYING} coaches (${names}), the most allowed.`;
}

export function checkNoPendingRequest(league: League, targetId: string, exceptRequestId?: string): string | undefined {
  const pending = league.requests
    .map((r) => r.values)
    .find((r) => r.target === targetId && r.status === 'pending' && r.request_id !== exceptRequestId);
  if (!pending) return undefined;
  return `${mention(targetId)} already has a pending request, ${pending.request_id} (${pending.type} for ${escapeMarkdown(gymName(league, pending.gym_id))}). Staff must decide it, or its requester can cancel it, first.`;
}

export function checkRemove(league: League, targetId: string, gym: Gym, exceptRequestId?: string): string | undefined {
  return (
    checkTargetOnGym(league, targetId, gym) ??
    checkTargetNotLeader(league, targetId, gym) ??
    checkNoPendingRequest(league, targetId, exceptRequestId)
  );
}

// `change` holds role and/or leadership, each only when it changes something.
export function checkUpdate(
  league: League, targetId: string, gym: Gym, change: Record<string, string>, exceptRequestId?: string,
): string | undefined {
  const onGym = checkTargetOnGym(league, targetId, gym);
  if (onGym) return onGym;
  const target = findTrainer(league, targetId)!;
  if (change.leadership && change.leadership !== 'leader') {
    const leader = checkTargetNotLeader(league, targetId, gym);
    if (leader) return leader;
  }
  if (change.leadership === 'none' && target.leadership !== 'vice-leader') {
    return `${mention(targetId)} isn't ${escapeMarkdown(gym.name)}'s ${leadershipTitle('vice-leader')}.`;
  }
  if (change.leadership && change.leadership === target.leadership) {
    return `${mention(targetId)} is already ${escapeMarkdown(gym.name)}'s ${leadershipTitle(target.leadership)}.`;
  }
  return (
    (change.leadership === 'leader' || change.leadership === 'vice-leader' ? checkTargetStatus(league, targetId) : undefined) ??
    (change.role === 'non-playing' ? checkNonPlaying(league, targetId, gym) : undefined) ??
    checkNoPendingRequest(league, targetId, exceptRequestId)
  );
}

// Card warnings for a remove (Roster Spec: "Checks").
export function removeWarnings(league: League, targetId: string, gym: Gym): string[] {
  if (!isInSeason(league.season, league.today)) return [];
  if (findTrainer(league, targetId)?.role !== 'trainer') return [];
  const left = league.trainers.filter(
    (t) => t.values.gym_id === gym.gym_id && t.values.role === 'trainer' && t.values.discord_id !== targetId,
  ).length;
  if (left >= MIN_TRAINERS) return [];
  const trainers = left === 1 ? 'participating trainer' : 'participating trainers';
  return [`${escapeMarkdown(gym.name)} would have ${left} ${trainers}, under the ${MIN_TRAINERS} needed in season.`];
}

export function checkAdd(league: League, targetId: string, gym: Gym, role: string, exceptRequestId?: string): string | undefined {
  return (
    checkTargetHasNoGym(league, targetId, gym) ??
    checkTargetStatus(league, targetId) ??
    checkSeasonMoves(league, targetId, gym) ??
    (role === 'non-playing' ? checkNonPlaying(league, targetId, gym) : undefined) ??
    checkNoPendingRequest(league, targetId, exceptRequestId)
  );
}

export function checkOffSeason(league: League): string | undefined {
  if (!isInSeason(league.season, league.today)) return undefined;
  return `Rebrands and disbands are off-season only.`;
}

// At most one pending rebrand or disband per gym, as a trainer has at most one pending request.
export function checkNoPendingGymRequest(league: League, gym: Gym, exceptRequestId?: string): string | undefined {
  const pending = league.requests
    .map((r) => r.values)
    .find((r) => r.gym_id === gym.gym_id && isGymRequest(r.type) && r.status === 'pending' && r.request_id !== exceptRequestId);
  if (!pending) return undefined;
  return `${escapeMarkdown(gym.name)} already has a pending ${pending.type} request, ${pending.request_id}. Staff must decide it, or you can cancel it with /gym cancel-request, first.`;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// `change` holds the new name, abbreviation and emote. `roleNames` are the
// server's Discord roles: the gym's roles are renamed to the new name, so it
// can't match another role, or a gym role named "Referee" would pass the staff check.
export function checkRebrand(
  league: League, gym: Gym, change: Record<string, string>, roleNames: string[], exceptRequestId?: string,
): string | undefined {
  const offSeason = checkOffSeason(league);
  if (offSeason) return offSeason;
  for (const { values: other } of league.gyms) {
    if (other.gym_id === gym.gym_id) continue;
    if ((other.status === 'active' || other.status === 'relegated') && same(other.name, change.name)) {
      return `The name ${escapeMarkdown(other.name)} is already taken by another gym.`;
    }
    if (other.status === 'active' && other.abbreviation && same(other.abbreviation, change.abbreviation)) {
      return `The abbreviation ${escapeMarkdown(other.abbreviation)} is taken by ${escapeMarkdown(other.name)}.`;
    }
  }
  const own = [gym.name, `${gym.name}${FAN_SUFFIX}`];
  for (const name of [change.name, `${change.name}${FAN_SUFFIX}`]) {
    const clash = roleNames.find((r) => same(r, name) && !own.some((o) => same(o, r)));
    if (clash) return `${clash} is already a role in this server, so a gym can't use that name.`;
  }
  return checkNoPendingGymRequest(league, gym, exceptRequestId);
}

export function checkDisband(league: League, gym: Gym, exceptRequestId?: string): string | undefined {
  return checkOffSeason(league) ?? checkNoPendingGymRequest(league, gym, exceptRequestId);
}
