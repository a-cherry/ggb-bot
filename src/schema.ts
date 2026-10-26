// League DB tabs and columns, in sheet order. Source of truth: the
// "Data model the bot relies on" section of the GGB Bot Behavior Spec.
export const TABS = {
  gyms: {
    name: 'Gyms',
    columns: ['gym_id', 'name', 'abbreviation', 'status', 'emote'],
  },
  trainers: {
    name: 'Trainers',
    columns: ['discord_id', 'server_nickname', 'username', 'country', 'gym_id', 'role', 'leadership', 'status'],
  },
  decks: {
    name: 'Decks',
    columns: ['name', 'active'],
  },
  seasons: {
    name: 'Seasons',
    columns: ['season', 'start_date', 'end_date', 'active'],
  },
  divisions: {
    name: 'Divisions',
    columns: ['season', 'gym_id', 'division'],
  },
  matches: {
    name: 'Matches',
    columns: [
      'match_id', 'season', 'stage', 'week', 'gym_left_id', 'gym_right_id',
      'score_left', 'score_right', 'status', 'tab_link', 'submitted_by', 'submitted_at',
    ],
  },
  matchRosters: {
    name: 'Match rosters',
    columns: ['match_id', 'gym_id', 'discord_id'],
  },
  games: {
    name: 'Games',
    columns: [
      'match_id', 'game_number', 'trainer_left', 'deck_left',
      'result_left', 'result_right', 'deck_right', 'trainer_right',
    ],
  },
  rosterRequests: {
    name: 'Roster requests',
    columns: [
      'request_id', 'type', 'requester', 'target', 'gym_id', 'change', 'status',
      'created_at', 'decided_by', 'decided_at', 'refusal_message',
      'snapshot_gym_id', 'snapshot_role', 'snapshot_leadership', 'snapshot_status',
    ],
  },
  rosterHistory: {
    name: 'Roster history',
    columns: [
      'season', 'timestamp', 'discord_id',
      'before_gym_id', 'before_role', 'before_leadership',
      'after_gym_id', 'after_role', 'after_leadership',
      'source', 'request_id',
    ],
  },
  botState: {
    name: 'Bot state',
    columns: ['key', 'value'],
  },
} as const satisfies Record<string, { name: string; columns: readonly string[] }>;

export type TabKey = keyof typeof TABS;

// A1 reference to a whole tab, quoted because names contain spaces.
export const tabRange = (name: string) => `'${name.replace(/'/g, "''")}'`;
