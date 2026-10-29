import 'dotenv/config';
import express from 'express';
import {
  InteractionResponseFlags,
  InteractionType,
  InteractionResponseType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { handleDisbandButton } from './commands/gym.js';
import { deferredCommands } from './commands/index.js';
import { alertStaff, drain, runDeferred, runDeferredUpdate } from './interactions.js';
import { handleDecision } from './roster/approval.js';
import { recoverApprovals } from './roster/recovery.js';
import { TABS, type TabKey } from './schema.js';
import { readTabs, SheetLayoutError } from './sheet-rows.js';

const PORT = Number(process.env.PORT ?? 3000);
const publicKey = process.env.DISCORD_PUBLIC_KEY;
if (!publicKey) throw new Error('DISCORD_PUBLIC_KEY is not set');
const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) throw new Error('DISCORD_GUILD_ID is not set');

const app = express();

app.get('/health', (_req, res) => {
  res.send('ok');
});

// Discord's interaction payloads are a few KB. Reading the body is capped, so
// an oversized request is refused before its signature is checked; the
// signature check then reads the raw body this leaves.
const MAX_BODY = '256kb';
let shuttingDown = false;

app.post('/interactions', express.raw({ type: '*/*', limit: MAX_BODY }), verifyKeyMiddleware(publicKey), (req, res) => {
  const interaction = req.body;

  // Stopping for a deploy: the new process handles anything that arrives now.
  if (shuttingDown) {
    res.status(503).send({ error: 'shutting down' });
    return;
  }

  // Only the GGB server: the League DB belongs to it, and the bot could be added elsewhere.
  if (interaction.type !== InteractionType.PING && interaction.guild_id !== guildId) {
    res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'This bot only works in the GGB server.', flags: InteractionResponseFlags.EPHEMERAL },
    });
    return;
  }

  if (interaction.type === InteractionType.PING) {
    res.send({ type: InteractionResponseType.PONG });
    return;
  }

  if (
    interaction.type === InteractionType.APPLICATION_COMMAND &&
    interaction.data.name === 'ping'
  ) {
    res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'pong' },
    });
    return;
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const handler = deferredCommands[interaction.data.name];
    if (handler) {
      runDeferred(res, interaction, handler);
      return;
    }
  }

  // Approve and Reject on staff approval cards.
  if (
    interaction.type === InteractionType.MESSAGE_COMPONENT &&
    /^(approve|reject):/.test(interaction.data.custom_id)
  ) {
    runDeferredUpdate(res, interaction, handleDecision);
    return;
  }

  // The two confirm prompts of /gym disband.
  if (interaction.type === InteractionType.MESSAGE_COMPONENT && interaction.data.custom_id.startsWith('disband:')) {
    runDeferredUpdate(res, interaction, handleDisbandButton);
    return;
  }

  res.status(400).send({ error: 'unknown interaction' });
});

// Refuse to start on a League DB whose header rows don't match src/schema.ts:
// reads and writes go by column position. Staff are told why in their channel.
try {
  await readTabs(...(Object.keys(TABS) as TabKey[]));
} catch (err) {
  if (err instanceof SheetLayoutError) await alertStaff(guildId, err, "The bot won't start until it's fixed.");
  throw err;
}

// Before serving, finish any approval that stopped partway (Spec: "If the bot stops mid-approval").
try {
  await recoverApprovals(guildId);
} catch (err) {
  console.error('crash recovery failed:', err);
}

const server = app.listen(PORT, () => console.log(`listening on ${PORT}`));

// The longest a shutdown waits for interactions in progress. Railway's
// RAILWAY_DEPLOYMENT_DRAINING_SECONDS must be longer (see the README).
const DRAIN_MS = 50_000;

// On a deploy or Ctrl+C: stop taking interactions, let the ones in progress
// finish, so an approval isn't cut off after it's marked approved, then exit.
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: finishing interactions in progress, then stopping`);
  server.close();
  const timedOut = await Promise.race([
    drain().then(() => false),
    new Promise<true>((r) => setTimeout(() => r(true), DRAIN_MS).unref()),
  ]);
  if (timedOut) console.error(`stopping with interactions still in progress after ${DRAIN_MS / 1000}s`);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));