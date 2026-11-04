// Slash command and button plumbing. Discord drops an interaction that isn't
// answered within 3 seconds, and a few Sheets calls can take longer, so every
// interaction here is deferred: the bot acknowledges at once, then fills in the
// result when the handler finishes.
import { InteractionResponseFlags, InteractionResponseType } from 'discord-interactions';
import type { Response } from 'express';
import { editOriginalResponse, postFollowup, type ActionRow, type Member } from './discord.js';
import { LockTimeout } from './locks.js';
import { postStaffAlert } from './roster/requests.js';
import { SheetLayoutError } from './sheet-rows.js';

// Interactions still being worked on, so a shutdown can wait for them.
const inFlight = new Set<Promise<void>>();
const track = (work: Promise<void>) => {
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
};

// Resolves once every interaction in progress has finished.
export const drain = () => Promise.allSettled([...inFlight]);
export const inFlightCount = () => inFlight.size;

// The reply for a handler that threw. A sheet layout problem is also posted to
// staff, since only they can fix it; a lock timeout says to retry; anything
// else is generic.
function failureReply(guildId: string, err: unknown): string {
  if (err instanceof SheetLayoutError) {
    void alertStaff(guildId, err);
    return err.userMessage;
  }
  if (err instanceof LockTimeout) return err.message;
  return 'Something went wrong on the bot side. Please tell staff.';
}

// Staff hear about each broken tab at most this often, however many commands hit it.
const ALERT_EVERY_MS = 10 * 60_000;
const lastAlert = new Map<string, number>();

export async function alertStaff(
  guildId: string, err: SheetLayoutError, consequence = "Commands that use this tab fail until it's fixed.",
): Promise<void> {
  if (Date.now() - (lastAlert.get(err.tab) ?? 0) < ALERT_EVERY_MS) return;
  lastAlert.set(err.tab, Date.now());
  try {
    await postStaffAlert(guildId, `**League DB problem**: ${err.message} ${consequence}`);
  } catch (postErr) {
    console.error('staff alert about the League DB failed to post:', postErr);
  }
}

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

// The reply is shown only to the person who ran the command, with any buttons.
// A public message, if any, is posted in the same channel after it.
export interface CommandResult {
  reply: string;
  components?: ActionRow[];
  publicMessage?: string;
}

export type CommandHandler = (interaction: CommandInteraction) => Promise<string | CommandResult>;

export function runDeferred(res: Response, interaction: CommandInteraction, handler: CommandHandler): void {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  track((async () => {
    let result: CommandResult;
    try {
      const r = await handler(interaction);
      result = typeof r === 'string' ? { reply: r } : r;
    } catch (err) {
      console.error(`/${interaction.data.name} failed:`, err);
      result = { reply: failureReply(interaction.guild_id, err) };
    }
    // The private reply goes first: a follow-up sent while the reply is still
    // "thinking" would replace it and be private too.
    try {
      await editOriginalResponse(interaction.application_id, interaction.token, result.reply, result.components);
      if (result.publicMessage) {
        await postFollowup(interaction.application_id, interaction.token, result.publicMessage);
      }
    } catch (err) {
      console.error(`/${interaction.data.name}: could not send the reply:`, err);
    }
  })());
}

// The fields of a button press the bot uses.
export interface ComponentInteraction {
  application_id: string;
  token: string;
  guild_id: string;
  member: Member;
  data: { custom_id: string };
  message: { id: string; content: string; components?: ActionRow[] };
}

// `message` replaces the text of the message the button is on, with
// `components` as its new buttons (none when left out); `reply` is shown only to
// the person who pressed it; `publicMessage` is posted in the channel.
export interface ComponentResult {
  message?: string;
  components?: ActionRow[];
  reply?: string;
  publicMessage?: string;
}

export type ComponentHandler = (interaction: ComponentInteraction) => Promise<ComponentResult>;

// With `pending`, the message's buttons are swapped for that line at once, so
// the press shows and can't be repeated; a result that leaves the message
// unchanged puts the buttons back.
export function runDeferredUpdate(
  res: Response, interaction: ComponentInteraction, handler: ComponentHandler, pending?: string,
): void {
  if (pending) {
    res.send({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: `${interaction.message.content}\n${pending}`, components: [], allowed_mentions: { parse: ['users'] } },
    });
  } else {
    // Acknowledges without changing the message yet; nothing shows as "thinking".
    res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  track((async () => {
    let result: ComponentResult;
    try {
      result = await handler(interaction);
    } catch (err) {
      console.error(`button ${interaction.data.custom_id} failed:`, err);
      result = { reply: failureReply(interaction.guild_id, err) };
    }
    try {
      if (result.message !== undefined) {
        await editOriginalResponse(interaction.application_id, interaction.token, result.message, result.components ?? []);
      } else if (pending) {
        const { content, components } = interaction.message;
        await editOriginalResponse(interaction.application_id, interaction.token, content, components);
      }
      if (result.reply) await postFollowup(interaction.application_id, interaction.token, result.reply, true);
      if (result.publicMessage) await postFollowup(interaction.application_id, interaction.token, result.publicMessage);
    } catch (err) {
      console.error(`button ${interaction.data.custom_id}: could not send the result:`, err);
    }
  })());
}
