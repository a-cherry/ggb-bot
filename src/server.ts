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
import { alertStaff, drain, inFlightCount, runDeferred, runDeferredUpdate } from './interactions.js';
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

// Set once the header check and recovery have run; the host's health check
// waits for it before sending traffic here.
let ready = false;
let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (!ready || shuttingDown) {
    res.status(503).send(shuttingDown ? 'shutting down' : 'starting');
    return;
  }
  res.send('ok');
});

// Discord's interaction payloads are a few KB. Reading the body is capped, so
// an oversized request is refused before its signature is checked; the
// signature check then reads the raw body this leaves.
const MAX_BODY = '256kb';

app.post('/interactions', express.raw({ type: '*/*', limit: MAX_BODY }), verifyKeyMiddleware(publicKey), (req, res) => {
  const interaction = req.body;

  // Still starting, or stopping for a deploy: recovery may be finishing an
  // approval, or the next process handles anything that arrives now.
  if (!ready || shuttingDown) {
    res.status(503).send({ error: shuttingDown ? 'shutting down' : 'starting' });
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
    runDeferredUpdate(res, interaction, handleDecision, '⏳ Processing…');
    return;
  }

  // The two confirm prompts of /gym disband.
  if (interaction.type === InteractionType.MESSAGE_COMPONENT && interaction.data.custom_id.startsWith('disband:')) {
    runDeferredUpdate(res, interaction, handleDisbandButton);
    return;
  }

  res.status(400).send({ error: 'unknown interaction' });
});

// Listen during startup so the health check can answer 503 until it's done.
const server = app.listen(PORT, () => console.log(`listening on ${PORT}`));

// The longest a shutdown waits for interactions in progress. The host must
// wait longer before killing the process: Render kills 30 seconds after
// SIGTERM on a service with a disk, and that can't be changed; on Railway, set
// RAILWAY_DEPLOYMENT_DRAINING_SECONDS. An approval still running when this
// runs out is finished by startup recovery.
const DRAIN_MS = 25_000;

// On a deploy or Ctrl+C: stop taking interactions, let the ones in progress
// finish, so an approval isn't cut off after it's marked approved, then exit.
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const started = Date.now();
  console.log(`${signal}: ${inFlightCount()} interaction(s) in progress; finishing them, then stopping`);
  server.close();
  const timedOut = await Promise.race([
    drain().then(() => false),
    new Promise<true>((r) => setTimeout(() => r(true), DRAIN_MS).unref()),
  ]);
  if (timedOut) console.error(`stopping with ${inFlightCount()} interaction(s) still in progress after ${DRAIN_MS / 1000}s`);
  else console.log(`interactions finished after ${((Date.now() - started) / 1000).toFixed(1)}s; stopping`);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Refuse to start on a League DB whose header rows don't match src/schema.ts:
// reads and writes go by column position. Staff are told why in their channel.
try {
  await readTabs(...(Object.keys(TABS) as TabKey[]));
} catch (err) {
  if (err instanceof SheetLayoutError) await alertStaff(guildId, err, "The bot won't start until it's fixed.");
  throw err;
}

// Before serving, finish any approval that stopped partway (Roster Spec: "When
// something fails"). One claimed too recently is scheduled for later instead.
try {
  await recoverApprovals(guildId);
} catch (err) {
  console.error('crash recovery failed:', err);
}

ready = true;
console.log('startup finished; taking interactions');