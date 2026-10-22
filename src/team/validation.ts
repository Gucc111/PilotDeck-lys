import type { ProfileConfig, ProfileRef, TeamCommand, TeamConfig } from './types.js';

export class TeamError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'TeamError'; }
}

function fail(field: string, message: string): never { throw new TeamError('TEAM_INVALID_INPUT', `${field}: ${message}`); }
export function object(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'must be an object');
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) if (!allowed.includes(key)) fail(`${field}.${key}`, 'unsupported field');
  return data;
}
export function text(value: unknown, field: string, options: { empty?: boolean; max?: number } = {}): string {
  if (typeof value !== 'string' || (!options.empty && !value.trim())) fail(field, 'must be a non-empty string');
  if (value.length > (options.max ?? 100_000)) fail(field, 'is too long');
  return value;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 500) fail(field, 'must be an array with at most 500 entries');
  const result = value.map((item, i) => text(item, `${field}[${i}]`, { max: 500 }).trim());
  if (new Set(result).size !== result.length) fail(field, 'must not contain duplicates');
  return result;
}
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(field, 'must be a positive integer');
  return value;
}
function identity(value: unknown, field: string): string {
  const id = text(value, field, { max: 200 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) fail(field, 'must be a server-generated UUID');
  return id;
}
function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(field, 'must be a non-negative finite number');
  return value;
}
export function profileRef(value: unknown, field: string): ProfileRef {
  const data = object(value, field, ['id', 'revision']);
  return { id: identity(data.id, `${field}.id`), revision: positiveInteger(data.revision, `${field}.revision`) };
}

export function profileConfig(value: unknown): ProfileConfig {
  const field = 'config';
  const data = object(value, field, ['displayName', 'description', 'systemPrompt', 'model', 'workspace', 'capabilities', 'optionalCapabilities', 'permissionMode']);
  const model = object(data.model, 'config.model', ['mode', 'provider', 'model', 'reasoning', 'speed']);
  let resolvedModel: ProfileConfig['model'];
  if (model.mode === 'default') {
    object(data.model, 'config.model', ['mode']);
    resolvedModel = { mode: 'default' };
  } else if (model.mode === 'model') {
    const reasoning = optionalNumber(model.reasoning, 'config.model.reasoning');
    const speed = optionalNumber(model.speed, 'config.model.speed');
    resolvedModel = { mode: 'model', provider: text(model.provider, 'config.model.provider', { max: 500 }), model: text(model.model, 'config.model.model', { max: 500 }), ...(reasoning === undefined ? {} : { reasoning }), ...(speed === undefined ? {} : { speed }) };
  } else fail('config.model.mode', 'must be default or model');
  const workspace = object(data.workspace, 'config.workspace', ['mode', 'projectKey']);
  let resolvedWorkspace: ProfileConfig['workspace'];
  if (workspace.mode === 'team') {
    object(workspace, 'config.workspace', ['mode']);
    resolvedWorkspace = { mode: 'team' };
  } else if (workspace.mode === 'fixed') {
    resolvedWorkspace = { mode: 'fixed', projectKey: text(workspace.projectKey, 'config.workspace.projectKey', { max: 500 }) };
  } else fail('config.workspace.mode', 'must be team or fixed');
  const capabilities = object(data.capabilities, 'config.capabilities', ['tools', 'skills', 'mcpServers']);
  const resolvedCapabilities = { tools: strings(capabilities.tools, 'config.capabilities.tools'), skills: strings(capabilities.skills, 'config.capabilities.skills'), mcpServers: strings(capabilities.mcpServers, 'config.capabilities.mcpServers') };
  if (!Array.isArray(data.optionalCapabilities) || data.optionalCapabilities.length > 1_500) fail('config.optionalCapabilities', 'must be an array');
  const optionalCapabilities = data.optionalCapabilities.map((entry, i) => {
    const itemField = `config.optionalCapabilities[${i}]`;
    const item = object(entry, itemField, ['kind', 'name']);
    if (item.kind !== 'tool' && item.kind !== 'skill' && item.kind !== 'mcp') fail(`${itemField}.kind`, 'must be tool, skill, or mcp');
    const name = text(item.name, `${itemField}.name`, { max: 500 }).trim();
    const available = item.kind === 'tool' ? resolvedCapabilities.tools : item.kind === 'skill' ? resolvedCapabilities.skills : resolvedCapabilities.mcpServers;
    if (!available.includes(name)) fail(`${itemField}.name`, 'must reference a selected capability');
    return { kind: item.kind as 'tool' | 'skill' | 'mcp', name };
  });
  if (new Set(optionalCapabilities.map(item => `${item.kind}:${item.name}`)).size !== optionalCapabilities.length) fail('config.optionalCapabilities', 'must not contain duplicates');
  if (data.permissionMode !== 'default' && data.permissionMode !== 'plan' && data.permissionMode !== 'bypassPermissions') fail('config.permissionMode', 'must be default, plan, or bypassPermissions');
  return { displayName: text(data.displayName, 'config.displayName', { max: 200 }).trim(), description: text(data.description, 'config.description', { empty: true, max: 10_000 }), systemPrompt: text(data.systemPrompt, 'config.systemPrompt'), model: resolvedModel, workspace: resolvedWorkspace, capabilities: resolvedCapabilities, optionalCapabilities, permissionMode: data.permissionMode };
}

