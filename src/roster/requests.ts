// Roster requests rows and their staff approval cards (Spec: "Roster requests", "Approval").
import { getLeagueConfig } from '../config.js';
import { listRoles, postMessage, type ActionRow, type Role } from '../discord.js';
import type { Row } from '../sheet-rows.js';
import { mention, type League } from './league.js';

export type RosterRequest = Row<'rosterRequests'>;
export type RequestType = 'add' | 'remove' | 'update-trainer' | 'rebrand' | 'disband';

// R0001, R0002, ... in order, like gym IDs. Callers hold the 'requests' lock
// from reading the tab until the new row is written, so two requests can't share an ID.
export function nextRequestId(league: League): string {
  const max = Math.max(0, ...league.requests.map((r) => Number(/^R(\d+)$/.exec(r.values.request_id)?.[1] ?? 0)));
  return `R${String(max + 1).padStart(4, '0')}`;
}

// The `change` column: "key: value" pairs joined by "; ", e.g. "role: non-playing".
export const formatChange = (change: Record<string, string>) =>
  Object.entries(change).map(([k, v]) => `${k}: ${v}`).join('; ');

export const parseChange = (change: string): Record<string, string> =>
  Object.fromEntries(
    change.split('; ').filter(Boolean).map((pair) => {
      const i = pair.indexOf(': ');
      return [pair.slice(0, i), pair.slice(i + 2)];
    }),
  );

// A role or leadership value as staff and trainers know it: the Discord role name.
export function roleLabel(value: string): string {
  const { roles } = getLeagueConfig();
  const labels: Record<string, string> = {
    trainer: roles.participatingTrainer,
    'non-playing': roles.nonPlayer,
    leader: roles.gymLeader,
    manager: roles.gymManager,
  };
  return labels[value] ?? value;
}

// The change in one line, for the card and the replies. `gym` is how to show the
// request's gym, usually its role mention (see gymMention).
export function describeChange(req: RosterRequest, gym: string): string {
  const change = parseChange(req.change);
  switch (req.type as RequestType) {
    case 'add':
      return `add ${mention(req.target)} to ${gym} as ${roleLabel(change.role)}`;
    default:
      return `${req.type} ${req.change}`;
  }
}

// Server roles change rarely; re-read them at most every 10 minutes.
const ROLE_CACHE_MS = 10 * 60 * 1000;
let roleCache: { guildId: string; at: number; roles: Role[] } | undefined;

// The gym's Discord role as a mention (shown as @Phoenix, never pinging),
// matched by exact name as in the import. Falls back to the plain name.
export async function gymMention(guildId: string, gymName: string): Promise<string> {
  if (!roleCache || roleCache.guildId !== guildId || Date.now() - roleCache.at > ROLE_CACHE_MS) {
    roleCache = { guildId, at: Date.now(), roles: await listRoles(guildId) };
  }
  const role = roleCache.roles.find((r) => r.name === gymName);
  return role ? `<@&${role.id}>` : gymName;
}

function staffChannelId(): string {
  const id = process.env.DISCORD_STAFF_CHANNEL_ID;
  if (!id) throw new Error('DISCORD_STAFF_CHANNEL_ID is not set');
  return id;
}

export const approvalButtons = (requestId: string, disabled = false): ActionRow[] => [
  {
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Approve', custom_id: `approve:${requestId}`, disabled },
      { type: 2, style: 4, label: 'Reject', custom_id: `reject:${requestId}`, disabled },
    ],
  },
];

export function cardText(req: RosterRequest, gym: string, targetName: string, warnings: string[]): string {
  return [
    `**Roster request ${req.request_id}**`,
    `Requester: ${mention(req.requester)}`,
    `Trainer: ${mention(req.target)} (${targetName})`,
    `Gym: ${gym}`,
    `Change: ${describeChange(req, gym)}`,
    ...warnings.map((w) => `Warning: ${w}`),
  ].join('\n');
}

export const postApprovalCard = (text: string, requestId: string) =>
  postMessage(staffChannelId(), text, approvalButtons(requestId));
