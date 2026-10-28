// Mirrors approved roster changes onto Discord roles. The League DB stays the
// source of truth: a failure here doesn't undo the approval, it's reported on
// the card for staff to fix by hand.
import { addMemberRole, cachedRoles, DiscordError, removeMemberRole, type Role } from '../discord.js';

export interface RoleChange {
  userId: string;
  add: string[]; // role names
  remove: string[];
}

// Applies each change one role at a time, so roles staff gave by hand are left
// alone. Returns why it failed, or undefined when every change landed.
export async function applyRoleChanges(guildId: string, changes: RoleChange[]): Promise<string | undefined> {
  const names = [...new Set(changes.flatMap((c) => [...c.add, ...c.remove]))];
  let roles = await cachedRoles(guildId);
  if (names.some((n) => !roles.some((r) => r.name === n))) roles = await cachedRoles(guildId, true);
  const missing = names.filter((n) => !roles.some((r) => r.name === n));
  if (missing.length) return `no role named ${missing.join(', ')} in this server`;
  const byName = (name: string) => roles.find((r) => r.name === name) as Role;

  for (const c of changes) {
    for (const [names, op] of [[c.add, addMemberRole], [c.remove, removeMemberRole]] as const) {
      for (const name of names) {
        try {
          await op(guildId, c.userId, byName(name).id);
        } catch (err) {
          console.error(`role ${name} for ${c.userId} failed:`, err);
          if (err instanceof DiscordError && err.status === 403) {
            return `the bot can't change ${name}. It needs Manage Roles, and its role must be above ${name} in the server's role list`;
          }
          if (err instanceof DiscordError && err.status === 404) return `<@${c.userId}> isn't in the server`;
          return `changing ${name} for <@${c.userId}> failed`;
        }
      }
    }
  }
  return undefined;
}
