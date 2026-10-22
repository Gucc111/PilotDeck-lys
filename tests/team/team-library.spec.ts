import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TeamService } from '../../src/team/TeamService.js';
import { hash } from '../../src/team/store.js';
import type { AgentProfile, ProfileConfig, TeamDefinition, TeamInventory, TeamLibrary, TeamServiceOptions } from '../../src/team/types.js';

const profileConfig = (displayName = 'Researcher'): ProfileConfig => ({ displayName, description: 'Reusable profile', systemPrompt: 'Inspect evidence before answering.', model: { mode: 'default' }, workspace: { mode: 'team' }, capabilities: { tools: ['read'], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default' });
const inventory: TeamInventory = { tools: [{ name: 'read', description: 'Read files' }, { name: 'bash', description: 'Run commands' }], skills: [{ name: 'research' }], mcpServers: [{ name: 'search' }] };

async function fixture(t: { after: (fn: () => Promise<void>) => void }, overrides: Partial<TeamServiceOptions> = {}) {
  const pilotHome = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-team-library-'));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const inventoryRequests: Array<string | undefined> = [];
  const options: TeamServiceOptions = { pilotHome, inventory: async projectKey => { inventoryRequests.push(projectKey); return structuredClone(inventory); }, ...overrides };
  const service = new TeamService(options);
  const createProfile = async (role: 'leader' | 'teammate', config = profileConfig(role)) => await service.execute({ action: 'profile_save', role, config, requestToken: randomUUID() }) as AgentProfile;
  const createTeam = async () => {
    const leader = await createProfile('leader'), teammate = await createProfile('teammate');
    const team = await service.execute({ action: 'team_save', config: { displayName: 'Research team', description: '', instructions: 'Use evidence.', defaultProjectKey: 'reports', leader: { id: leader.id, revision: leader.revision }, teammates: [{ id: teammate.id, revision: teammate.revision }] }, requestToken: randomUUID() }) as TeamDefinition;
    return { leader, teammate, team };
  };
  return { pilotHome, options, service, inventoryRequests, createProfile, createTeam };
}

test('saving only persists configurations, never creates sessions, and IDs are server generated', async t => {
  const f = await fixture(t);
  const { leader, teammate, team } = await f.createTeam();
  assert.match(leader.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(leader.id, teammate.id);
  assert.equal(team.leader.id, leader.id);
  assert.deepEqual(f.inventoryRequests, []);
  const library = await f.service.execute({ action: 'library' }) as TeamLibrary;
  assert.equal(library.profiles.length, 2);
  assert.equal(library.teams.length, 1);
  assert.deepEqual(Object.keys(library).sort(), ['profiles', 'teams']);
  assert.deepEqual((await readdir(f.pilotHome, { recursive: true })).sort(), ['team-library', path.join('team-library', 'locks'), path.join('team-library', 'state.json')].sort());
  assert.deepEqual(await new TeamService(f.options).execute({ action: 'library' }), library);
});

test('removed execution commands are rejected before creating any files', async t => {
  const f = await fixture(t);
  for (const action of ['start', 'probe', 'conversation_get']) {
    await assert.rejects(f.service.execute({ action, teamId: randomUUID(), sessionKey: 'web:s_team_retired', requestToken: randomUUID() } as never), /command.action: unknown action/);
  }
  assert.deepEqual(await readdir(f.pilotHome), []);
  assert.deepEqual(f.inventoryRequests, []);
});

test('inventory is an explicit read operation independent of saving configurations', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.execute({ action: 'inventory', projectKey: 'reports' }), inventory);
  assert.deepEqual(f.inventoryRequests, ['reports']);
  assert.deepEqual(await readdir(f.pilotHome), []);
});

test('profile edits leave pinned Team configurations unchanged until explicit adoption', async t => {
  const f = await fixture(t);
  const { leader, team } = await f.createTeam();
  const edited = await f.service.execute({ action: 'profile_save', id: leader.id, expectedRevision: 1, role: 'leader', config: { ...leader.config, systemPrompt: 'Changed role', model: { mode: 'model', provider: 'test', model: 'large' } }, requestToken: randomUUID() }) as AgentProfile;
  assert.equal(edited.revision, 2);
  const beforeAdoption = (await f.service.execute({ action: 'library' }) as TeamLibrary).teams[0]!;
  assert.deepEqual(beforeAdoption.leader, leader);
  const updatedTeam = await f.service.execute({ action: 'team_save', id: team.id, expectedRevision: 1, config: { ...team.config, leader: { id: edited.id, revision: edited.revision } }, requestToken: randomUUID() }) as TeamDefinition;
  assert.equal(updatedTeam.revision, 2);
  assert.deepEqual(updatedTeam.leader, edited);
  assert.deepEqual(team.leader, leader);
  await assert.rejects(f.service.execute({ action: 'profile_save', id: leader.id, expectedRevision: 1, role: 'leader', config: leader.config, requestToken: randomUUID() }), /changed/);
  await assert.rejects(f.service.execute({ action: 'team_save', id: team.id, expectedRevision: 1, config: team.config, requestToken: randomUUID() }), /changed/);
});

test('profile forks get new IDs and Team forks reuse selected profile revisions', async t => {
  const f = await fixture(t);
  const { leader, teammate, team } = await f.createTeam();
  const copiedProfile = await f.service.execute({ action: 'profile_fork', source: { id: teammate.id, revision: 1 }, displayName: 'Competitor researcher', requestToken: randomUUID() }) as AgentProfile;
  assert.notEqual(copiedProfile.id, teammate.id);
  assert.deepEqual(copiedProfile.forkedFrom, { id: teammate.id, revision: 1 });
  assert.equal(copiedProfile.revision, 1);
  assert.equal(copiedProfile.config.displayName, 'Competitor researcher');
  const copiedTeam = await f.service.execute({ action: 'team_fork', source: { id: team.id, revision: 1 }, displayName: 'Weekly competitors', requestToken: randomUUID() }) as TeamDefinition;
  assert.notEqual(copiedTeam.id, team.id);
  assert.equal(copiedTeam.leader.id, leader.id);
  assert.deepEqual(copiedTeam.config.teammates, team.config.teammates);
  const library = await f.service.execute({ action: 'library' }) as TeamLibrary;
  assert.equal(library.profiles.length, 3);
  assert.equal(library.teams.length, 2);
});

test('strict input validation rejects forged identities, unknown fields, invalid references and empty teams', async t => {
  const f = await fixture(t);
  const { leader, teammate, team } = await f.createTeam();
  const bad = (config: unknown) => f.service.execute({ action: 'profile_save', role: 'leader', config, requestToken: randomUUID() } as never);
  await assert.rejects(bad({ ...leader.config, id: randomUUID() }), /config.id: unsupported/);
  await assert.rejects(bad({ ...leader.config, model: { mode: 'default', provider: 'test' } }), /config.model.provider/);
  await assert.rejects(bad({ ...leader.config, optionalCapabilities: [{ kind: 'tool', name: 'unselected' }] }), /must reference/);
  await assert.rejects(f.service.execute({ action: 'profile_save', id: randomUUID(), expectedRevision: 1, role: 'leader', config: leader.config, requestToken: randomUUID() }), /not found/);
  await assert.rejects(f.service.execute({ action: 'profile_save', id: '__proto__', expectedRevision: 1, role: 'leader', config: leader.config, requestToken: randomUUID() }), /server-generated UUID/);
  await assert.rejects(f.service.execute({ action: 'team_save', config: { ...team.config, teammates: [] }, requestToken: randomUUID() }), /between 1/);
  await assert.rejects(f.service.execute({ action: 'team_save', config: { ...team.config, leader: { id: teammate.id, revision: 1 } }, requestToken: randomUUID() }), /wrong role/);
  await assert.rejects(f.service.execute({ action: 'team_save', config: { ...team.config, teammates: [team.config.teammates[0]!, team.config.teammates[0]!] }, requestToken: randomUUID() }), /more than once/);
  await assert.rejects(f.service.execute({ action: 'profile_save', id: leader.id, expectedRevision: 1, role: 'teammate', config: leader.config, requestToken: randomUUID() }), /role cannot change/);
});

test('same mutation token returns original result after response loss; changed payload conflicts', async t => {
  const f = await fixture(t);
  const cmd = { action: 'profile_save' as const, role: 'leader' as const, config: profileConfig('lead'), requestToken: randomUUID() };
  const first = await f.service.execute(cmd);
  assert.deepEqual(await new TeamService(f.options).execute(cmd), first);
  await assert.rejects(f.service.execute({ ...cmd, config: { ...cmd.config, displayName: 'changed' } }), /token was already/);
  assert.equal((await f.service.execute({ action: 'library' }) as TeamLibrary).profiles.length, 1);
});

test('archived profiles remain pinned in existing Teams but cannot be newly selected', async t => {
  const f = await fixture(t);
  const { leader, team } = await f.createTeam();
  const archived = await f.service.execute({ action: 'profile_archive', id: leader.id, expectedRevision: 1, archived: true }) as AgentProfile;
  const renamed = await f.service.execute({ action: 'team_save', id: team.id, expectedRevision: 1, config: { ...team.config, displayName: 'Renamed Team' }, requestToken: randomUUID() }) as TeamDefinition;
  assert.deepEqual(renamed.leader, leader);
  await assert.rejects(f.service.execute({ action: 'team_save', config: team.config, requestToken: randomUUID() }), /archived/);
  await assert.rejects(f.service.execute({ action: 'team_fork', source: { id: team.id, revision: 1 }, requestToken: randomUUID() }), /archived/);
  await f.service.execute({ action: 'profile_archive', id: leader.id, expectedRevision: archived.revision, archived: false });
  const restoredTeam = await f.service.execute({ action: 'team_save', config: team.config, requestToken: randomUUID() }) as TeamDefinition;
  assert.equal(restoredTeam.leader.id, leader.id);
});

test('Team archive and restore preserve its selected profiles and configuration', async t => {
  const f = await fixture(t);
  const { team } = await f.createTeam();
  const archived = await f.service.execute({ action: 'team_archive', id: team.id, expectedRevision: 1, archived: true }) as TeamDefinition;
  assert.equal(archived.archived, true);
  assert.deepEqual(archived.config, team.config);
  assert.deepEqual(archived.leader, team.leader);
  const restored = await f.service.execute({ action: 'team_archive', id: team.id, expectedRevision: archived.revision, archived: false }) as TeamDefinition;
  assert.equal(restored.archived, false);
  assert.equal(restored.revision, 3);
});

test('project references cover active configurations and pinned profiles', async t => {
  const f = await fixture(t);
  const fixed = await f.createProfile('teammate', { ...profileConfig(), workspace: { mode: 'fixed', projectKey: 'knowledge' } });
  assert.deepEqual(await f.service.execute({ action: 'project_references', projectKey: 'knowledge' }), { referenced: true });
  const { team } = await f.createTeam();
  assert.deepEqual(await f.service.execute({ action: 'project_references', projectKey: 'reports' }), { referenced: true });
  const pinned = await f.service.execute({ action: 'team_save', id: team.id, expectedRevision: team.revision, config: { ...team.config, teammates: [{ id: fixed.id, revision: fixed.revision }] }, requestToken: randomUUID() }) as TeamDefinition;
  await f.service.execute({ action: 'profile_archive', id: fixed.id, expectedRevision: fixed.revision, archived: true });
  assert.deepEqual(await f.service.execute({ action: 'project_references', projectKey: 'knowledge' }), { referenced: true });
  await f.service.execute({ action: 'team_archive', id: pinned.id, expectedRevision: pinned.revision, archived: true });
  assert.deepEqual(await f.service.execute({ action: 'project_references', projectKey: 'knowledge' }), { referenced: false });
  assert.deepEqual(await f.service.execute({ action: 'project_references', projectKey: 'reports' }), { referenced: false });
});

test('concurrent service instances serialize saves and identical mutation retries', async t => {
  const f = await fixture(t);
  const services = Array.from({ length: 6 }, () => new TeamService(f.options));
  await Promise.all(services.map((service, index) => service.execute({ action: 'profile_save', role: 'teammate', config: profileConfig(`member ${index}`), requestToken: randomUUID() })));
  assert.equal((await f.service.execute({ action: 'library' }) as TeamLibrary).profiles.length, 6);
  const cmd = { action: 'profile_save' as const, role: 'leader' as const, config: profileConfig('Shared retry'), requestToken: randomUUID() };
  const results = await Promise.all(services.map(service => service.execute(cmd) as Promise<AgentProfile>));
  assert.equal(new Set(results.map(item => item.id)).size, 1);
  assert.equal((await f.service.execute({ action: 'library' }) as TeamLibrary).profiles.length, 7);
});

async function legacyLibrary(f: Awaited<ReturnType<typeof fixture>>) {
  const saved = await f.createTeam();
  const stateFile = path.join(f.pilotHome, 'team-library/state.json');
  const { state } = JSON.parse(await readFile(stateFile, 'utf8'));
  const retiredReceipt = { token: 'retired-start', hash: 'old-hash', result: { conversationId: randomUUID() } };
  const legacy = { ...state, version: 1, conversations: [{ id: retiredReceipt.result.conversationId, participants: [{ sessionKey: 'web:s_team_retired', projectKey: 'retired-project' }] }], receipts: [...state.receipts, retiredReceipt] };
  const raw = JSON.stringify({ checksum: hash(legacy), state: legacy }, null, 2) + '\n';
  await writeFile(stateFile, raw);
  return { ...saved, stateFile, legacy, raw, backupName: `state.v1.${hash(raw)}.backup.json` };
}

test('legacy reads expose only configurations without rewriting files; first save backs up all original bytes', async t => {
  const f = await fixture(t);
  const old = await legacyLibrary(f);
  const transcript = path.join(f.pilotHome, 'projects', 'retired-project', 'sessions', 'retired.jsonl');
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(transcript, 'existing user transcript\n');
  const library = await f.service.execute({ action: 'library' }) as TeamLibrary;
  assert.deepEqual(library, { profiles: [old.leader, old.teammate], teams: [old.team] });
  assert.equal(await readFile(old.stateFile, 'utf8'), old.raw);
  assert.ok(!(await readdir(path.dirname(old.stateFile))).some(name => name.includes('backup')));
  assert.deepEqual(await f.service.execute({ action: 'project_references', projectKey: 'retired-project' }), { referenced: false });
  await f.createProfile('teammate');
  const migrated = JSON.parse(await readFile(old.stateFile, 'utf8'));
  assert.equal(migrated.state.version, 2);
  assert.deepEqual(Object.keys(migrated.state).sort(), ['profiles', 'receipts', 'teams', 'version']);
  assert.deepEqual(migrated.state.teams[old.team.id], [old.team]);
  assert.equal(migrated.state.receipts.length, old.legacy.receipts.length);
  assert.ok(migrated.state.receipts.every((receipt: { result: unknown }) => !Object.hasOwn(receipt.result as object, 'conversationId')));
  assert.equal(await readFile(path.join(path.dirname(old.stateFile), old.backupName), 'utf8'), old.raw);
  assert.equal(await readFile(transcript, 'utf8'), 'existing user transcript\n');
  await f.createProfile('teammate');
  assert.deepEqual((await readdir(path.dirname(old.stateFile))).filter(name => name.includes('backup')), [old.backupName]);
});

test('legacy configuration receipts remain idempotent after migration', async t => {
  const f = await fixture(t);
  const cmd = { action: 'profile_save' as const, role: 'leader' as const, config: profileConfig('Reusable request'), requestToken: randomUUID() };
  const original = await f.service.execute(cmd);
  await legacyLibrary(f);
  assert.deepEqual(await new TeamService(f.options).execute(cmd), original);
  assert.equal((await f.service.execute({ action: 'library' }) as TeamLibrary).profiles.length, 3);
});

test('failure to back up legacy storage prevents replacement and leaves user data intact', async t => {
  const f = await fixture(t);
  const old = await legacyLibrary(f);
  await mkdir(path.join(path.dirname(old.stateFile), old.backupName));
  await assert.rejects(f.createProfile('teammate'));
  assert.equal(await readFile(old.stateFile, 'utf8'), old.raw);
  assert.equal((await f.service.execute({ action: 'library' }) as TeamLibrary).profiles.length, 2);
});

test('corrupted configuration store fails closed and is not overwritten', async t => {
  const f = await fixture(t);
  await f.createTeam();
  const stateFile = path.join(f.pilotHome, 'team-library/state.json');
  const stored = JSON.parse(await readFile(stateFile, 'utf8'));
  stored.state.profiles = {};
  const corrupt = JSON.stringify(stored);
  await writeFile(stateFile, corrupt);
  await assert.rejects(f.service.execute({ action: 'library' }), /cannot be read/);
  await assert.rejects(f.createProfile('leader'), /cannot be read/);
  assert.equal(await readFile(stateFile, 'utf8'), corrupt);
});
