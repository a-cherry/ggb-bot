// Slash command and button plumbing. Discord drops an interaction that isn't
// answered within 3 seconds, and a few Sheets calls can take longer, so every
// interaction here is deferred: the bot acknowledges at once, then fills in the
// result when the handler finishes.
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

// The fields of a button press the bot uses.
export interface ComponentInteraction {
  application_id: string;
  token: string;
  guild_id: string;
  member: Member;
  data: { custom_id: string };
  message: { id: string; content: string };
}

// `message` replaces the text of the message the button is on and removes its
// buttons; `reply` is shown only to the person who pressed it.
export interface ComponentResult {
  message?: string;
  reply?: string;
}

export type ComponentHandler = (interaction: ComponentInteraction) => Promise<ComponentResult>;

export function runDeferredUpdate(res: Response, interaction: ComponentInteraction, handler: ComponentHandler): void {
  // Acknowledges without changing the message yet; nothing shows as "thinking".
  res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

  void (async () => {
    let result: ComponentResult;
    try {
      result = await handler(interaction);
    } catch (err) {
      console.error(`button ${interaction.data.custom_id} failed:`, err);
      result = { reply: 'Something went wrong on the bot side. Please tell staff.' };
    }
    try {
      if (result.message !== undefined) {
        await editOriginalResponse(interaction.application_id, interaction.token, result.message, []);
      }
      if (result.reply) await postFollowup(interaction.application_id, interaction.token, result.reply, true);
    } catch (err) {
      console.error(`button ${interaction.data.custom_id}: could not send the result:`, err);
    }
  })();
}
