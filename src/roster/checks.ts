// Request-time checks (Spec: "Roster requests"). Each returns the refusal message,
// or undefined when the check passes. Approval runs the same checks again.
import { formatDate } from '../seasons.js';
import { findGym, findTrainer, gymName, mention, seasonMoves, type Gym, type League, type Trainer } from './league.js';

export type Leadership = 'leader' | 'manager';

export const MAX_NON_PLAYING = 3;

export type RequesterResult = { trainer: Trainer; gym: Gym } | { refusal: string };

// The requester must be an active trainer with the required leadership on an active gym.
export function checkRequester(league: League, discordId: string, allowed: Leadership[]): RequesterResult {
  const trainer = findTrainer(league, discordId);
  // Not in the Trainers tab at all reads the same as holding no leadership.
  if (!trainer || !allowed.includes(trainer.leadership as Leadership)) {
    const who = allowed.length === 1 ? `the gym's ${allowed[0]}` : "a gym's leader or manager";
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
    return { refusal: `${gym.name} is ${gym.status}, so it can't make roster requests.` };
  }
  return { trainer, gym };
}

export function checkTargetHasNoGym(league: League, targetId: string, gym: Gym): string | undefined {
  const target = findTrainer(league, targetId);
  if (!target?.gym_id) return undefined;
  if (target.gym_id === gym.gym_id) return `${mention(targetId)} is already on ${gym.name}.`;
  const theirs = gymName(league, target.gym_id);
  return `${mention(targetId)} is on ${theirs}. ${theirs}'s leader or manager must remove them first.`;
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
    return `${mention(targetId)} left ${gym.name} on ${formatDate(leftOn)}, so they can't rejoin it until season ${season.season} ends.`;
  }
  if (moves.gyms.length > 1) {
    const names = moves.gyms.map((id) => gymName(league, id)).join(', ');
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
  return `${gym.name} already has ${MAX_NON_PLAYING} non-playing trainers (${names}), the most allowed.`;
}

export function checkNoPendingRequest(league: League, targetId: string, exceptRequestId?: string): string | undefined {
  const pending = league.requests
    .map((r) => r.values)
    .find((r) => r.target === targetId && r.status === 'pending' && r.request_id !== exceptRequestId);
  if (!pending) return undefined;
  return `${mention(targetId)} already has a pending request, ${pending.request_id} (${pending.type} for ${gymName(league, pending.gym_id)}). Staff must decide it, or its requester can cancel it, first.`;
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
