import type { ProfileConfig, ProfileRole, TeamConfig } from './api';
import { newRequestToken } from './api';
export type ProfileDraft = { kind: 'profile'; role: ProfileRole; id?: string; config: ProfileConfig; requestToken: string; submitted?: boolean; addToTeam?: boolean; replaceProfileId?: string };
export type TeamDraft = { kind: 'team'; id?: string; config: TeamConfig; requestToken: string; submitted?: boolean };
export type LibraryDrafts = { profile?: ProfileDraft; team?: TeamDraft };
export const DRAFT_KEY = 'pilotdeck:team-library:drafts:v1';
export const DEFAULT_LEADER_PROMPT = `You are the Leader of this team. Understand the user's goal, inspect the available context, and define clear work and concrete deliverables.

Use team_send_message to send suitable Teammates the context, scope, and acceptance criteria they need. Members can communicate directly. Coordinate dependencies, answer their questions, and resolve conflicting findings. Handle simple requests directly when collaboration would not help.

Use team_roster when you need current participant IDs or statuses. When the program reports that a Teammate execution ended, use team_turns with its participantId and turnId to read the saved result and ending reason. Check the evidence before reporting completion. A queued message or an ended execution is not proof that the work is finished.

Keep the user informed of meaningful progress, blockers, and decisions. Ask the human when a necessary decision or approval is missing. Respect each member's configured tools, workspace, and approval requirements. Deliver a concise final response with the outcome, verification, and any remaining limitations.`;
export function readDrafts(): LibraryDrafts {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    if (!value || typeof value !== 'object') return {};
    if (value.profile?.config) delete value.profile.config.optionalCapabilities;
    return value;
  } catch { return {}; }
}
export function saveDrafts(value: LibraryDrafts) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(value)); } catch { /* Private mode may reject storage. */ } }
export function newProfileDraft(role: ProfileRole, addToTeam = false): ProfileDraft { return { kind: 'profile', role, addToTeam, requestToken: newRequestToken(), config: { displayName: '', description: '', systemPrompt: role === 'leader' ? DEFAULT_LEADER_PROMPT : '', model: { mode: 'default' }, workspace: { mode: 'team' }, capabilities: { tools: [], skills: [], mcpServers: [] }, permissionMode: 'default' } }; }
export function newTeamDraft(): TeamDraft { return { kind: 'team', requestToken: newRequestToken(), config: { displayName: '', description: '', instructions: '', defaultProjectKey: null, leader: { id: '' }, teammates: [] } }; }
