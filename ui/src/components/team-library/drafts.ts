import type { ProfileConfig, ProfileRole, TeamConfig } from './api';
import { newRequestToken } from './api';
export type ProfileDraft = { kind: 'profile'; role: ProfileRole; id?: string; expectedRevision?: number; config: ProfileConfig; requestToken: string; submitted?: boolean; addToTeam?: boolean; replaceProfileId?: string };
export type TeamDraft = { kind: 'team'; id?: string; expectedRevision?: number; config: TeamConfig; requestToken: string; submitted?: boolean };
export type LibraryDrafts = { profile?: ProfileDraft; team?: TeamDraft };
export const DRAFT_KEY = 'pilotdeck:team-library:drafts:v1';
export function readDrafts(): LibraryDrafts { try { const value = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
export function saveDrafts(value: LibraryDrafts) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(value)); } catch { /* Private mode may reject storage. */ } }
export function newProfileDraft(role: ProfileRole, addToTeam = false): ProfileDraft { return { kind: 'profile', role, addToTeam, requestToken: newRequestToken(), config: { displayName: '', description: '', systemPrompt: '', model: { mode: 'default' }, workspace: { mode: 'team' }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default' } }; }
export function newTeamDraft(): TeamDraft { return { kind: 'team', requestToken: newRequestToken(), config: { displayName: '', description: '', instructions: '', defaultProjectKey: null, leader: { id: '', revision: 1 }, teammates: [] } }; }
