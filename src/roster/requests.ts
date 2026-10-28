// Roster requests rows and their staff approval cards (Spec: "Roster requests", "Approval").
import { getLeagueConfig } from '../config.js';
import { cachedRoles, editMessage, listMessages, postMessage, type ActionRow } from '../discord.js';
import type { Row } from '../sheet-rows.js';
import { findTrainer, mention, type League } from './league.js';

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

// What an update-trainer makes the target, by Discord role name: "Gym Manager",
// "Non-Player", "Non-Player and Gym Manager". A manager stepping down becomes
// Participating Trainer, the role every gym member has.
export function promotionLabel(req: RosterRequest): string {
  const change = parseChange(req.change);
  const labels = [
    ...(change.role ? [roleLabel(change.role)] : []),
    ...(change.leadership === 'leader' || change.leadership === 'manager' ? [roleLabel(change.leadership)] : []),
  ];
  return labels.length ? labels.join(' and ') : roleLabel('trainer');
}

// The change in one line, for the card and the replies. `gym` is how to show the
// request's gym, usually its role mention (see gymMention).
export function describeChange(req: RosterRequest, gym: string): string {
  const change = parseChange(req.change);
  switch (req.type as RequestType) {
    case 'add':
      return `add ${mention(req.target)} to ${gym} as ${roleLabel(change.role)}`;
    case 'remove':
      return `remove ${mention(req.target)} from ${gym}`;
    case 'update-trainer':
      return `promote ${mention(req.target)} to ${promotionLabel(req)}`;
    default:
      return `${req.type} ${req.change}`;
  }
}

// A new pending request, with the target's current Trainers values as its snapshot.
export function newRequest(
  league: League, type: RequestType, requester: string, target: string, gymId: string, change: Record<string, string>,
): RosterRequest {
  const current = findTrainer(league, target);
  return {
    request_id: nextRequestId(league),
    type,
    requester,
    target,
    gym_id: gymId,
    change: formatChange(change),
    status: 'pending',
    created_at: new Date().toISOString(),
    decided_by: '',
    decided_at: '',
    refusal_message: '',
    snapshot_gym_id: current?.gym_id ?? '',
    snapshot_role: current?.role ?? '',
    snapshot_leadership: current?.leadership ?? '',
    snapshot_status: current?.status ?? '',
  };
}

// The gym's Discord role as a mention (shown as @Phoenix, never pinging),
// matched by exact name as in the import. Falls back to the plain name.
export async function gymMention(guildId: string, gymName: string): Promise<string> {
  const role = (await cachedRoles(guildId)).find((r) => r.name === gymName);
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

// How many recent staff channel messages to search for a request's card.
const CARD_SEARCH_PAGES = 5;

// Replaces a request's card text and removes its buttons, e.g. on a cancel.
// The card's message ID isn't stored, so it's found among the staff channel's
// recent messages by its button. Returns false when it isn't found.
export async function closeApprovalCard(requestId: string, outcome: string): Promise<boolean> {
  const channelId = staffChannelId();
  let before: string | undefined;
  for (let page = 0; page < CARD_SEARCH_PAGES; page++) {
    const messages = await listMessages(channelId, before);
    const card = messages.find((m) =>
      m.components?.some((row) => row.components.some((b) => b.custom_id === `approve:${requestId}`)),
    );
    if (card) {
      await editMessage(channelId, card.id, `${card.content}\n${outcome}`, []);
      return true;
    }
    if (messages.length < 100) return false;
    before = messages[messages.length - 1].id;
  }
  return false;
}
