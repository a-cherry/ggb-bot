// Mirrors approved roster changes onto Discord roles. The League DB stays the
// source of truth: a failure here doesn't undo the approval, it's reported on
// the card for staff to fix by hand.
import {
  addMemberRole, cachedRoles, DiscordError, getMember, removeMemberRole, renameRole, type Member, type Role,
} from '../discord.js';
import { crashPoint } from './approval.js';

export interface RoleChange {
  userId: string;
  add: string[]; // role names
  remove: string[];
  // The member as just read, null when they've left the server; read here when left out.
  member?: Member | null;
}

export interface RoleRename {
  from: string;
  to: string;
  optional?: boolean; // skipped, not a failure, when no role is named `from`
}

const cantChange = (name: string) =>
  `the bot can't change ${name}. It needs Manage Roles, and its role must be above ${name} in the server's role list`;

// Applies each change one role at a time, so roles staff gave by hand are left
// alone, skipping roles a member already has or doesn't hold. A failed role
// doesn't stop the rest, so staff get the full list to fix. Returns what failed
// and why, or undefined when every change landed.
export async function applyRoleChanges(guildId: string, changes: RoleChange[]): Promise<string | undefined> {
  const names = [...new Set(changes.flatMap((c) => [...c.add, ...c.remove]))];
  let roles = await cachedRoles(guildId);
  if (names.some((n) => !roles.some((r) => r.name === n))) roles = await cachedRoles(guildId, true);
  const missing = names.filter((n) => !roles.some((r) => r.name === n));
  const byName = (name: string) => roles.find((r) => r.name === name) as Role;

  const failed: string[] = []; // "<@member> (role)"
  let forbidden: string | undefined; // a role the bot isn't allowed to change
  member: for (const c of changes) {
    let member: Member | null | undefined;
    try {
      member = c.member !== undefined ? c.member : await getMember(guildId, c.userId);
    } catch (err) {
      console.error(`reading ${c.userId}'s roles failed:`, err);
      failed.push(`<@${c.userId}> (couldn't read their roles)`);
      continue;
    }
    if (!member) continue; // they left the server, so they hold no roles to change
    const held = new Set(member.roles);
    for (const [names, op, adding] of [[c.add, addMemberRole, true], [c.remove, removeMemberRole, false]] as const) {
      for (const name of names) {
        if (missing.includes(name)) continue;
        // Only the calls that change something: a disband removes four roles
        // from every member, and most hold one or two of them.
        if (held.has(byName(name).id) === adding) continue;
        try {
          crashPoint('role');
          await op(guildId, c.userId, byName(name).id);
        } catch (err) {
          // They left the server, so they hold no roles to change.
          if (err instanceof DiscordError && err.status === 404) continue member;
          console.error(`role ${name} for ${c.userId} failed:`, err);
          if (err instanceof DiscordError && err.status === 403) forbidden ??= name;
          failed.push(`<@${c.userId}> (${name})`);
        }
      }
    }
  }
  const reasons = [
    ...(missing.length ? [`no role named ${missing.join(', ')} in this server`] : []),
    ...(failed.length ? [`changing ${failed.join(', ')} failed`] : []),
    ...(forbidden ? [cantChange(forbidden)] : []),
  ];
  return reasons.length ? reasons.join('; ') : undefined;
}

// Renames roles in place, e.g. a gym's role on a rebrand, so members keep them
// and any channel access they grant. Returns why it failed, or undefined.
export async function renameRoles(guildId: string, renames: RoleRename[]): Promise<string | undefined> {
  if (!renames.length) return undefined;
  const roles = await cachedRoles(guildId, true);
  for (const r of renames) {
    if (r.from === r.to) continue;
    const matches = roles.filter((role) => role.name === r.from);
    if (!matches.length) {
      if (r.optional) continue;
      return `no role named ${r.from} in this server`;
    }
    if (matches.length > 1) return `more than one role is named ${r.from}`;
    if (roles.some((role) => role.name === r.to)) return `a role named ${r.to} already exists`;
    try {
      await renameRole(guildId, matches[0].id, r.to);
    } catch (err) {
      console.error(`renaming role ${r.from} to ${r.to} failed:`, err);
      if (err instanceof DiscordError && err.status === 403) return cantChange(r.from);
      return `renaming ${r.from} to ${r.to} failed`;
    }
  }
  // Gym mentions and later role changes find roles by their new names.
  await cachedRoles(guildId, true);
  return undefined;
}
