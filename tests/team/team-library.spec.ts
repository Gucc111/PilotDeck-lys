import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../../src/team/store.js';
import { TeamService } from '../../src/team/TeamService.js';
import type { AgentProfile, ProfileConfig, TeamDefinition, TeamInventory, TeamLibrary, TeamServiceOptions } from '../../src/team/types.js';

const config = (displayName: string): ProfileConfig => ({ displayName, description: 'Reusable profile', systemPrompt: 'Inspect evidence before answering.', model: { mode: 'model', provider: 'test', model: 'large' }, workspace: { mode: 'team' }, capabilities: { tools: ['read'], skills: [], mcpServers: [] }, permissionMode: 'default' });
const inventory: TeamInventory = { tools: [{ name: 'read', description: 'Read files' }], skills: [], mcpServers: [] };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const pilotHome = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-team-library-')); t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const options: TeamServiceOptions = { pilotHome, inventory: async () => structuredClone(inventory) }; const service = new TeamService(options);
  const saveProfile = (role: 'leader' | 'teammate', name: string, id?: string) => service.execute({ action: 'profile_save', ...(id ? { id } : {}), role, config: config(name), requestToken: randomUUID() }) as Promise<AgentProfile>;
  const leader = await saveProfile('leader', 'Leader'); const teammate = await saveProfile('teammate', 'Worker');
  const team = await service.execute({ action: 'team_save', config: { displayName: 'Team', description: '', instructions: '', defaultProjectKey: 'project', leader: { id: leader.id }, teammates: [{ id: teammate.id }] }, requestToken: randomUUID() }) as TeamDefinition;
  return { pilotHome, options, service, leader, teammate, team, saveProfile };
}

test('library persists one latest profile and Team references only IDs', async t => {
  const f = await fixture(t); const edited = await f.saveProfile('leader', 'Updated Leader', f.leader.id);
  const library = await f.service.execute({ action: 'library' }) as TeamLibrary;
  assert.equal(library.profiles.find(item => item.id === f.leader.id)?.config.displayName, 'Updated Leader');
  assert.equal(library.teams[0]?.leader.config.displayName, 'Updated Leader');
  assert.deepEqual(library.teams[0]?.config.leader, { id: f.leader.id });
  assert.equal(edited.id, f.leader.id);
  const raw = JSON.parse(await readFile(path.join(f.pilotHome, 'team-library/state.json'), 'utf8'));
  assert.ok(!JSON.stringify(raw).includes('revision'));
  assert.deepEqual(Object.keys(raw.state.profiles), [f.leader.id, f.teammate.id]);
});

test('resolveTeam follows latest profiles while an existing runtime can keep its own snapshot', async t => {
  const f = await fixture(t); const first = await f.service.resolveTeam({ id: f.team.id });
  await f.saveProfile('teammate', 'Updated Worker', f.teammate.id);
  const latest = await f.service.resolveTeam({ id: f.team.id });
  assert.equal(first.teammates[0]?.config.displayName, 'Worker');
  assert.equal(latest.teammates[0]?.config.displayName, 'Updated Worker');
});

test('referenced profiles cannot be deleted, unreferenced profiles can', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.execute({ action: 'profile_delete', id: f.leader.id, requestToken: randomUUID() }), /used by a Team/);
  const extra = await f.saveProfile('teammate', 'Unused');
  await f.service.execute({ action: 'profile_delete', id: extra.id, requestToken: randomUUID() });
  const library = await f.service.execute({ action: 'library' }) as TeamLibrary;
  assert.equal(library.profiles.some(item => item.id === extra.id), false);
});

test('saving configuration does not create sessions or chat files', async t => {
  const f = await fixture(t); assert.deepEqual(await readdir(f.pilotHome, { recursive: true }), ['team-library', path.join('team-library', 'locks'), path.join('team-library', 'state.json')]);
});

for (const role of ['leader', 'teammate'] as const) {
  for (const tools of [['enter_plan_mode'], ['exit_plan_mode'], ['todo_write']]) {
    test(`${role} normalizes plan dependencies when saving ${tools.join(',')}`, async t => {
      const f = await fixture(t);
      const saved = await f.service.execute({ action: 'profile_save', role, config: { ...config('Plan dependency'), capabilities: { tools, skills: [], mcpServers: [] } }, requestToken: randomUUID() }) as AgentProfile;
      assert.deepEqual(new Set(saved.config.capabilities.tools), new Set(tools[0] === 'todo_write' ? ['todo_write'] : ['enter_plan_mode', 'exit_plan_mode', 'todo_write']));
      assert.equal('optionalCapabilities' in saved.config, false);
    });
  }
}

test('retired Optional configuration is rejected by the save API', async t => {
  const f = await fixture(t);
  const legacyConfig = { ...config('Old client'), optionalCapabilities: [] };
  await assert.rejects(f.service.execute({ action: 'profile_save', role: 'leader', config: legacyConfig, requestToken: randomUUID() }), /optionalCapabilities/);
});

test('legacy stored profiles and embedded team profiles discard Optional and repair plan dependencies', async t => {
  const f = await fixture(t), stateFile = path.join(f.pilotHome, 'team-library/state.json');
  const envelope = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const profile of [envelope.state.profiles[f.leader.id], envelope.state.teams[f.team.id].leader]) {
    profile.config.capabilities.tools = ['enter_plan_mode'];
    profile.config.capabilities.skills = ['missing-legacy-skill'];
    profile.config.optionalCapabilities = [{ kind: 'skill', name: 'missing-legacy-skill' }];
  }
  envelope.checksum = hash(envelope.state); await writeFile(stateFile, JSON.stringify(envelope));
  const service = new TeamService(f.options);
  const library = await service.execute({ action: 'library' }) as TeamLibrary;
  for (const profile of [library.profiles.find(value => value.id === f.leader.id)!, library.teams[0]!.leader]) {
    assert.equal('optionalCapabilities' in profile.config, false);
    assert.deepEqual(profile.config.capabilities.tools, ['enter_plan_mode', 'exit_plan_mode', 'todo_write']);
    assert.deepEqual(profile.config.capabilities.skills, ['missing-legacy-skill']);
  }
  await service.execute({ action: 'profile_save', role: 'teammate', config: config('After migration'), requestToken: randomUUID() });
  await assert.doesNotReject(new TeamService(f.options).execute({ action: 'library' }));
});
