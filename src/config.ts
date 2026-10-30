import { readFileSync } from 'node:fs';

// League settings that change rarely and are reviewed in git: config/league.json.
export interface LeagueConfig {
  roles: {
    participatingTrainer: string;
    gymLeader: string;
    gymViceLeader: string;
    nonPlayer: string;
  };
  // Members with any of these Discord roles may approve or reject roster requests.
  alertRole: string; // pinged on problems staff must fix at once, e.g. a League DB tab the bot can't read
  relegatedGyms: string[];
}

let config: LeagueConfig | undefined;

// Resolves the same from src/ (tsx) and dist/ (compiled): both sit next to config/.
export function getLeagueConfig(): LeagueConfig {
  config ??= JSON.parse(readFileSync(new URL('../config/league.json', import.meta.url), 'utf8'));
  return config!;
}
