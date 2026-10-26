// Turns the Discord role and member lists into the gyms and trainers the
// import writes, plus everyone it skips. Pure: no I/O. Spec: "Initial population".
import type { LeagueConfig } from '../../src/config.js';
import { displayName, type Member, type Role } from '../../src/discord.js';

export type Leadership = 'leader' | 'manager' | 'none';
export type TrainerRole = 'trainer' | 'non-playing';

export interface ImportedTrainer {
  discordId: string;
  name: string;
  gym: string; // gym name; mapped to a gym_id on commit
  role: TrainerRole;
  leadership: Leadership;
  bothLeaderAndManager: boolean;
}

export interface SkippedMember {
  discordId: string;
  name: string;
}

export interface Classification {
  activeGyms: string[];
  relegatedGyms: string[];
  trainers: ImportedTrainer[];
  multipleGymRoles: (SkippedMember & { gyms: string[] })[];
  gymRoleWithoutParticipating: (SkippedMember & { gyms: string[] })[];
}

const FAN_SUFFIX = ' Fan';

export function classify(roles: Role[], members: Member[], config: LeagueConfig): Classification {
  const names = new Set(roles.map((r) => r.name));
  const relegated = new Set(config.relegatedGyms);

  // A role X is a gym role when "X Fan" also exists, unless X was relegated.
  // Relegated gym roles still count toward "more than one gym role".
  const gymRoleIds = new Map<string, string>();
  const relegatedRoleIds = new Map<string, string>();
  for (const r of roles) {
    if (relegated.has(r.name)) relegatedRoleIds.set(r.id, r.name);
    else if (names.has(r.name + FAN_SUFFIX)) gymRoleIds.set(r.id, r.name);
  }

  const roleId = (name: string) => roles.find((r) => r.name === name)?.id;
  const ids = {
    participating: roleId(config.roles.participatingTrainer),
    leader: roleId(config.roles.gymLeader),
    manager: roleId(config.roles.gymManager),
    nonPlayer: roleId(config.roles.nonPlayer),
  };

  const result: Classification = {
    activeGyms: [...gymRoleIds.values()].sort(byName),
    relegatedGyms: [...config.relegatedGyms],
    trainers: [],
    multipleGymRoles: [],
    gymRoleWithoutParticipating: [],
  };

  const sorted = members.filter((m) => !m.user.bot).sort((a, b) => byName(displayName(a), displayName(b)));
  for (const m of sorted) {
    const has = (id: string | undefined) => id !== undefined && m.roles.includes(id);
    const who = { discordId: m.user.id, name: displayName(m) };
    const gyms = m.roles.flatMap((id) => gymRoleIds.get(id) ?? []).sort(byName);
    const allGyms = [...gyms, ...m.roles.flatMap((id) => relegatedRoleIds.get(id) ?? [])].sort(byName);
    const isLeader = has(ids.leader);
    const isManager = has(ids.manager);

    if (!has(ids.participating)) {
      if (gyms.length > 0) result.gymRoleWithoutParticipating.push({ ...who, gyms });
      continue;
    }
    if (allGyms.length > 1) {
      result.multipleGymRoles.push({ ...who, gyms: allGyms });
      continue;
    }
    // Free agents, staff who don't play, and a lone relegated gym role: skipped, not reported.
    if (gyms.length === 0) continue;

    const both = isLeader && isManager;
    result.trainers.push({
      ...who,
      gym: gyms[0],
      role: has(ids.nonPlayer) ? 'non-playing' : 'trainer',
      leadership: both ? 'none' : isLeader ? 'leader' : isManager ? 'manager' : 'none',
      bothLeaderAndManager: both,
    });
  }

  return result;
}

// Marker roles from config that don't exist in the server. Every one is
// required: a typo would silently import nobody, or nobody as a leader.
export function missingMarkerRoles(roles: Role[], config: LeagueConfig): string[] {
  const names = new Set(roles.map((r) => r.name));
  return Object.values(config.roles).filter((n) => !names.has(n));
}

function byName(a: string, b: string) {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}
