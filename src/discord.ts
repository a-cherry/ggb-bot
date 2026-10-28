// Minimal Discord REST client for calls the bot makes on its own (not in
// reply to an interaction): listing guild roles and members, posting messages.
const API = 'https://discord.com/api/v10';

export interface Role {
  id: string;
  name: string;
}

export interface User {
  id: string;
  username: string;
  global_name: string | null;
  bot?: boolean;
}

export interface Member {
  user: User;
  nick: string | null;
  roles: string[];
}

// Discord's limit on a message's content.
export const MESSAGE_LIMIT = 2000;

export class DiscordError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');

  for (;;) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Rate limited: wait as long as Discord says, then retry.
    if (res.status === 429) {
      const { retry_after } = (await res.json()) as { retry_after: number };
      await new Promise((r) => setTimeout(r, Math.ceil(retry_after * 1000)));
      continue;
    }
    if (!res.ok) throw new DiscordError(`Discord ${method} ${path}: ${res.status} ${await res.text()}`, res.status);
    // 204 No Content: role changes return no body.
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

export const listRoles = (guildId: string) => call<Role[]>('GET', `/guilds/${guildId}/roles`);

// Server roles change rarely; re-read them at most every 10 minutes.
const ROLE_CACHE_MS = 10 * 60 * 1000;
let roleCache: { guildId: string; at: number; roles: Role[] } | undefined;

// `refresh` re-reads at once, e.g. when a role staff just created isn't found.
export async function cachedRoles(guildId: string, refresh = false): Promise<Role[]> {
  if (refresh || !roleCache || roleCache.guildId !== guildId || Date.now() - roleCache.at > ROLE_CACHE_MS) {
    roleCache = { guildId, at: Date.now(), roles: await listRoles(guildId) };
  }
  return roleCache.roles;
}

// Needs Manage Roles, and the role must sit below the bot's highest role.
export const addMemberRole = (guildId: string, userId: string, roleId: string) =>
  call<void>('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);

export const removeMemberRole = (guildId: string, userId: string, roleId: string) =>
  call<void>('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);

// Undefined when they're no longer in the server.
export async function getMember(guildId: string, userId: string): Promise<Member | undefined> {
  try {
    return await call<Member>('GET', `/guilds/${guildId}/members/${userId}`);
  } catch (err) {
    if (err instanceof DiscordError && err.status === 404) return undefined;
    throw err;
  }
}

// Needs the Server Members intent. Discord returns at most 1000 per page,
// ordered by user ID, so page with `after` until a short page comes back.
export async function listMembers(guildId: string): Promise<Member[]> {
  const members: Member[] = [];
  let after = '0';
  for (;;) {
    const page = await call<Member[]>('GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
    members.push(...page);
    if (page.length < 1000) return members;
    after = page[page.length - 1].user.id;
  }
}

// Message buttons and the rows that hold them (Discord "components").
export interface ActionRow {
  type: 1;
  components: { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string; disabled?: boolean }[];
}

// Mentions render as names but never ping anyone.
export const postMessage = (channelId: string, content: string, components?: ActionRow[]) =>
  call('POST', `/channels/${channelId}/messages`, { content, components, allowed_mentions: { parse: [] } });

// Fills in a deferred interaction reply or, for a button press, edits the
// message the button is on. The interaction token is valid for 15 minutes.
export const editOriginalResponse = (applicationId: string, token: string, content: string, components?: ActionRow[]) =>
  call('PATCH', `/webhooks/${applicationId}/${token}/messages/@original`, {
    content,
    components,
    allowed_mentions: { parse: [] },
  });

// A public message in the channel where a command ran, after its deferred
// (private) reply. Needs no channel permission: it goes through the interaction.
export const postFollowup = (applicationId: string, token: string, content: string, ephemeral = false) =>
  call('POST', `/webhooks/${applicationId}/${token}`, {
    content,
    flags: ephemeral ? 64 : undefined,
    allowed_mentions: { parse: [] },
  });

// The name a member shows in the server: nickname, else global display name, else username.
export const displayName = (m: Member) => m.nick ?? m.user.global_name ?? m.user.username;
