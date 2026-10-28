import { readFileSync } from 'node:fs';

// League settings that change rarely and are reviewed in git: config/league.json.
export interface LeagueConfig {
  roles: {
    participatingTrainer: string;
    gymLeader: string;
    gymManager: string;
    nonPlayer: string;
  };
  // Members with any of these Discord roles may approve or reject roster requests.
  staffRoles: string[];
  relegatedGyms: string[];
}

let config: LeagueConfig | undefined;

// Resolves the same from src/ (tsx) and dist/ (compiled): both sit next to config/.
export function getLeagueConfig(): LeagueConfig {
  config ??= JSON.parse(readFileSync(new URL('../config/league.json', import.meta.url), 'utf8'));
  return config!;
}
