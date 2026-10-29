import dotenv from 'dotenv';
dotenv.config();
import { commandDefinitions } from '../src/commands/index.js';

const appId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !guildId || !token) {
  throw new Error('DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN must be set');
}

const res = await fetch(
  `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
  {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commandDefinitions),
  },
);

if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}

const registered = (await res.json()) as { name: string }[];
console.log('registered:', registered.map((c) => c.name).join(', '));