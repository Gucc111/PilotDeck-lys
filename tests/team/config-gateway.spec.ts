import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime } from '../../src/model/index.js';
import { createProjectId } from '../../src/pilot/index.js';
import type { AgentProfile, ProfileConfig, TeamCommand, TeamDefinition, TeamLibrary } from '../../src/team/types.js';

test('Team configuration operations create no chats or model/MCP execution, and removed runtime actions are rejected', async t => {
  const base = await mkdtemp(join(tmpdir(), 'pilotdeck-team-config-'));
  const home = join(base, 'home'), project = join(base, 'project');
  await mkdir(join(home, 'skills'), { recursive: true }); await mkdir(project);
  const registration = join(home, 'projects', createProjectId(project));
  await mkdir(registration, { recursive: true }); await writeFile(join(registration, '.cwd'), project);
  await writeFile(join(home, 'pilotdeck.yaml'), `schemaVersion: 1
agent: { model: test/default }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test
      models: { default: {} }
router: { enabled: false }
`);
  let modelCalls = 0;
  const local = createLocalGateway({ pilotHome: home, projectRoot: project, builtinSkillsRoot: join(home, 'skills'),
    env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
    __testModelFactory: snapshot => ({ ...createModelRuntime(snapshot.config.model),
      async *stream() { modelCalls++; throw new Error('Configuration must never call a model.'); },
      async complete() { modelCalls++; throw new Error('Configuration must never call a model.'); },
    }),
  });
  t.after(async () => { local.dispose(); await rm(base, { recursive: true, force: true }); });
  const command = local.gateway.teamCommand!.bind(local.gateway);
  const config = (displayName: string): ProfileConfig => ({ displayName, description: '', systemPrompt: 'Saved role instructions', model: { mode: 'model', provider: 'test', model: 'default' }, workspace: { mode: 'team' }, capabilities: { tools: ['read_file'], skills: [], mcpServers: ['not-connected'] }, optionalCapabilities: [], permissionMode: 'default' });
  const leader = await command({ action: 'profile_save', role: 'leader', config: config('Leader'), requestToken: 'leader' }) as AgentProfile;
  const teammate = await command({ action: 'profile_save', role: 'teammate', config: config('Teammate'), requestToken: 'teammate' }) as AgentProfile;
  const saved = { action: 'team_save' as const, config: { displayName: 'Research', description: '', instructions: '', defaultProjectKey: project, leader: { id: leader.id }, teammates: [{ id: teammate.id }] }, requestToken: 'team' };
  const team = await command(saved) as TeamDefinition;
  assert.equal((await command(saved) as TeamDefinition).id, team.id);
  const fork = await command({ action: 'team_fork', source: { id: team.id }, requestToken: 'fork' }) as TeamDefinition;
  assert.notEqual(fork.id, team.id); assert.equal(fork.leader.id, leader.id);
  await command({ action: 'inventory', projectKey: project });
  const library = await command({ action: 'library' }) as TeamLibrary;
  assert.deepEqual(Object.keys(library).sort(), ['profiles', 'teams']);
  const before = await readFile(join(home, 'team-library', 'state.json'), 'utf8');
  for (const action of ['start', 'probe', 'conversation_get']) {
    await assert.rejects(command({ action, teamId: team.id, requestToken: 'removed' } as unknown as TeamCommand), { code: 'TEAM_INVALID_INPUT' });
  }
  assert.equal(await readFile(join(home, 'team-library', 'state.json'), 'utf8'), before);
  assert.deepEqual((await local.gateway.listSessions({ projectKey: project })).sessions, []);
  assert.deepEqual(await readdir(join(registration, 'chats')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
  assert.equal(modelCalls, 0);
});
