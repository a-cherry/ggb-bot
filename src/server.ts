import 'dotenv/config';
import express from 'express';
import {
  InteractionType,
  InteractionResponseFlags,
  InteractionResponseType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { deferredCommands } from './commands/index.js';
import { runDeferred } from './interactions.js';

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

  // Approve and Reject on approval cards. Not built yet (step 3).
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Approve and Reject aren't built yet.", flags: InteractionResponseFlags.EPHEMERAL },
    });
    return;
  }

  res.status(400).send({ error: 'unknown interaction' });
});

app.listen(PORT, () => console.log(`listening on ${PORT}`));