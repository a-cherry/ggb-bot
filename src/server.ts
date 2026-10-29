import 'dotenv/config';
import express from 'express';
import {
  InteractionType,
  InteractionResponseType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { handleDisbandButton } from './commands/gym.js';
import { deferredCommands } from './commands/index.js';
import { runDeferred, runDeferredUpdate } from './interactions.js';
import { handleDecision } from './roster/approval.js';
import { recoverApprovals } from './roster/recovery.js';

const PORT = Number(process.env.PORT ?? 3000);
const publicKey = process.env.DISCORD_PUBLIC_KEY;
if (!publicKey) throw new Error('DISCORD_PUBLIC_KEY is not set');

const app = express();

app.get('/health', (_req, res) => {
  res.send('ok');
});

app.post('/interactions', verifyKeyMiddleware(publicKey), (req, res) => {
  const interaction = req.body;

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

// Before serving, finish any approval the bot stopped in the middle of (Spec: "Approve", step 6).
const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) throw new Error('DISCORD_GUILD_ID is not set');
try {
  await recoverApprovals(guildId);
} catch (err) {
  console.error('crash recovery failed:', err);
}

app.listen(PORT, () => console.log(`listening on ${PORT}`));