// Slash command plumbing. Discord drops an interaction that isn't answered within
// 3 seconds, and a few Sheets calls can take longer, so every command here is
// deferred: the bot answers "thinking" at once (privately), then fills in the
// reply when the handler finishes.
import { InteractionResponseFlags, InteractionResponseType } from 'discord-interactions';
import type { Response } from 'express';
import { editOriginalResponse, postFollowup, type Member } from './discord.js';

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

// The reply is shown only to the person who ran the command. A public message,
// if any, is posted in the same channel after it.
export interface CommandResult {
  reply: string;
  publicMessage?: string;
}

export type CommandHandler = (interaction: CommandInteraction) => Promise<string | CommandResult>;

export function runDeferred(res: Response, interaction: CommandInteraction, handler: CommandHandler): void {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  void (async () => {
    let result: CommandResult;
    try {
      const r = await handler(interaction);
      result = typeof r === 'string' ? { reply: r } : r;
    } catch (err) {
      console.error(`/${interaction.data.name} failed:`, err);
      result = { reply: 'Something went wrong on the bot side. Please tell staff.' };
    }
    // The private reply goes first: a follow-up sent while the reply is still
    // "thinking" would replace it and be private too.
    try {
      await editOriginalResponse(interaction.application_id, interaction.token, result.reply);
      if (result.publicMessage) {
        await postFollowup(interaction.application_id, interaction.token, result.publicMessage);
      }
    } catch (err) {
      console.error(`/${interaction.data.name}: could not send the reply:`, err);
    }
  })();
}