export function teamConfig(value: unknown): TeamConfig {
  const data = object(value, 'config', ['displayName', 'description', 'instructions', 'defaultProjectKey', 'leader', 'teammates']);
  if (!Array.isArray(data.teammates) || data.teammates.length < 1 || data.teammates.length > 100) fail('config.teammates', 'must contain between 1 and 100 teammates');
  const teammates = data.teammates.map((item, i) => profileRef(item, `config.teammates[${i}]`));
  if (new Set(teammates.map(item => item.id)).size !== teammates.length) fail('config.teammates', 'cannot include the same teammate more than once');
  return { displayName: text(data.displayName, 'config.displayName', { max: 200 }).trim(), description: text(data.description, 'config.description', { empty: true, max: 10_000 }), instructions: text(data.instructions, 'config.instructions', { empty: true }), defaultProjectKey: data.defaultProjectKey === null ? null : text(data.defaultProjectKey, 'config.defaultProjectKey', { max: 500 }), leader: profileRef(data.leader, 'config.leader'), teammates };
}

/** Validate the wire boundary too: TypeScript types do not protect WebSocket input. */
export function command(value: unknown): TeamCommand {
  if (!value || typeof value !== 'object') fail('command', 'must be an object');
  const action = (value as { action?: unknown }).action;
  const fields: Record<string, string[]> = {
    library: [], inventory: ['projectKey'], profile_save: ['id', 'expectedRevision', 'role', 'config', 'requestToken'],
    profile_fork: ['source', 'displayName', 'requestToken'], profile_archive: ['id', 'expectedRevision', 'archived'],
    team_save: ['id', 'expectedRevision', 'config', 'requestToken'], team_fork: ['source', 'displayName', 'requestToken'],
    team_archive: ['id', 'expectedRevision', 'archived'], project_references: ['projectKey'],
  };
  if (typeof action !== 'string' || !Object.hasOwn(fields, action)) fail('command.action', 'unknown action');
  const data = object(value, 'command', ['action', ...fields[action]!]);
  for (const key of ['id', 'projectKey', 'requestToken']) {
    if (data[key] !== undefined) text(data[key], `command.${key}`, { max: 500 });
  }
  if (data.id !== undefined) identity(data.id, 'command.id');
  if (data.expectedRevision !== undefined) positiveInteger(data.expectedRevision, 'command.expectedRevision');
  if (data.archived !== undefined && typeof data.archived !== 'boolean') fail('command.archived', 'must be boolean');
  if (action.endsWith('_save') || action.endsWith('_fork')) text(data.requestToken, 'command.requestToken', { max: 500 });
  if (action.endsWith('_save')) {
    if (data.id === undefined && data.expectedRevision !== undefined) fail('command.expectedRevision', 'requires an existing id');
    if (data.id !== undefined) positiveInteger(data.expectedRevision, 'command.expectedRevision');
  }
  if (action === 'profile_save') {
    if (data.role !== 'leader' && data.role !== 'teammate') fail('command.role', 'must be leader or teammate');
    return { ...data, config: profileConfig(data.config) } as TeamCommand;
  }
  if (action === 'team_save') return { ...data, config: teamConfig(data.config) } as TeamCommand;
  if (action.endsWith('_fork')) return { ...data, source: profileRef(data.source, 'command.source'), ...(data.displayName === undefined ? {} : { displayName: text(data.displayName, 'command.displayName', { max: 200 }).trim() }) } as TeamCommand;
  if (action.endsWith('_archive')) {
    text(data.id, 'command.id', { max: 200 }); positiveInteger(data.expectedRevision, 'command.expectedRevision');
    if (typeof data.archived !== 'boolean') fail('command.archived', 'must be boolean');
  }
  if (action === 'project_references') text(data.projectKey, 'command.projectKey', { max: 500 });
  return { ...data } as TeamCommand;
}
