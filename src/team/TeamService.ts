import { randomUUID } from 'node:crypto';
import { TeamStore, hash, type LibraryState, type Receipt } from './store.js';
import { command as validateCommand, TeamError } from './validation.js';
import type { AgentProfile, ProfileRef, TeamCommand, TeamCommandResult, TeamDefinition, TeamServiceOptions } from './types.js';

const latest = <T>(items: T[] | undefined): T | undefined => items?.at(-1);
const timestamp = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const sameRef = (a: ProfileRef, b: ProfileRef) => a.id === b.id && a.revision === b.revision;

export class TeamService {
  private readonly store: TeamStore;
  constructor(private readonly options: TeamServiceOptions) { this.store = new TeamStore(options.pilotHome); }

  async execute(input: TeamCommand): Promise<TeamCommandResult> {
    const cmd = validateCommand(input);
    if (cmd.action === 'inventory') return this.options.inventory(cmd.projectKey);
    if (cmd.action === 'library') {
      const state = await this.store.read();
      return clone({ profiles: Object.values(state.profiles).map(items => latest(items)!), teams: Object.values(state.teams).map(items => latest(items)!) });
    }
    if (cmd.action === 'project_references') {
      const state = await this.store.read();
      const fixedProject = (profile: AgentProfile) => profile.config.workspace.mode === 'fixed' && profile.config.workspace.projectKey === cmd.projectKey;
      const profileReference = Object.values(state.profiles).some(history => { const profile = latest(history)!; return !profile.archived && fixedProject(profile); });
      const teamReference = Object.values(state.teams).some(history => {
        const team = latest(history)!;
        return !team.archived && (team.config.defaultProjectKey === cmd.projectKey || [team.leader, ...team.teammates].some(fixedProject));
      });
      return { referenced: profileReference || teamReference };
    }
    return this.store.locked(async () => {
      const state = await this.store.read();
      const requestHash = hash(cmd);
      const existingReceipt = 'requestToken' in cmd ? state.receipts.find(item => item.token === cmd.requestToken) : undefined;
      if (existingReceipt) {
        if (existingReceipt.hash !== requestHash) throw new TeamError('TEAM_TOKEN_CONFLICT', 'This request token was already used with different parameters. Start a new attempt.');
        return clone(existingReceipt.result);
      }
      let result: AgentProfile | TeamDefinition;
      switch (cmd.action) {
        case 'profile_save': {
          const previous = cmd.id ? this.currentProfile(state, cmd.id, cmd.expectedRevision!) : undefined;
          if (previous && previous.role !== cmd.role) throw new TeamError('TEAM_ROLE_IMMUTABLE', 'A profile role cannot change. Create a separate Leader or Teammate.');
          result = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, role: cmd.role, config: cmd.config, archived: previous?.archived ?? false, createdAt: previous?.createdAt ?? timestamp(), updatedAt: timestamp(), ...(previous?.forkedFrom ? { forkedFrom: previous.forkedFrom } : {}) };
          (state.profiles[result.id] ??= []).push(result);
          break;
        }
        case 'profile_fork': {
          const source = this.profileVersion(state, cmd.source);
          result = { ...clone(source), id: randomUUID(), revision: 1, config: { ...clone(source.config), displayName: cmd.displayName ?? `${source.config.displayName} (copy)` }, archived: false, createdAt: timestamp(), updatedAt: timestamp(), forkedFrom: cmd.source };
          state.profiles[result.id] = [result];
          break;
        }
        case 'profile_archive': {
          const previous = this.currentProfile(state, cmd.id, cmd.expectedRevision);
          if (previous.archived === cmd.archived) return clone(previous);
          result = { ...clone(previous), revision: previous.revision + 1, archived: cmd.archived, updatedAt: timestamp() };
          state.profiles[result.id]!.push(result);
          break;
        }
        case 'team_save': {
          const previous = cmd.id ? this.currentTeam(state, cmd.id, cmd.expectedRevision!) : undefined;
          const originalRefs = previous ? [previous.config.leader, ...previous.config.teammates] : [];
          const leader = this.profileForTeam(state, cmd.config.leader, 'leader', originalRefs);
          const teammates = cmd.config.teammates.map(ref => this.profileForTeam(state, ref, 'teammate', originalRefs));
          result = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, config: cmd.config, leader: clone(leader), teammates: clone(teammates), archived: previous?.archived ?? false, createdAt: previous?.createdAt ?? timestamp(), updatedAt: timestamp(), ...(previous?.forkedFrom ? { forkedFrom: previous.forkedFrom } : {}) };
          (state.teams[result.id] ??= []).push(result);
          break;
        }
        case 'team_fork': {
          const source = this.teamVersion(state, cmd.source);
          // Forks are new teams: archived profiles must be restored/replaced before reuse.
          this.profileForTeam(state, source.config.leader, 'leader', []);
          for (const ref of source.config.teammates) this.profileForTeam(state, ref, 'teammate', []);
          result = { ...clone(source), id: randomUUID(), revision: 1, config: { ...clone(source.config), displayName: cmd.displayName ?? `${source.config.displayName} (copy)` }, archived: false, createdAt: timestamp(), updatedAt: timestamp(), forkedFrom: cmd.source };
          state.teams[result.id] = [result];
          break;
        }
        case 'team_archive': {
          const previous = this.currentTeam(state, cmd.id, cmd.expectedRevision);
          if (previous.archived === cmd.archived) return clone(previous);
          result = { ...clone(previous), revision: previous.revision + 1, archived: cmd.archived, updatedAt: timestamp() };
          state.teams[result.id]!.push(result);
          break;
        }
      }
      if ('requestToken' in cmd) state.receipts.push({ token: cmd.requestToken, hash: requestHash, result: clone(result) } as Receipt);
      await this.store.write(state);
      return clone(result);
    });
  }

  private currentProfile(state: LibraryState, id: string, revision: number): AgentProfile {
    const profile = latest(state.profiles[id]);
    if (!profile) throw new TeamError('TEAM_PROFILE_NOT_FOUND', 'Leader or Teammate was not found.');
    if (profile.revision !== revision) throw new TeamError('TEAM_REVISION_CONFLICT', 'This profile changed. Reload before saving your changes.');
    return profile;
  }
  private profileVersion(state: LibraryState, ref: ProfileRef): AgentProfile {
    const profile = state.profiles[ref.id]?.find(item => item.revision === ref.revision);
    if (!profile) throw new TeamError('TEAM_PROFILE_NOT_FOUND', 'The selected profile version was not found.');
    return profile;
  }
  private profileForTeam(state: LibraryState, ref: ProfileRef, role: 'leader' | 'teammate', original: ProfileRef[]): AgentProfile {
    const profile = this.profileVersion(state, ref);
    if (profile.role !== role) throw new TeamError('TEAM_ROLE_MISMATCH', `The selected ${role} has the wrong role.`);
    if (latest(state.profiles[ref.id])!.archived && !original.some(item => sameRef(item, ref))) throw new TeamError('TEAM_PROFILE_ARCHIVED', `${profile.config.displayName} is archived. Restore it or choose another profile.`);
    return profile;
  }
  private teamVersion(state: LibraryState, ref: ProfileRef): TeamDefinition {
    const team = state.teams[ref.id]?.find(item => item.revision === ref.revision);
    if (!team) throw new TeamError('TEAM_NOT_FOUND', 'The selected Team version was not found.');
    return team;
  }
  private currentTeam(state: LibraryState, id: string, revision: number): TeamDefinition {
    const team = latest(state.teams[id]);
    if (!team) throw new TeamError('TEAM_NOT_FOUND', 'Team was not found.');
    if (team.revision !== revision) throw new TeamError('TEAM_REVISION_CONFLICT', 'This Team changed. Reload before continuing.');
    return team;
  }
}
