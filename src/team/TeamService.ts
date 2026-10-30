import { randomUUID } from 'node:crypto';
import { TeamStore, hash, type LibraryState, type Receipt } from './store.js';
import { command as validateCommand, TeamError } from './validation.js';
import type { AgentProfile, ProfileRef, TeamLibraryCommand as TeamCommand, TeamLibraryCommandResult as TeamCommandResult, TeamDefinition, TeamServiceOptions } from './types.js';

const timestamp = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);

/** Configuration is latest-only; runtime activations own their independent snapshots. */
export class TeamService {
  private readonly store: TeamStore;
  constructor(private readonly options: TeamServiceOptions) { this.store = new TeamStore(options.pilotHome); }
  async resolveTeam(ref: ProfileRef): Promise<TeamDefinition> { const state = await this.store.read(); const team = state.teams[ref.id]; if (!team) throw new TeamError('TEAM_NOT_FOUND', 'Team was not found.'); return clone(this.materializeTeam(state, team)); }
  async execute(input: TeamCommand): Promise<TeamCommandResult> {
    const cmd = validateCommand(input);
    if (cmd.action === 'inventory') return this.options.inventory(cmd.projectKey);
    if (cmd.action === 'library') { const state = await this.store.read(); return clone({ profiles: Object.values(state.profiles), teams: Object.values(state.teams).map(team => this.materializeTeam(state, team)) }); }
    if (cmd.action === 'project_references') { const state = await this.store.read(); const fixed = (profile: AgentProfile) => profile.config.workspace.mode === 'fixed' && profile.config.workspace.projectKey === cmd.projectKey; const profileReference = Object.values(state.profiles).some(fixed); const teamReference = Object.values(state.teams).some(team => { const current = this.materializeTeam(state, team); return current.config.defaultProjectKey === cmd.projectKey || [current.leader, ...current.teammates].some(fixed); }); return { referenced: profileReference || teamReference }; }
    return this.store.locked(async () => {
      const state = await this.store.read(); const requestHash = hash(cmd); const existingReceipt = 'requestToken' in cmd ? state.receipts.find(item => item.token === cmd.requestToken) : undefined;
      if (existingReceipt) { if (existingReceipt.hash !== requestHash) throw new TeamError('TEAM_TOKEN_CONFLICT', 'This request token was already used with different parameters. Start a new attempt.'); return clone(existingReceipt.result); }
      let result: AgentProfile | TeamDefinition;
      switch (cmd.action) {
        case 'profile_save': { const previous = cmd.id ? state.profiles[cmd.id] : undefined; if (cmd.id && !previous) throw new TeamError('TEAM_PROFILE_NOT_FOUND', 'Leader or Teammate was not found.'); if (previous && previous.role !== cmd.role) throw new TeamError('TEAM_ROLE_IMMUTABLE', 'A profile role cannot change. Create a separate Leader or Teammate.'); const profile: AgentProfile = { id: previous?.id ?? randomUUID(), role: cmd.role, config: cmd.config, createdAt: previous?.createdAt ?? timestamp(), updatedAt: timestamp() }; result = profile; state.profiles[profile.id] = profile; for (const team of Object.values(state.teams)) { if (team.config.leader.id === profile.id) team.leader = clone(profile); team.teammates = team.config.teammates.map(ref => ref.id === profile.id ? clone(profile) : (state.profiles[ref.id] ?? team.teammates.find(item => item.id === ref.id)!)).filter((item): item is AgentProfile => Boolean(item)); } break; }
        case 'profile_fork': { const source = state.profiles[cmd.source.id]; if (!source) throw new TeamError('TEAM_PROFILE_NOT_FOUND', 'Leader or Teammate was not found.'); result = { ...clone(source), id: randomUUID(), config: { ...clone(source.config), displayName: cmd.displayName ?? `${source.config.displayName} (copy)` }, createdAt: timestamp(), updatedAt: timestamp() }; state.profiles[result.id] = result; break; }
        case 'profile_delete': { const profile = state.profiles[cmd.id]; if (!profile) throw new TeamError('TEAM_PROFILE_NOT_FOUND', 'Leader or Teammate was not found.'); if (Object.values(state.teams).some(team => team.config.leader.id === cmd.id || team.config.teammates.some(ref => ref.id === cmd.id))) throw new TeamError('TEAM_REFERENCED', 'This profile is used by a Team. Remove it from every Team before deleting it.'); delete state.profiles[cmd.id]; result = profile; break; }
        case 'team_save': { const previous = cmd.id ? state.teams[cmd.id] : undefined; if (cmd.id && !previous) throw new TeamError('TEAM_NOT_FOUND', 'Team was not found.'); const leader = this.profileForTeam(state, cmd.config.leader, 'leader'); const teammates = cmd.config.teammates.map(ref => this.profileForTeam(state, ref, 'teammate')); result = { id: previous?.id ?? randomUUID(), config: { ...cmd.config, leader: { id: leader.id }, teammates: teammates.map(item => ({ id: item.id })) }, leader: clone(leader), teammates: clone(teammates), createdAt: previous?.createdAt ?? timestamp(), updatedAt: timestamp() }; state.teams[result.id] = result; break; }
        case 'team_fork': { const source = state.teams[cmd.source.id]; if (!source) throw new TeamError('TEAM_NOT_FOUND', 'Team was not found.'); const current = this.materializeTeam(state, source); result = { ...clone(current), id: randomUUID(), config: { ...clone(current.config), displayName: cmd.displayName ?? `${current.config.displayName} (copy)` }, createdAt: timestamp(), updatedAt: timestamp() }; state.teams[result.id] = result; break; }
        case 'team_delete': { const team = state.teams[cmd.id]; if (!team) throw new TeamError('TEAM_NOT_FOUND', 'Team was not found.'); delete state.teams[cmd.id]; result = team; break; }
        default: throw new TeamError('TEAM_INVALID_INPUT', 'Unsupported Team configuration action.');
      }
      if ('requestToken' in cmd) state.receipts.push({ token: cmd.requestToken, hash: requestHash, result: clone(result) } as Receipt); await this.store.write(state); return clone(result);
    });
  }
  private profileForTeam(state: LibraryState, ref: ProfileRef, role: 'leader' | 'teammate'): AgentProfile { const profile = state.profiles[ref.id]; if (!profile) throw new TeamError('TEAM_PROFILE_NOT_FOUND', 'Leader or Teammate was not found.'); if (profile.role !== role) throw new TeamError('TEAM_ROLE_MISMATCH', `The selected ${role} has the wrong role.`); return profile; }
  private materializeTeam(state: LibraryState, team: TeamDefinition): TeamDefinition { const leader = state.profiles[team.config.leader.id] ?? team.leader; const teammates = team.config.teammates.map(ref => state.profiles[ref.id] ?? team.teammates.find(item => item.id === ref.id)).filter((item): item is AgentProfile => Boolean(item)); return { ...clone(team), config: { ...team.config, leader: { id: leader.id }, teammates: teammates.map(item => ({ id: item.id })) }, leader: clone(leader), teammates: clone(teammates) }; }
}
