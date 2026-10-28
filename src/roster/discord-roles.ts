// Mirrors approved roster changes onto Discord roles. The League DB stays the
// source of truth: a failure here doesn't undo the approval, it's reported on
// the card for staff to fix by hand.
import { addMemberRole, cachedRoles, DiscordError, removeMemberRole, renameRole, type Role } from '../discord.js';

export interface RoleChange {
  userId: string;
  add: string[]; // role names
  remove: string[];
}

export interface RoleRename {
  from: string;
  to: string;
  optional?: boolean; // skipped, not a failure, when no role is named `from`
}

const cantChange = (name: string) =>
  `the bot can't change ${name}. It needs Manage Roles, and its role must be above ${name} in the server's role list`;

// Applies each change one role at a time, so roles staff gave by hand are left
// alone. Returns why it failed, or undefined when every change landed.
export async function applyRoleChanges(guildId: string, changes: RoleChange[]): Promise<string | undefined> {
  const names = [...new Set(changes.flatMap((c) => [...c.add, ...c.remove]))];
  let roles = await cachedRoles(guildId);
  if (names.some((n) => !roles.some((r) => r.name === n))) roles = await cachedRoles(guildId, true);
  const missing = names.filter((n) => !roles.some((r) => r.name === n));
  if (missing.length) return `no role named ${missing.join(', ')} in this server`;
  const byName = (name: string) => roles.find((r) => r.name === name) as Role;

  member: for (const c of changes) {
    for (const [names, op] of [[c.add, addMemberRole], [c.remove, removeMemberRole]] as const) {
      for (const name of names) {
        try {
          await op(guildId, c.userId, byName(name).id);
        } catch (err) {
          // They left the server, so they hold no roles to change.
          if (err instanceof DiscordError && err.status === 404) continue member;
          console.error(`role ${name} for ${c.userId} failed:`, err);
          if (err instanceof DiscordError && err.status === 403) return cantChange(name);
          return `changing ${name} for <@${c.userId}> failed`;
        }
      }
    }
  }
  return undefined;
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
