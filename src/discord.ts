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
    if (!res.ok) throw new Error(`Discord ${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

export const listRoles = (guildId: string) => call<Role[]>('GET', `/guilds/${guildId}/roles`);

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

// Fills in a deferred interaction reply. The interaction token is valid for 15 minutes.
export const editOriginalResponse = (applicationId: string, token: string, content: string) =>
  call('PATCH', `/webhooks/${applicationId}/${token}/messages/@original`, {
    content,
    allowed_mentions: { parse: [] },
  });

// A public message in the channel where a command ran, after its deferred
// (private) reply. Needs no channel permission: it goes through the interaction.
export const postFollowup = (applicationId: string, token: string, content: string) =>
  call('POST', `/webhooks/${applicationId}/${token}`, { content, allowed_mentions: { parse: [] } });

// The name a member shows in the server: nickname, else global display name, else username.
export const displayName = (m: Member) => m.nick ?? m.user.global_name ?? m.user.username;
