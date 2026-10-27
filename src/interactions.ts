// Slash command plumbing. Discord drops an interaction that isn't answered within
// 3 seconds, and a few Sheets calls can take longer, so every command here is
// deferred: the bot answers "thinking" at once (privately), then fills in the
// reply when the handler finishes.
import { InteractionResponseFlags, InteractionResponseType } from 'discord-interactions';
import type { Response } from 'express';
import { editOriginalResponse, type Member } from './discord.js';

// The fields of an application command interaction the bot uses.
export interface CommandInteraction {
  application_id: string;
  token: string;
  guild_id: string;
  channel_id: string;
  member: Member; // always present for commands run in a server
  data: {
    name: string;
    options?: CommandOption[];
    resolved?: {
      users?: Record<string, Member['user']>;
      members?: Record<string, Omit<Member, 'user'>>;
    };
  };
}

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
}

// Returns the reply text, shown only to the person who ran the command.
export type CommandHandler = (interaction: CommandInteraction) => Promise<string>;

export function runDeferred(res: Response, interaction: CommandInteraction, handler: CommandHandler): void {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  void (async () => {
    let reply: string;
    try {
      reply = await handler(interaction);
    } catch (err) {
      console.error(`/${interaction.data.name} failed:`, err);
      reply = 'Something went wrong on the bot side. Please tell staff.';
    }
    try {
      await editOriginalResponse(interaction.application_id, interaction.token, reply);
    } catch (err) {
      console.error(`/${interaction.data.name}: could not send the reply:`, err);
    }
  })();
}
