// Every slash command: the definitions npm run register sends to Discord, and
// the deferred handlers src/server.ts routes to by name.
import type { CommandHandler } from '../interactions.js';
import { handleRoster, rosterCommand } from './roster.js';

const pingCommand = { name: 'ping', description: 'Check that the bot is responding', type: 1 };

export const commandDefinitions = [pingCommand, rosterCommand];

// /ping answers at once in server.ts and isn't listed here.
export const deferredCommands: Record<string, CommandHandler> = {
  roster: handleRoster,
};
