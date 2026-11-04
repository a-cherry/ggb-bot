// Roster requests rows and their staff approval cards (Roster Spec: "Making a request", "Approval").
import { getLeagueConfig } from '../config.js';
import { cachedRoles, editMessage, escapeMarkdown, listMessages, postMessage, type ActionRow } from '../discord.js';
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

// The `change` column: a JSON object, e.g. {"role":"non-playing"}, blank when
// empty. JSON because a rebrand's gym name can hold any character.
export const formatChange = (change: Record<string, string>) =>
  Object.keys(change).length ? JSON.stringify(change) : '';

export const parseChange = (change: string): Record<string, string> => (change ? JSON.parse(change) : {});

// Rebrand and disband change the gym itself and have no target trainer.
export const isGymRequest = (type: string) => type === 'rebrand' || type === 'disband';

// A role or leadership value as staff and trainers know it: the Discord role name.
export function roleLabel(value: string): string {
  const { roles } = getLeagueConfig();
  const labels: Record<string, string> = {
    trainer: roles.participatingTrainer,
    'non-playing': roles.nonPlayer,
    leader: roles.gymLeader,
    'vice-leader': roles.gymViceLeader,
  };
  return labels[value] ?? value;
}

// Positions as requests and announcements name them, rather than by Discord role name.
export const leadershipTitle = (leadership: string): string | undefined =>
  ({ leader: 'Gym Leader', 'vice-leader': 'Vice Gym Leader' } as Record<string, string>)[leadership];
export const playerOrCoach = (role: string) => (role === 'non-playing' ? 'coach' : 'player');

// An update-trainer's parts: the leadership it appoints, if any, and the role
// the target moves from and to, if that changes or they step down from leadership.
function trainerUpdate(req: RosterRequest) {
  const change = parseChange(req.change);
  const from = playerOrCoach(req.snapshot_role || 'trainer');
  return {
    appoint: leadershipTitle(change.leadership),
    from: change.role ? from : undefined,
    to: change.role || change.leadership === 'none' ? playerOrCoach(change.role ?? req.snapshot_role) : undefined,
    stepDown: change.leadership === 'none' ? leadershipTitle(req.snapshot_leadership) : undefined,
  };
}

// The update for the trainer-facing post and replies: "appoint @X as Vice Gym
// Leader", "move @X from player to coach", or both.
function describeUpdate(req: RosterRequest): string {
  const { appoint, from, to, stepDown } = trainerUpdate(req);
  const target = mention(req.target);
  const move = to && `from ${stepDown ?? from} to ${to}`;
  if (appoint) return `appoint ${target} as ${appoint}${move ? ` and move them ${move}` : ''}`;
  return `move ${target} ${move}`;
}

// The update for the staff card, which names the trainer on its own line:
// "move from player to coach", "appoint to Vice Gym Leader".
function cardUpdate(req: RosterRequest): string {
  const { appoint, from, to, stepDown } = trainerUpdate(req);
  const move = to && `move from ${stepDown ?? from} to ${to}`;
  return [...(appoint ? [`appoint to ${appoint}`] : []), ...(move ? [move] : [])].join(' and ');
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
      return describeUpdate(req);
    case 'rebrand':
      return `rebrand ${gym} to ${change.emote} **${escapeMarkdown(change.name)}** (${escapeMarkdown(change.abbreviation)})`;
    case 'disband':
      return `disband ${gym}`;
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
  return role ? `<@&${role.id}>` : escapeMarkdown(gymName);
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

// `targetName` is undefined for a rebrand or disband, which have no target trainer.
export function cardText(req: RosterRequest, gym: string, targetName: string | undefined, warnings: string[]): string {
  return [
    `**Roster request ${req.request_id}**`,
    `Requester: ${mention(req.requester)}`,
    ...(targetName === undefined ? [] : [`Trainer: ${mention(req.target)} (${targetName})`]),
    `Gym: ${gym}`,
    `Change: ${req.type === 'update-trainer' ? cardUpdate(req) : describeChange(req, gym)}`,
    ...warnings.map((w) => `Warning: ${w}`),
  ].join('\n');
}

export const postApprovalCard = (text: string, requestId: string) =>
  postMessage(staffChannelId(), text, approvalButtons(requestId));

export const postStaffNotice = (text: string) => postMessage(staffChannelId(), text);

// A staff notice that pings the alert role (config/league.json), or posts
// without a ping if the server has no role by that name.
export async function postStaffAlert(guildId: string, text: string): Promise<void> {
  const name = getLeagueConfig().alertRole;
  const role = (await cachedRoles(guildId)).find((r) => r.name === name);
  await postMessage(staffChannelId(), role ? `<@&${role.id}> ${text}` : text, undefined, role ? [role.id] : []);
}

// How many recent staff channel messages to search for a request's card.
const CARD_SEARCH_PAGES = 5;

// Replaces a request's card text and removes its buttons, e.g. on a cancel.
// The card's message ID isn't stored, so it's found among the staff channel's
// recent messages by its button. Returns false when it isn't found.
export async function closeApprovalCard(requestId: string, outcome: string): Promise<boolean> {
  return !(await closeApprovalCards(new Map([[requestId, outcome]]))).length;
}

// Closes several cards, request ID to outcome line, in one scan of the staff
// channel. Returns the IDs whose card wasn't found or couldn't be edited.
export async function closeApprovalCards(outcomes: Map<string, string>): Promise<string[]> {
  const channelId = staffChannelId();
  const left = new Map(outcomes);
  const failed: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < CARD_SEARCH_PAGES && left.size; page++) {
    const messages = await listMessages(channelId, before);
    for (const m of messages) {
      const button = m.components?.flatMap((row) => row.components).find((b) => b.custom_id?.startsWith('approve:'));
      const requestId = button?.custom_id?.slice('approve:'.length);
      const outcome = requestId && left.get(requestId);
      if (!requestId || !outcome) continue;
      left.delete(requestId);
      try {
        await editMessage(channelId, m.id, `${m.content}\n${outcome}`, []);
      } catch (err) {
        console.error(`${requestId}: staff card could not be closed:`, err);
        failed.push(requestId);
      }
    }
    if (messages.length < 100) break;
    before = messages[messages.length - 1].id;
  }
  return [...failed, ...[...left.keys()].map((id) => `${id} (not found)`)];
}
