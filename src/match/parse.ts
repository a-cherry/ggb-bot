// Match tab parsing. Pure: no Sheets or Discord imports.

// The three blocks of a match tab the bot reads, in one batchGet with
// FORMATTED_VALUE. Cell addresses are fixed anchors on the S5 template (see
// the Sheet contract in the Match Ingestion Implementation Plan); a layout
// edit to the template must update these and the sentinel check.
//   AK1:AP13  gym_id helper (AK1:AL2), season/stage/week (AM1:AO2),
//             name to Discord ID table (AO3:AP13)
//   C17:S19   roster headers (C17, O17) and roster slots (rows 18 and 19)
//   C21:R41   game rows 21 to 39 and the reported score (K41, M41)
export const MATCH_RANGES = ['AK1:AP13', 'C17:S19', 'C21:R41'] as const;

export type MatchRange = (typeof MATCH_RANGES)[number];

// Values as read, keyed by range. Each is the API's 2D array: rows and
// trailing cells that are empty are left out.
export type MatchCells = Record<MatchRange, string[][]>;
