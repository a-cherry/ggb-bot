import dotenv from 'dotenv';
dotenv.config();

const appId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_DEV_GUILD_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !guildId || !token) {
  throw new Error('DISCORD_APPLICATION_ID, DISCORD_DEV_GUILD_ID and DISCORD_BOT_TOKEN must be set');
}

const commands = [
  { name: 'ping', description: 'Check that the bot is responding', type: 1 },
];

const res = await fetch(
  `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
  {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  },
);

if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}

const registered = (await res.json()) as { name: string }[];
console.log('registered:', registered.map((c) => c.name).join(', '));