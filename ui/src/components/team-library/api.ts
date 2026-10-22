import { authenticatedFetch } from '../../utils/api';
import type { TeamCommand, TeamCommandResult } from '../../../../src/team/types';

export type { AgentProfile, ProfileConfig, ProfileRef, ProfileRole, TeamConfig, TeamDefinition, TeamInventory, TeamLibrary } from '../../../../src/team/types';
export async function teamCommand<T extends TeamCommandResult>(command: TeamCommand): Promise<T> {
  const response = await authenticatedFetch('/api/team-library', { method: 'POST', body: JSON.stringify(command) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : data?.error?.message || `HTTP ${response.status}`);
  return data as T;
}
export const newRequestToken = () => crypto.randomUUID();
export const refOf = (profile: { id: string; revision: number }) => ({ id: profile.id, revision: profile.revision });
export const workspaceKey = (project: { fullPath?: string; path?: string }) => project.fullPath || project.path || '';
