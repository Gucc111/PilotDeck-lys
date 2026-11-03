import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createProjectId } from '../../src/pilot/index.js';
import { createModelRuntime, type CanonicalModelRequest, type CanonicalModelEvent, type ModelRuntimeOptions } from '../../src/model/index.js';
import { createAgentProjectSessionStorage, readTranscript } from '../../src/session/index.js';
import type { AgentProfile, ProfileConfig, TeamDefinition } from '../../src/team/types.js';
import type { TeamRuntimeProbe, TeamRuntimeView } from '../../src/team/runtimeTypes.js';
import type { GatewayEvent, GatewaySubmitTurnInput } from '../../src/gateway/protocol/types.js';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';

async function fixture(t: test.TestContext, tools = ['get_current_time'], permissionMode: ProfileConfig['permissionMode'] = 'bypassPermissions') {
  const base = await mkdtemp(join(tmpdir(), 'team-session-')), home = join(base, 'home'), workspace = join(base, 'workspace');
  await mkdir(home); await mkdir(workspace); await mkdir(join(home, 'skills'));
  const registration = join(home, 'projects', createProjectId(workspace));
  await mkdir(registration, { recursive: true }); await writeFile(join(registration, '.cwd'), workspace);
  await writeFile(join(home, 'pilotdeck.yaml'), `schemaVersion: 1
agent: { model: test/ordinary, maxContextTokens: 32768, maxOutputTokens: 4096 }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models: { ordinary: {}, leader: {}, worker: {} }
`);
  const requests: CanonicalModelRequest[] = [], broadcasts: Array<{ name: string; payload: any }> = [];
  let respond: (request: CanonicalModelRequest) => AsyncIterable<CanonicalModelEvent> = async function* () { yield { type: 'text_delta', text: 'done' }; };
  const options = { pilotHome: home, projectRoot: workspace, builtinSkillsRoot: join(home, 'skills'), env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
    __testModelFactory: (snapshot: any) => ({ ...createModelRuntime(snapshot.config.model), async *stream(request: CanonicalModelRequest, runtimeOptions?: ModelRuntimeOptions) {
      if (runtimeOptions?.dispatchRequest) {
        const sent = await runtimeOptions.dispatchRequest({ request, start: accepted => Promise.resolve({ accepted }) });
        request = sent.request;
      }
      requests.push(request); yield { type: 'request_started' as const, provider: request.provider, model: request.model }; yield { type: 'message_start' as const, role: 'assistant' as const };
      yield* respond(request); yield { type: 'message_end' as const, finishReason: 'stop' as const };
    }, async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '' }], finishReason: 'stop' as const }; } }),
  };
  let local = createLocalGateway(options);
  const bind = () => local.bindServer({ broadcastNotification: (name, payload) => broadcasts.push({ name, payload }) }); bind();
  t.after(async () => { await local.dispose(); await rm(base, { recursive: true, force: true }); });
  const profile = async (role: 'leader' | 'teammate', model: string) => local.gateway.teamCommand!({ action: 'profile_save', role, requestToken: role, config: {
    displayName: role, description: '', systemPrompt: `ROLE_MARKER_${role}`, model: { mode: 'model', provider: 'test', model }, workspace: { mode: 'team' },
    capabilities: { tools, skills: [], mcpServers: [] }, permissionMode,
  } }) as Promise<AgentProfile>;
  const leader = await profile('leader', 'leader'), worker = await profile('teammate', 'worker');
  const team = await local.gateway.teamCommand!({ action: 'team_save', requestToken: 'team', config: { displayName: 'Release review', description: '', instructions: 'TEAM_MARKER', defaultProjectKey: workspace, leader: { id: leader.id }, teammates: [{ id: worker.id }] } }) as TeamDefinition;
  const sessionKey = 'web:team-test';
  return { home, workspace, sessionKey, requests, broadcasts, team, leader, worker,
    get gateway() { return local.gateway; }, get registry() { return local.registry; }, setResponse(value: typeof respond) { respond = value; },
    async view() { return (await local.gateway.teamCommand!({ action: 'runtime_get', sessionKey }) as TeamRuntimeView).activation!; },
    async send(text: string, requestToken: string) {
      const activation = (await local.gateway.teamCommand!({ action: 'runtime_get', sessionKey }) as TeamRuntimeView).activation!;
      return (local.registry as any).teamRuntime.send({ sessionKey, activationId: activation.id, stopVersion: activation.stopVersion, participantId: leader.id }, { recipientId: worker.id, text, requestToken });
    },
    async restart() { await local.dispose(); local = createLocalGateway(options); bind(); },
    async select(storageProjectKey = workspace) { return await local.gateway.teamCommand!({ action: 'runtime_select', sessionKey, storageProjectKey, team: { id: team.id }, requestToken: 'select' }) as TeamRuntimeView; },
    async submit(extra: Partial<GatewaySubmitTurnInput> = {}) { const events: GatewayEvent[] = []; const view = await local.gateway.teamCommand!({ action: 'runtime_get', sessionKey }).catch(() => ({activation:null})) as TeamRuntimeView; const epoch = view.activation && !extra.teamSelection ? {teamActivationId: view.activation.id, teamStopVersion:view.activation.stopVersion} : {}; for await (const event of local.gateway.submitTurn({ sessionKey, projectKey: workspace, channelKey: 'web', message: 'hello', ...epoch, ...extra })) events.push(event); return events; },
  };
}

test('Team binds current conversation with frozen persona/model/capabilities and reopens after restart', async t => {
  const f = await fixture(t);
  const { activation } = await f.select(); assert.ok(activation); assert.equal(f.requests.length, 0);
  const events = await f.submit({ runId: 'one', teamActivationId: activation.id, modelSelection: { mode: 'model', provider: 'test', model: 'ordinary' } });
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  const request = f.requests[0]!;
  assert.equal(request.model, 'leader'); assert.match(request.systemPrompt!, /You are PilotDeck/); assert.match(request.systemPrompt!, /ROLE_MARKER_leader/); assert.match(request.systemPrompt!, /TEAM_MARKER/);
  assert.ok(request.tools?.some(tool => tool.name === 'team_send_message')); assert.ok(request.tools?.some(tool => tool.name === 'get_current_time'));
  assert.deepEqual(request.tools?.filter(tool => tool.name.startsWith('team_')).map(tool => tool.name).sort(), ['team_messages', 'team_roster', 'team_send_message', 'team_turns']);
  assert.ok(!request.tools?.some(tool => ['bash', 'agent', 'task_create', 'read_skill'].includes(tool.name)));
  await f.restart(); await f.submit({ runId: 'two' });
  assert.equal(f.requests.at(-1)!.model, 'leader'); assert.match(f.requests.at(-1)!.systemPrompt!, /ROLE_MARKER_leader/);
  const stale = await f.submit({ teamActivationId: null }); assert.ok(stale.some(event => event.type === 'error' && event.code === 'TEAM_ACTIVATION_CHANGED'));
  const tamper = await f.submit({ workspaceCwd: f.home }); assert.ok(tamper.some(event => event.type === 'error' && event.code === 'TEAM_WORKSPACE_CONFLICT'));
  await assert.rejects(f.gateway.closeSession({ sessionKey: f.sessionKey, reason: 'session_deleted' }), /Team execution history/);
});

for (const configured of [true, false]) test(`Plan tool visibility follows role capabilities for Leader and Teammate (configured=${configured})`, async t => {
  const f = await fixture(t, configured ? ['enter_plan_mode', 'exit_plan_mode'] : [], 'default');
  const checkTools = (request: CanonicalModelRequest) => {
    for (const name of ['enter_plan_mode', 'exit_plan_mode', 'todo_write']) {
      assert.equal(request.tools?.some(tool => tool.name === name), configured, `${request.model}: ${name}`);
    }
  };
  await f.select();
  // The server derives Team capabilities even if a client supplies the opposite flag.
  await f.submit({ runId: 'first', allowPlanModeTools: !configured });
  checkTools(f.requests.at(-1)!);
  await f.restart();
  await f.submit({ runId: 'after-restart', allowPlanModeTools: !configured });
  checkTools(f.requests.at(-1)!);
  for (let round = 0; round < 2; round++) {
    await f.send('inspect tools', `plan-capabilities-${round}`);
    await eventually(async () => (await f.view()).turns!.filter(turn => turn.participantId === f.worker.id && turn.status === 'ended').length === round + 1, 'member capabilities turn');
    checkTools(f.requests.filter(request => request.model === 'worker').at(-1)!);
  }
  assert.equal(f.requests.filter(request => request.model === 'worker').length, 2);
  const ordinary = await f.submit({ sessionKey: 'web:ordinary', runId: 'ordinary', teamActivationId: undefined, teamStopVersion: undefined });
  assert.deepEqual(ordinary.filter(event => event.type === 'error'), []);
  assert.ok(!f.requests.at(-1)!.tools?.some(tool => ['enter_plan_mode', 'exit_plan_mode'].includes(tool.name)));
});

test('Leader enters Plan with configured tools, reads a member turn and cannot send messages', async t => {
  const f = await fixture(t, ['enter_plan_mode', 'exit_plan_mode'], 'default');
  let delegated = false, planning = false, step = 0, turnId = '';
  f.setResponse(async function* (request) {
    if (request.model === 'leader') {
      let call: { name: string; input: Record<string, unknown> } | undefined;
      if (!planning && !delegated) {
        delegated = true;
        call = { name: 'team_send_message', input: { recipientId: f.worker.id, text: 'seed result' } };
      } else if (planning) {
        call = [
          { name: 'enter_plan_mode', input: {} },
          { name: 'team_roster', input: {} },
          { name: 'team_turns', input: { participantId: f.worker.id, turnId } },
          { name: 'team_send_message', input: { recipientId: f.worker.id, text: 'blocked' } },
        ][step++];
      }
      if (call) {
        const id = planning ? `plan-${step}` : 'seed';
        yield { type: 'tool_call_start', id, name: call.name };
        yield { type: 'tool_call_end', toolCall: { id, ...call } }; return;
      }
    }
    yield { type: 'text_delta', text: request.model === 'worker' ? 'SAVED_TEAM_RESULT' : 'done' };
  });
  await f.select(); await f.submit({ runId: 'seed-turn' });
  await eventually(async () => {
    const view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
    return !!view.activation!.turns?.some(turn => turn.participantId === f.worker.id && turn.status === 'ended') && view.activation!.messages.every(message => message.status === 'consumed') && !(f.gateway as any).router.activeTurnRunId(f.sessionKey);
  }, 'seed work and Leader continuation finish');
  const before = (await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView).activation!;
  turnId = before.turns!.find(turn => turn.participantId === f.worker.id)!.turnId; planning = true;
  const events = await f.submit({ runId: 'plan-turn' });
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  const results = events.filter(event => event.type === 'tool_call_finished');
  for (const name of ['enter_plan_mode', 'team_turns']) {
    assert.ok(results.some(event => event.toolName === name && event.ok), `${name} succeeds`);
  }
  assert.ok(results.some(event => event.toolName === 'team_turns' && event.resultPreview?.includes('SAVED_TEAM_RESULT')));
  for (const name of ['team_send_message']) {
    assert.ok(results.some(event => event.toolName === name && !event.ok && event.resultPreview?.includes('PLAN_MODE_VIOLATION')), `${name} stays blocked`);
  }
  const after = (await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView).activation!;
  assert.deepEqual(after.messages.map(({ owner: _owner, ...message }) => message), before.messages.map(({ owner: _owner, ...message }) => message));
});

test('forbidden direct, alias and execute_code nested tool calls cannot escape the role registry', async t => {
  const f = await fixture(t, ['execute_code']); let count = 0;
  const forbidden = join(f.workspace, 'forbidden.txt');
  f.setResponse(async function* () {
    const calls = [
      { name: 'write_file', input: { path: forbidden, content: 'direct' } },
      { name: 'Write', input: { file_path: forbidden, content: 'alias' } },
      { name: 'execute_code', input: { code: `from pilotdeck_tools import write_file\ntry:\n    write_file(path=${JSON.stringify(forbidden)}, content="nested")\nexcept Exception as error:\n    print("DENIED", str(error))` } },
    ];
    const call = calls[count++]; if (!call) { yield { type: 'text_delta', text: 'done' }; return; }
    const id = `attempt-${count}`; yield { type: 'tool_call_start', id, name: call.name }; yield { type: 'tool_call_end', toolCall: { id, ...call } };
  });
  const { activation } = await f.select(); const events = await f.submit({ runId: 'capabilities', teamActivationId: activation!.id });
  assert.ok(events.some(event => event.type === 'tool_call_finished' && event.toolCallId === 'attempt-1' && !event.ok));
  assert.ok(events.some(event => event.type === 'tool_call_finished' && event.toolCallId === 'attempt-2' && !event.ok));
  assert.ok(events.some(event => event.type === 'tool_call_finished' && event.toolCallId === 'attempt-3' && event.resultPreview?.includes('DENIED')));
  await assert.rejects(stat(forbidden), { code: 'ENOENT' });
});

test('unauthorized skills are absent from context and reader; unauthorized MCP is never connected', async t => {
  const f = await fixture(t, ['read_skill']);
  const skillDir = join(f.home, 'skills', 'private-recipe'); await mkdir(skillDir);
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: private-recipe\ndescription: SECRET_SKILL_DESCRIPTION\n---\nSECRET_SKILL_CONTENT');
  const marker = join(f.home, 'unauthorized-mcp-started');
  await writeFile(join(f.home, 'mcp.json'), JSON.stringify({ mcpServers: { unauthorized: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`] } } }));
  let requested = false;
  f.setResponse(async function* () {
    if (!requested) { requested = true; yield { type: 'tool_call_start', id: 'skill-attempt', name: 'ReadSkill' }; yield { type: 'tool_call_end', toolCall: { id: 'skill-attempt', name: 'ReadSkill', input: { skillName: 'private-recipe' } } }; return; }
    yield { type: 'text_delta', text: 'done' };
  });
  const { activation } = await f.select(); const events = await f.submit({ teamActivationId: activation!.id });
  assert.ok(!f.requests.some(request => request.systemPrompt?.includes('SECRET_SKILL_DESCRIPTION')));
  assert.ok(!JSON.stringify(f.requests).includes('SECRET_SKILL_CONTENT'));
  assert.ok(events.some(event => event.type === 'tool_call_finished' && event.toolCallId === 'skill-attempt' && event.resultPreview?.includes('No skills')));
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('missing runtime records never silently demote a Team conversation to ordinary chat', async t => {
  const f = await fixture(t); const { activation } = await f.select();
  await f.submit({ runId: 'journal-one', teamActivationId: activation!.id });
  await rm(join(f.home, 'team-runtime', 'state.json'));
  const events = await f.submit({ runId: 'journal-two' });
  assert.ok(events.some(event => event.type === 'error' && event.code === 'TEAM_RUNTIME_MISSING')); assert.equal(f.requests.length, 1);
  await assert.rejects(f.gateway.readSessionMessages!({ sessionKey: f.sessionKey, projectKey: f.workspace }), /Team records are missing/);
  await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }), /Team records are missing/);
  await assert.rejects(f.gateway.closeSession({ sessionKey: f.sessionKey, reason: 'session_deleted' }), /Team records are missing/);
  await assert.rejects(f.gateway.forkSession!({ sessionKey: f.sessionKey, projectKey: f.workspace, fromEntryId: 'irrelevant' }), /Team records are missing/);
});

test('existing conversation storage is authoritative for Team preview, selection and first-send binding after restart', async t => {
  const f = await fixture(t);
  const otherProject = join(f.home, 'other-project'); await mkdir(otherProject);
  const registration = join(f.home, 'projects', createProjectId(otherProject));
  await mkdir(registration, { recursive: true }); await writeFile(join(registration, '.cwd'), otherProject);
  const existing = await f.submit({ runId: 'ordinary-history', message: 'original project history' });
  assert.deepEqual(existing.filter(event => event.type === 'error'), []);
  const team = { id: f.team.id };
  await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_select', sessionKey: f.sessionKey, storageProjectKey: otherProject, projectKey: otherProject, team, requestToken: 'cached-forgery' }), /cannot change.*storage project/);
  await f.restart();
  await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_probe', sessionKey: f.sessionKey, storageProjectKey: otherProject, projectKey: otherProject, team }), /cannot change.*storage project/);
  await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_select', sessionKey: f.sessionKey, storageProjectKey: otherProject, projectKey: otherProject, team, requestToken: 'restart-forgery' }), /cannot change.*storage project/);
  await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_select', sessionKey: f.sessionKey, projectKey: otherProject, team, requestToken: 'omitted-location-forgery' }), /current conversation's project/);
  const forgedSend = await f.submit({ projectKey: otherProject, runId: 'forged-first-send', teamSelection: { team, projectKey: otherProject, requestToken: 'forged-first-select' } });
  assert.ok(forgedSend.some(event => event.type === 'error' && event.code === 'TEAM_WORKSPACE_CONFLICT'));
  const selected = await f.gateway.teamCommand!({ action: 'runtime_select', sessionKey: f.sessionKey, team, requestToken: 'infer-real-location' }) as TeamRuntimeView;
  assert.equal(selected.activation!.storageProjectKey, f.workspace); assert.equal(selected.activation!.projectKey, f.workspace);
  await f.submit({ runId: 'continue-existing', teamActivationId: selected.activation!.id });
  assert.ok(JSON.stringify(f.requests.at(-1)!.messages).includes('original project history'));
  const otherStorage = createAgentProjectSessionStorage({ projectRoot: otherProject, pilotHome: f.home, sessionId: f.sessionKey });
  assert.equal((await readTranscript(otherStorage.transcriptPath)).entries.length, 0);
});

test('General conversation storage cannot be replaced by its selected Team execution project', async t => {
  const f = await fixture(t); await f.submit({ projectKey: f.home, runId: 'general-before-team' }); await f.restart();
  const team = { id: f.team.id };
  await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_select', sessionKey: f.sessionKey, storageProjectKey: f.workspace, team, requestToken: 'general-forgery' }), /cannot change.*storage project/);
  const selected = await f.gateway.teamCommand!({ action: 'runtime_select', sessionKey: f.sessionKey, team, requestToken: 'general-inferred' }) as TeamRuntimeView;
  assert.equal(selected.activation!.storageProjectKey, f.home); assert.equal(selected.activation!.projectKey, f.workspace);
});

test('stop while async Team preflight is pending prevents session creation and human acceptance', async () => {
  let release!: () => void, entered!: () => void, created = 0, accepted = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const router = new SessionRouter({ createSession: () => { created++; throw new Error('must not create a session'); }, idleSweepIntervalMs: 0 });
  const gateway = new InProcessGateway(router, {
    prepareTurn: async input => { entered(); await pending; return { input }; },
    afterInputAccepted: async () => { accepted++; },
  });
  try {
    const consume = (async () => { const events: GatewayEvent[] = []; for await (const event of gateway.submitTurn({ sessionKey: 'preflight', channelKey: 'web', message: 'hello' })) events.push(event); return events; })();
    await started; await gateway.abortSessionExecution('preflight', 'team_stopped'); release();
    const events = await consume; assert.equal(created, 0); assert.equal(accepted, 0);
    assert.ok(events.some(event => event.type === 'error' && event.code === 'TURN_ABORTED'));
  } finally { router.shutdown(); }
});

test('first input selection is durable and duplicate retry/restart never calls model twice', async t => {
  const f = await fixture(t);
  const input = { runId: 'stable-input', teamSelection: { team: { id: f.team.id }, requestToken: 'first-send' } };
  const first = await f.submit(input); assert.deepEqual(first.filter(event => event.type === 'error'), []); assert.equal(f.requests.length, 1);
  await f.restart(); const retry = await f.submit(input);
  assert.ok(retry.some(event => event.type === 'input_accepted')); assert.equal(f.requests.length, 1);
  const conflict = await f.submit({ ...input, message: 'changed' }); assert.ok(conflict.some(event => event.type === 'error' && event.code === 'TEAM_INPUT_CONFLICT'));
});

test('Leader cannot run from an unregistered local absolute directory', async t => {
  const f = await fixture(t, ['get_current_time'], 'bypassPermissions');
  const leaderDirectory = join(f.workspace, '..', 'unregistered-leader'); await mkdir(leaderDirectory);
  const saved = await f.gateway.teamCommand!({ action: 'profile_save', role: 'leader', requestToken: 'unregistered-leader', config: { ...f.leader.config, workspace: { mode: 'fixed', projectKey: leaderDirectory } } }) as AgentProfile;
  const team = await f.gateway.teamCommand!({ action: 'team_save', requestToken: 'unregistered-leader-team', config: { ...f.team.config, leader: { id: saved.id } } }) as TeamDefinition;
  await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_select', sessionKey: f.sessionKey, team: { id: team.id }, requestToken: 'unregistered-leader-select' }), error => {
    assert.equal((error as { code?: string }).code, 'TEAM_INCOMPATIBLE');
    assert.match((error as Error).message, /Unknown projectKey/);
    assert.match((error as Error).message, /Leader workspace conflicts/);
    return true;
  });
  assert.equal(f.requests.length, 0);
});

test('Teammate can run from an unregistered local absolute directory', async t => {
  const f = await fixture(t, ['get_current_time'], 'bypassPermissions');
  const teammateDirectory = join(f.workspace, '..', 'unregistered-teammate'); await mkdir(teammateDirectory);
  const saved = await f.gateway.teamCommand!({ action: 'profile_save', role: 'teammate', requestToken: 'unregistered-teammate', config: { ...f.worker.config, workspace: { mode: 'fixed', projectKey: teammateDirectory } } }) as AgentProfile;
  const team = await f.gateway.teamCommand!({ action: 'team_save', requestToken: 'unregistered-team', config: { ...f.team.config, teammates: [{ id: saved.id }] } }) as TeamDefinition;
  const selected = await f.gateway.teamCommand!({ action: 'runtime_select', sessionKey: f.sessionKey, team: { id: team.id }, requestToken: 'unregistered-select' }) as TeamRuntimeView;
  const participant = selected.activation!.participants.find(item => item.id === saved.id)!;
  assert.equal(participant.projectKey, teammateDirectory);
  await (f.registry as any).teamRuntime.send({ sessionKey: f.sessionKey, activationId: selected.activation!.id, stopVersion: selected.activation!.stopVersion, participantId: f.leader.id }, { recipientId: saved.id, text: 'inspect directory', requestToken: 'unregistered-member' });
  for (let i = 0; i < 100 && !f.broadcasts.some(item => item.name === 'team_runtime_event' && item.payload.event.type === 'turn_completed'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const workerRequest = f.requests.find(request => request.model === 'worker');
  assert.ok(workerRequest, JSON.stringify(f.broadcasts.map(item => item.payload.event))); assert.match(workerRequest.systemPrompt!, new RegExp(teammateDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

});

test('General conversation retains its transcript path while Team runs in registered project', async t => {
  const f = await fixture(t); const { activation } = await f.select(f.home);
  const events = await f.submit({ projectKey: f.home, teamActivationId: activation!.id, runId: 'general' }); assert.deepEqual(events.filter(event => event.type === 'error'), []);
  const storage = createAgentProjectSessionStorage({ projectRoot: f.home, pilotHome: f.home, sessionId: f.sessionKey });
  assert.equal((await readTranscript(storage.transcriptPath)).entries.filter(entry => entry.type === 'accepted_input').length, 1);
  assert.match(f.requests[0]!.systemPrompt!, new RegExp(f.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('async teammate execution stays internal and durable results resume Leader in the same chat', async t => {
  const f = await fixture(t, ['get_current_time'], 'default'); let delegated = false;
  f.setResponse(async function* (request) {
    if (request.model === 'worker') { yield { type: 'text_delta', text: 'worker-result' }; return; }
    if (!delegated) { delegated = true; yield { type: 'tool_call_start', id: 'send-1', name: 'team_send_message' }; yield { type: 'tool_call_end', toolCall: { id: 'send-1', name: 'team_send_message', input: { recipientId: f.worker.id, text: 'inspect release' } } }; return; }
    yield { type: 'text_delta', text: 'leader-result' };
  });
  const { activation } = await f.select(); await f.submit({ runId: 'delegate', teamActivationId: activation!.id });
  for (let i = 0; i < 100 && !f.broadcasts.some(item => item.name === 'team_runtime_event' && item.payload.event.type === 'turn_completed'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  const turn = view.activation!.turns!.find(turn => turn.participantId === f.worker.id)!;
  assert.equal(turn.status, 'ended'); assert.match(JSON.stringify(turn.finalMessage), /worker-result/);
  const workerRequest = f.requests.find(request => request.model === 'worker')!; assert.ok(workerRequest); assert.match(workerRequest.systemPrompt!, /ROLE_MARKER_teammate/);
  assert.ok(!JSON.stringify(workerRequest.messages).includes('hello'));
  assert.ok(f.broadcasts.some(item => item.name === 'team_runtime_event' && item.payload.sessionKey === f.sessionKey && item.payload.event.type === 'assistant_text_delta'));
  const listed = await f.gateway.listSessions({ projectKey: f.workspace }); assert.equal(listed.sessions.length, 1);
  assert.ok(!JSON.stringify(listed.sessions[0]).includes('Team messages are waiting.'));
  assert.equal(listed.sessions[0]!.firstPrompt, 'hello');
  const visible = await f.gateway.readSessionMessages!({ sessionKey: f.sessionKey, projectKey: f.workspace });
  assert.ok(!JSON.stringify(visible.messages).includes('Team messages are waiting.'));
  const storage = createAgentProjectSessionStorage({ projectRoot: f.workspace, pilotHome: f.home, sessionId: f.sessionKey });
  const entries = (await readTranscript(storage.transcriptPath)).entries;
  assert.ok(entries.some(entry => entry.type === 'accepted_input' && entry.messages.some(message => message.metadata?.synthetic === true)));
  assert.ok((await readdir(join(f.home, 'team-runtime', 'contexts', activation!.id))).length > 0);
});

test('separate member message turns give reused tool call IDs distinct retry namespaces', async t => {
  const f = await fixture(t, [], 'default'); let workerRequests = 0;
  f.setResponse(async function* (request) {
    if (request.model === 'worker' && ++workerRequests % 2 === 1) {
      yield { type: 'tool_call_start', id: 'reused-call-id', name: 'team_send_message' };
      yield { type: 'tool_call_end', toolCall: { id: 'reused-call-id', name: 'team_send_message', input: { recipientId: f.leader.id, text: workerRequests === 1 ? 'first continuation' : 'second continuation' } } };
      return;
    }
    yield { type: 'text_delta', text: 'done' };
  });
  const { activation } = await f.select();
  for (let round = 0; round < 2; round++) {
    await f.send('resume work', `resume-${round}`);
    await eventually(async () => (await f.view()).turns!.filter(turn => turn.participantId === f.worker.id && turn.status === 'ended').length === round + 1, 'member continuation turn');
  }
  const view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  assert.deepEqual(view.activation!.messages.filter(message => message.senderId === f.worker.id).map(message => message.text), ['first continuation', 'second continuation']);
  const transcript = await readTranscript(join(f.home, 'team-runtime', 'contexts', activation!.id, f.worker.id, 'context.jsonl'));
  const accepted = transcript.entries.filter(entry => entry.type === 'accepted_input');
  assert.equal(accepted.length, 2); assert.notEqual(accepted[0]!.turnId, accepted[1]!.turnId);
  assert.ok(view.activation!.turns!.filter(turn => turn.participantId === f.worker.id).every(turn => turn.trigger === 'messages'));
  assert.ok(transcript.entries.filter(entry => entry.type === 'durable_message' && entry.message.metadata?.teamConsumed).every(entry => entry.type === 'durable_message' && entry.message.metadata?.teamTurnOrigin === 'messages'));
});

test('member human permission is delivered directly to the Team interaction channel and resumes work', async t => {
  const f = await fixture(t, ['bash'], 'default'); let delegated = false, requested = false;
  f.setResponse(async function* (request) {
    if (request.model === 'worker') {
      if (!requested) { requested = true; yield { type: 'tool_call_start', id: 'permission-tool', name: 'bash' }; yield { type: 'tool_call_end', toolCall: { id: 'permission-tool', name: 'bash', input: { command: 'printf team-permission-test > permission-output.txt' } } }; return; }
      yield { type: 'text_delta', text: 'permission-result' }; return;
    }
    if (!delegated) { delegated = true; yield { type: 'tool_call_start', id: 'send-permission', name: 'team_send_message' }; yield { type: 'tool_call_end', toolCall: { id: 'send-permission', name: 'team_send_message', input: { recipientId: f.worker.id, text: 'check permission' } } }; return; }
    yield { type: 'text_delta', text: 'awaiting permission' };
  });
  const { activation } = await f.select(); await f.submit({ runId: 'permission-human', teamActivationId: activation!.id });
  let interaction: Extract<GatewayEvent, { type: 'team_interaction' }>['interaction'] | undefined;
  for (let i = 0; i < 100 && !interaction; i++) {
    interaction = f.broadcasts.find(item => item.name === 'team_runtime_event' && item.payload.sessionKey === f.sessionKey && item.payload.event.type === 'team_interaction')?.payload.event.interaction;
    if (!interaction) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(interaction, 'Teammate permission is published on the Team interaction channel');
  const rootSnapshot = await f.gateway.getActiveTurnSnapshot!({ sessionKey: f.sessionKey });
  assert.ok(!rootSnapshot.events.some(event => event.type === 'permission_request'), 'Leader chat does not receive Teammate permission prompts');
  let view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  for (let i = 0; i < 30 && view.activation!.turns!.find(turn => turn.participantId === f.worker.id)!.status === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  }
  assert.equal(view.activation!.turns!.find(turn => turn.participantId === f.worker.id)!.status, 'waiting_approval');
  assert.equal((await f.gateway.permissionDecide({ sessionKey: 'web:other', requestId: interaction.requestId, decision: 'deny' })).delivered, false);
  assert.equal((await f.gateway.permissionDecide({ sessionKey: f.sessionKey, requestId: interaction.requestId, decision: 'deny' })).delivered, false, 'ordinary permission endpoint cannot decide for a Teammate');
  const response = await f.gateway.teamInteractionRespond!({
    sessionKey: f.sessionKey,
    activationId: interaction.activationId,
    stopVersion: interaction.stopVersion,
    participantId: interaction.participantId,
    interactionId: interaction.id,
    requestId: interaction.requestId,
    kind: interaction.kind,
    decision: 'deny',
  });
  assert.equal(response.delivered, true);
  for (let i = 0; i < 100; i++) {
    view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
    if (view.activation!.turns!.find(turn => turn.participantId === f.worker.id)!.status === 'ended') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(view.activation!.turns!.find(turn => turn.participantId === f.worker.id)!.status, 'ended');
  assert.equal((await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView).activation!.interactions.find(item => item.id === interaction!.id)?.status, 'denied');
  assert.ok(!((await f.gateway.getActiveTurnSnapshot!({ sessionKey: f.sessionKey })).events).some(event => event.type === 'permission_request'));
});

function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function eventually(check: () => Promise<boolean>, label: string) {
  const until = Date.now() + 6000;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`Timed out: ${label}`);
}

test('same-workspace member message reaches busy Leader before next LLM without ending its run', async t => {
  const f = await fixture(t, []);
  const leaderWaiting = gate(), releaseLeader = gate(); let leaderCalls = 0, workerCalls = 0;
  f.setResponse(async function* (request) {
    if (request.model === 'worker') {
      await leaderWaiting.promise;
      if (++workerCalls === 1) {
        yield { type: 'tool_call_start', id: 'question', name: 'team_send_message' };
        yield { type: 'tool_call_end', toolCall: { id: 'question', name: 'team_send_message', input: { recipientId: f.leader.id, text: 'COORDINATION_MARKER' } } }; return;
      }
      yield { type: 'text_delta', text: 'FINAL_WORKER_RESULT_PRIVATE' }; return;
    }
    if (++leaderCalls === 1) {
      yield { type: 'tool_call_start', id: 'send', name: 'team_send_message' };
      yield { type: 'tool_call_end', toolCall: { id: 'send', name: 'team_send_message', input: { recipientId: f.worker.id, text: 'inspect' } } }; return;
    }
    if (leaderCalls === 2) { leaderWaiting.resolve(); await releaseLeader.promise; yield { type: 'tool_call_start', id: 'overview', name: 'team_roster' }; yield { type: 'tool_call_end', toolCall: { id: 'overview', name: 'team_roster', input: {} } }; return; }
    yield { type: 'text_delta', text: 'leader continues' };
  });
  const { activation } = await f.select(); const events: GatewayEvent[] = [];
  const running = (async () => { for await (const event of f.gateway.submitTurn({ sessionKey: f.sessionKey, projectKey: f.workspace, channelKey: 'web', message: 'inspect', runId: 'busy-leader', teamActivationId: activation!.id, teamStopVersion: activation!.stopVersion })) events.push(event); })();
  t.after(() => releaseLeader.resolve());
  await leaderWaiting.promise;
  await eventually(async () => {
    const view = await f.gateway.teamCommand!({ action:'runtime_get', sessionKey:f.sessionKey }) as TeamRuntimeView;
    return !!view.activation?.messages.some(message => message.text === 'COORDINATION_MARKER' && message.status === 'queued');
  }, 'message queued while Leader LLM is in flight');
  assert.ok(f.requests.some(request => request.model === 'worker'), 'member starts while Leader still holds its run');
  releaseLeader.resolve(); await running;
  await eventually(async () => { const view = await f.gateway.teamCommand!({action:'runtime_get',sessionKey:f.sessionKey}) as TeamRuntimeView; return view.activation!.messages.every(message => message.status === 'consumed'); }, 'messages actually dispatched');
  const mainStorage = createAgentProjectSessionStorage({projectRoot:f.workspace,pilotHome:f.home,sessionId:f.sessionKey});
  const transcript = await readTranscript(mainStorage.transcriptPath);
  const applied = transcript.entries.filter(entry => entry.type === 'durable_message' && entry.message.metadata?.purpose === 'team_runtime');
  assert.ok(applied.some(entry => entry.turnId === 'busy-leader' && JSON.stringify(entry).includes('COORDINATION_MARKER')));
  assert.ok(events.some(event => event.type === 'steer_applied' && event.purpose === 'team_runtime'));
  const ledger = await f.view();
  const delivered = ledger.messages.find(message => message.text === 'COORDINATION_MARKER')!;
  assert.equal(delivered.turnId, 'busy-leader'); assert.equal(delivered.status, 'consumed');
  assert.ok(ledger.dispatches!.some(dispatch => dispatch.turnId === 'busy-leader' && dispatch.messageIds.includes(delivered.id)));
  assert.ok(f.requests.filter(request => request.model === 'leader').slice(2).some(request => JSON.stringify(request.messages).includes('COORDINATION_MARKER')));
  assert.ok(!f.requests.filter(request => request.model === 'leader').some(request => JSON.stringify(request.messages).includes('FINAL_WORKER_RESULT_PRIVATE')), 'auto notification omits final member reply');
  await assert.rejects(stat(join(f.home, 'checkpoints')), {code:'ENOENT'});
});

test('running member receives coordination in its current execution turn', async t => {
  const f = await fixture(t, []); const workerWaiting = gate(), releaseWorker = gate(), allowMessage = gate(); let leaderCalls = 0, workerCalls = 0;
  f.setResponse(async function* (request) {
    if (request.model === 'worker') {
      if (++workerCalls === 1) { workerWaiting.resolve(); await releaseWorker.promise; yield { type: 'tool_call_start', id: 'worker-overview', name: 'team_roster' }; yield { type: 'tool_call_end', toolCall: { id: 'worker-overview', name: 'team_roster', input: {} } }; return; }
      yield {type:'text_delta',text:'member final'}; return;
    }
    if (++leaderCalls === 1) {
      yield {type:'tool_call_start',id:'send',name:'team_send_message'};
      yield {type:'tool_call_end',toolCall:{id:'send',name:'team_send_message',input:{recipientId:f.worker.id,text:'work'}}}; return;
    }
    if (leaderCalls === 2) {
      await workerWaiting.promise; await allowMessage.promise;
      yield {type:'tool_call_start',id:'note',name:'team_send_message'};
      yield {type:'tool_call_end',toolCall:{id:'note',name:'team_send_message',input:{recipientId:f.worker.id,text:'MEMBER_COORDINATION'}}}; return;
    }
    yield {type:'text_delta',text:'leader'};
  });
  const {activation} = await f.select(); const running = f.submit({runId:'member-note'}); t.after(() => releaseWorker.resolve());
  await workerWaiting.promise;
  allowMessage.resolve();
  await eventually(async () => {const view=await f.gateway.teamCommand!({action:'runtime_get',sessionKey:f.sessionKey}) as TeamRuntimeView;return !!view.activation!.messages.find(m=>m.text==='MEMBER_COORDINATION' && m.status==='queued');}, 'member message queued');
  releaseWorker.resolve(); await running;
  await eventually(async () => {const view=await f.gateway.teamCommand!({action:'runtime_get',sessionKey:f.sessionKey}) as TeamRuntimeView;return !!view.activation!.turns!.find(turn=>turn.participantId===f.worker.id && turn.status==='ended');}, 'member execution ended');
  const entries=(await readTranscript(join(f.home,'team-runtime','contexts',activation!.id,f.worker.id,'context.jsonl'))).entries;
  assert.equal(entries.filter(entry=>entry.type==='accepted_input').length,1,'no extra coordination turn');
  assert.ok(entries.some(entry=>entry.type==='durable_message' && JSON.stringify(entry).includes('MEMBER_COORDINATION')));
  assert.equal(workerCalls,2);
  const ledger = await f.view(), memberTurn = ledger.turns!.find(turn => turn.participantId === f.worker.id)!;
  const note = ledger.messages.find(message => message.text === 'MEMBER_COORDINATION')!;
  assert.equal(note.status, 'consumed'); assert.equal(note.turnId, memberTurn.turnId);
  assert.equal(ledger.turns!.filter(turn => turn.participantId === f.worker.id).length, 1);
});

test('Abort fences old requests, clears actual execution, and fresh send uses new role tools', async t => {
  const f=await fixture(t,[]);const waiting=gate(),release=gate();let calls=0;
  f.setResponse(async function*(){ if(++calls===1){waiting.resolve();await release.promise;} yield {type:'text_delta',text:'done'}; });
  const {activation}=await f.select();const run=f.submit({runId:'to-stop'});await waiting.promise;
  let stopped=false; const stopping=f.gateway.abortTurn({sessionKey:f.sessionKey,runId:'to-stop',teamActivationId:activation!.id,teamStopVersion:activation!.stopVersion}).then(()=>{stopped=true;});
  await eventually(async()=> (await f.gateway.teamCommand!({action:'runtime_get',sessionKey:f.sessionKey}) as TeamRuntimeView).activation?.status==='stopping','stopping persisted');
  assert.equal(stopped,false);
  release.resolve();await run;await stopping;
  const view=await f.gateway.teamCommand!({action:'runtime_get',sessionKey:f.sessionKey}) as TeamRuntimeView;
  assert.equal(view.activation!.status,'stopped'); assert.equal(view.activation!.stopVersion,activation!.stopVersion+1);
  const old=await f.submit({runId:'old-epoch',teamActivationId:activation!.id,teamStopVersion:activation!.stopVersion});
  assert.ok(old.some(event=>event.type==='error' && event.code==='TEAM_GENERATION_EXPIRED'));
  const fresh=await f.submit({runId:'fresh'});assert.deepEqual(fresh.filter(event=>event.type==='error'),[]);
  assert.match(f.requests.at(-1)!.systemPrompt!,/previous Team run was stopped or interrupted/);
  await assert.rejects(f.gateway.abortTurn({sessionKey:f.sessionKey,teamActivationId:activation!.id,teamStopVersion:activation!.stopVersion}), /expired/);
});

test('accepted Team input replay while original execution is running returns a receipt without another model call', async t => {
  const f = await fixture(t, []); const started = gate(), release = gate();
  f.setResponse(async function* () { started.resolve(); await release.promise; yield { type: 'text_delta', text: 'done' }; });
  const { activation } = await f.select();
  const input = { runId: 'reconnect', teamActivationId: activation!.id, teamStopVersion: activation!.stopVersion };
  const running = f.submit(input); t.after(() => release.resolve()); await started.promise;
  const replay = await f.submit(input);
  assert.ok(replay.some(event => event.type === 'input_accepted'));
  assert.ok(replay.some(event => event.type === 'agent_status' && event.event === 'team_input_already_accepted' && event.detail?.running === true));
  assert.ok(!replay.some(event => event.type === 'error')); assert.equal(f.requests.length, 1);
  const changed = await f.submit({ ...input, message: 'different' });
  assert.ok(changed.some(event => event.type === 'error' && event.code === 'TEAM_INPUT_CONFLICT'));
  release.resolve(); await running;
});

function interactionOwner(item: import('../../src/team/runtimeTypes.js').TeamHumanInteraction) {
  return { sessionKey: item.sessionKey, activationId: item.activationId, stopVersion: item.stopVersion, participantId: item.participantId, interactionId: item.id, requestId: item.requestId, kind: item.kind };
}
async function startHumanInteraction(f: Awaited<ReturnType<typeof fixture>>, toolName: string, input: Record<string, unknown>) {
  let requested = false, enteredPlan = false;
  f.setResponse(async function* (request) {
    if (request.model === 'worker' && toolName === 'exit_plan_mode') {
      assert.ok(request.tools?.some(tool => tool.name === 'enter_plan_mode'));
      assert.ok(request.tools?.some(tool => tool.name === 'exit_plan_mode'));
      if (!enteredPlan) {
        enteredPlan = true;
        yield { type: 'tool_call_start', id: 'enter-plan', name: 'enter_plan_mode' };
        yield { type: 'tool_call_end', toolCall: { id: 'enter-plan', name: 'enter_plan_mode', input: {} } }; return;
      }
    }
    if (request.model === 'worker' && !requested) {
      requested = true;
      yield { type: 'tool_call_start', id: 'human-interaction-tool', name: toolName };
      yield { type: 'tool_call_end', toolCall: { id: 'human-interaction-tool', name: toolName, input } }; return;
    }
    yield { type: 'text_delta', text: 'interaction finished' };
  });
  const { activation } = await f.select();
  const runtime = (f.registry as any).teamRuntime as import('../../src/team/TeamRuntime.js').TeamRuntime;
  await f.send('request direct human review', 'human-review');
  await eventually(async () => f.broadcasts.some(item => item.name === 'team_runtime_event' && item.payload.event.type === 'team_interaction'), 'durable human interaction');
  const interaction = f.broadcasts.find(item => item.name === 'team_runtime_event' && item.payload.event.type === 'team_interaction')!.payload.event.interaction as import('../../src/team/runtimeTypes.js').TeamHumanInteraction;
  assert.equal(f.requests.filter(request => request.model === 'leader').length, 0, 'pending human request does not wake Leader');
  assert.ok(!(await f.gateway.getActiveTurnSnapshot!({ sessionKey: f.sessionKey })).events.some(event => event.type === 'permission_request' || event.type === 'elicitation_request'));
  return { interaction, runtime, activation: activation! };
}
const reviewQuestion = { questions: [{ question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Unit', description: 'Run unit checks' }, { label: 'UI', description: 'Run UI checks' }] }] };

test('real Teammate question validates owners, preserves multiselect annotations and consumes concurrent responses once', async t => {
  const f = await fixture(t, ['ask_user_question']);
  const { interaction } = await startHumanInteraction(f, 'ask_user_question', reviewQuestion);
  const owner = interactionOwner(interaction);
  for (const change of [{ sessionKey: 'web:wrong' }, { activationId: 'wrong' }, { participantId: f.leader.id }, { stopVersion: owner.stopVersion + 1 }, { requestId: 'wrong' }, { participantId: undefined }]) {
    await assert.rejects(f.gateway.teamInteractionRespond!({ ...owner, ...change, answer: { 'Which checks?': ['Unit'] } } as any));
  }
  for (const invalid of [{ decision: 'allow', answer: { 'Which checks?': ['Unit'] } }, { decision: 'cancel', answer: { 'Which checks?': ['Unit'] } }, { answer: { 'Which checks?': true } }]) await assert.rejects(f.gateway.teamInteractionRespond!({ ...owner, ...invalid } as any));
  assert.equal((await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView).activation!.interactions[0]!.status, 'pending');
  assert.equal((await f.gateway.respondElicitation({ sessionKey: f.sessionKey, requestId: interaction.requestId, answer: { type: 'cancelled' } })).delivered, false, 'Leader channel cannot answer a Teammate');
  const answer = { type: 'answered' as const, answers: { 'Which checks?': ['Unit', 'UI'] }, annotations: { 'Which checks?': { notes: 'Keep both checks' } } };
  const results = await Promise.all([
    f.gateway.teamInteractionRespond!({ ...owner, answer }),
    f.gateway.teamCommand!({ action: 'runtime_interaction_respond', ...owner, answer }),
    f.gateway.teamInteractionRespond!({ ...owner, answer }),
  ]) as Array<{ delivered: boolean; interaction: import('../../src/team/runtimeTypes.js').TeamHumanInteraction }>;
  assert.equal(results.filter(result => result.delivered).length, 1);
  assert.ok(results.every(result => result.interaction.status === 'answered'));
  assert.deepEqual(results[0]!.interaction.resolution, answer);
  await eventually(async () => !!(await f.view()).turns?.some(turn => turn.participantId === f.worker.id && turn.status === 'ended'), 'question tool completed');
  const transcript = await readTranscript(join(f.home, 'team-runtime', 'contexts', interaction.activationId, f.worker.id, 'context.jsonl'));
  assert.match(JSON.stringify(transcript.entries), /Keep both checks/);
  assert.match(JSON.stringify(transcript.entries), /Unit/);
  assert.match(JSON.stringify(transcript.entries), /UI/);
  assert.equal((await f.gateway.teamInteractionRespond!({ ...owner, answer })).interaction?.status, 'answered');
});

test('real Teammate question cancellation is recorded and unblocks the original tool', async t => {
  const f = await fixture(t, ['ask_user_question']);
  const { interaction } = await startHumanInteraction(f, 'ask_user_question', reviewQuestion);
  const result = await f.gateway.teamInteractionRespond!({ ...interactionOwner(interaction), answer: { type: 'cancelled', reason: 'Skip this question' } });
  assert.equal(result.interaction?.status, 'cancelled');
  await eventually(async () => !!(await f.view()).turns?.some(turn => turn.participantId === f.worker.id && turn.status === 'ended'), 'cancelled question completed');
  const transcript = await readTranscript(join(f.home, 'team-runtime', 'contexts', interaction.activationId, f.worker.id, 'context.jsonl'));
  assert.match(JSON.stringify(transcript.entries), /cancelled|declined/i);
});

for (const decision of ['approve', 'decline'] as const) test(`real Teammate Plan ${decision} resolves the submitted plan with matching execution semantics`, async t => {
  const f = await fixture(t, ['enter_plan_mode', 'exit_plan_mode'], 'default');
  const planPath = join(f.workspace, '.pilotdeck', 'plans', 'review.md');
  await mkdir(join(f.workspace, '.pilotdeck', 'plans'), { recursive: true });
  await writeFile(planPath, '# Review plan\n\nRun targeted checks after approval.');
  const { interaction } = await startHumanInteraction(f, 'exit_plan_mode', { plan_file_path: planPath });
  assert.equal(interaction.kind, 'plan_approval');
  assert.match(JSON.stringify(interaction.request), /Review plan/);
  await assert.rejects(f.gateway.teamInteractionRespond!({ ...interactionOwner(interaction), decision: 'decline', answer: { action: 'execute_plan' } }), /disagree/);
  const action = decision === 'approve' ? 'execute_plan' : 'continue_planning';
  const answer = { type: 'answered' as const, answers: { 'What should happen next?': action }, annotations: { 'What should happen next?': { notes: 'Plan review feedback' } } };
  const result = await f.gateway.teamInteractionRespond!({ ...interactionOwner(interaction), decision, answer });
  assert.equal(result.delivered, true);
  assert.equal(result.interaction?.status, decision === 'approve' ? 'approved' : 'declined');
  await eventually(async () => !!(await f.view()).turns?.some(turn => turn.participantId === f.worker.id && turn.status === 'ended'), 'plan tool completed');
  const transcript = JSON.stringify((await readTranscript(join(f.home, 'team-runtime', 'contexts', interaction.activationId, f.worker.id, 'context.jsonl'))).entries);
  assert.match(transcript, /Plan mode activated/);
  assert.match(transcript, new RegExp(action));
  assert.match(transcript, decision === 'approve' ? /User has approved your plan/ : /Plan review feedback/);
});

test('Gateway restart expires a real pending Teammate question and cannot replay its answer', async t => {
  const f = await fixture(t, ['ask_user_question']);
  const { interaction } = await startHumanInteraction(f, 'ask_user_question', reviewQuestion);
  await f.restart();
  const view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  assert.equal(view.activation!.interactions.find(item => item.id === interaction.id)!.status, 'expired');
  await assert.rejects(f.gateway.teamInteractionRespond!({ ...interactionOwner(interaction), answer: { 'Which checks?': ['Unit'] } }), /expired/);
});

test('ordinary Leader questions remain on the normal conversation elicitation channel', async t => {
  const f = await fixture(t, ['ask_user_question']); let requested = false;
  f.setResponse(async function* () {
    if (!requested) { requested = true; yield { type: 'tool_call_start', id: 'leader-question', name: 'ask_user_question' }; yield { type: 'tool_call_end', toolCall: { id: 'leader-question', name: 'ask_user_question', input: reviewQuestion } }; return; }
    yield { type: 'text_delta', text: 'Leader received user answer' };
  });
  await f.select();
  const running = f.submit();
  let request: Extract<GatewayEvent, { type: 'elicitation_request' }> | undefined;
  await eventually(async () => { request = (await f.gateway.getActiveTurnSnapshot!({ sessionKey: f.sessionKey })).events.find(event => event.type === 'elicitation_request') as typeof request; return !!request; }, 'Leader question');
  assert.equal((await f.gateway.respondElicitation({ sessionKey: f.sessionKey, requestId: request!.requestId, answer: { type: 'answered', answers: { 'Which checks?': ['Unit'] } } })).delivered, true);
  await running;
  assert.equal((await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView).activation!.interactions.length, 0);
  assert.ok(!f.broadcasts.some(item => item.payload.event?.type === 'team_interaction'));
});

for (const decision of ['allow', 'deny'] as const) test(`real Teammate permission ${decision} controls the underlying tool side effect`, async t => {
  const f = await fixture(t, ['bash'], 'default');
  const { interaction } = await startHumanInteraction(f, 'bash', { command: 'printf approved > interaction-side-effect.txt' });
  const response = await f.gateway.teamInteractionRespond!({ ...interactionOwner(interaction), decision });
  assert.equal(response.interaction?.status, decision === 'allow' ? 'allowed' : 'denied');
  await eventually(async () => !!(await f.view()).turns?.some(turn => turn.participantId === f.worker.id && turn.status === 'ended'), 'permission tool completed');
  const path = join(f.workspace, 'interaction-side-effect.txt');
  if (decision === 'allow') assert.ok(await stat(path)); else await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('ending a member elicitation invalidates its pending ledger while preserving history', async t => {
  const f = await fixture(t, ['ask_user_question']);
  const { interaction } = await startHumanInteraction(f, 'ask_user_question', reviewQuestion);
  const internalKey = `team-internal:${interaction.activationId}:${interaction.participantId}`;
  (f.gateway as InProcessGateway).clearTeamPrompts(internalKey);
  await eventually(async () => (await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView).activation!.interactions[0]!.status === 'cancelled', 'ended question invalidated');
  assert.equal((await f.gateway.teamInteractionRespond!({ ...interactionOwner(interaction), answer: { 'Which checks?': ['Unit'] } })).delivered, false);
});

test('real member readonly transcript merges in-flight text, streams dedicated frames and recovers final history after stop', async t => {
  const f = await fixture(t, []), release = gate();
  t.after(() => release.resolve());
  f.setResponse(async function* (request) {
    if (request.model === 'worker') {
      yield { type: 'text_delta', text: 'TEAM_PARTIAL' };
      await release.promise;
      yield { type: 'text_delta', text: ' TEAM_FINAL' };
      return;
    }
    yield { type: 'text_delta', text: 'Leader summary' };
  });
  const { activation } = await f.select();
  await f.send('stream a private member reply', 'stream-reply');
  const query = { sessionKey: f.sessionKey, activationId: activation!.id, stopVersion: activation!.stopVersion, participantId: f.worker.id };
  const memberEvents = () => f.broadcasts.filter(item => item.name === 'team_runtime_event' && item.payload.event.type === 'team_participant_message').map(item => item.payload.event as Extract<GatewayEvent, { type: 'team_participant_message' }>);
  await eventually(async () => memberEvents().some(event => JSON.stringify(event.messages).includes('TEAM_PARTIAL')), 'dedicated member partial output');
  const partialEvent = memberEvents().find(event => JSON.stringify(event.messages).includes('TEAM_PARTIAL'))!;
  assert.equal(partialEvent.participantId, f.worker.id); assert.equal(partialEvent.activationId, activation!.id);
  assert.equal(partialEvent.streaming, true); assert.ok(partialEvent.streamEpoch); assert.ok(partialEvent.revision > 0);
  const beforeReadCalls = f.requests.length;
  const live = await f.gateway.teamParticipantMessages!(query);
  assert.equal(live.streaming, true); assert.equal(live.streamEpoch, partialEvent.streamEpoch); assert.ok(live.revision! >= partialEvent.revision);
  assert.equal(live.messages.filter(message => JSON.stringify(message.content).includes('TEAM_PARTIAL')).length, 1);
  assert.ok(live.messages.some(message => message.isStreaming && JSON.stringify(message.content).includes('TEAM_PARTIAL')));
  assert.equal(f.requests.length, beforeReadCalls, 'readonly access never starts a model');
  assert.ok(!(await f.gateway.getActiveTurnSnapshot!({ sessionKey: f.sessionKey })).events.some(event => event.type === 'assistant_text_delta' && event.text.includes('TEAM_PARTIAL')));
  assert.ok(!f.broadcasts.some(item => item.payload.event?.type === 'assistant_text_delta' && item.payload.event.text?.includes('TEAM_PARTIAL')), 'member text never enters Leader stream');
  for (const change of [{ sessionKey: 'web:other' }, { activationId: 'other-activation' }, { participantId: f.leader.id }, { participantId: 'missing-member' }, { stopVersion: activation!.stopVersion + 1 }, { participantId: undefined }]) await assert.rejects(f.gateway.teamParticipantMessages!({ ...query, ...change } as any));
  release.resolve();
  await eventually(async () => memberEvents().some(event => event.reload && event.streaming === false), 'member terminal reload');
  const terminal = memberEvents().find(event => event.reload && event.streaming === false)!;
  assert.equal(terminal.streamEpoch, partialEvent.streamEpoch); assert.ok(terminal.revision > partialEvent.revision);
  const finished = await f.gateway.teamParticipantMessages!(query);
  assert.equal(finished.streaming, false);
  const finalMessages = finished.messages.filter(message => JSON.stringify(message.content).includes('TEAM_PARTIAL'));
  assert.equal(finalMessages.length, 1, 'live and durable versions share one identity');
  assert.match(JSON.stringify(finalMessages[0]!.content), /TEAM_PARTIAL TEAM_FINAL/);
  assert.equal(finalMessages[0]!.isStreaming, false);
  assert.equal(finalMessages[0]!.id, live.messages.find(message => JSON.stringify(message.content).includes('TEAM_PARTIAL'))!.id);
  const stopped = await f.gateway.teamCommand!({ action: 'runtime_stop', sessionKey: f.sessionKey, activationId: activation!.id, stopVersion: activation!.stopVersion }) as TeamRuntimeView;
  const stoppedHistory = await f.gateway.teamParticipantMessages!({ ...query, stopVersion: stopped.activation!.stopVersion });
  assert.equal(stoppedHistory.streaming, false);
  assert.equal(stoppedHistory.messages.filter(message => JSON.stringify(message.content).includes('TEAM_PARTIAL TEAM_FINAL')).length, 1);
});

for (const fixedLeader of [false, true]) test(`Team checks required skills and MCP in each resolved workspace plus global configuration (fixed Leader=${fixedLeader})`, async t => {
  const f = await fixture(t), teammateWorkspace = fixedLeader ? f.workspace : join(f.home, 'unregistered-teammate-workspace');
  await mkdir(teammateWorkspace, { recursive: true });
  const skill = async (root: string, name: string) => {
    const directory = join(root, name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---
name: ${name}
description: Test capability ${name}
---
Use this skill to inspect evidence.
`);
  };
  await skill(join(f.home, 'skills'), 'shared-skill');
  await skill(join(f.workspace, '.pilotdeck', 'skills'), 'leader-skill');
  await skill(join(teammateWorkspace, '.pilotdeck', 'skills'), 'worker-skill');
  const spec = { command: process.execPath, args: [resolve('tests/mcp/fixtures/roundtrip-server.mjs')] };
  await writeFile(join(f.home, 'mcp.json'), JSON.stringify({ mcpServers: { 'shared-mcp': spec } }));
  await writeFile(join(f.workspace, '.pilotdeck', 'mcp.json'), JSON.stringify({ mcpServers: { 'leader-mcp': spec, ...(fixedLeader ? { 'worker-mcp': spec } : {}) } }));
  if (!fixedLeader) await writeFile(join(teammateWorkspace, '.pilotdeck', 'mcp.json'), JSON.stringify({ mcpServers: { 'worker-mcp': spec } }));
  const save = async (profile: AgentProfile, workspace: ProfileConfig['workspace'], skills: string[], mcpServers: string[], token: string) => {
    await f.gateway.teamCommand!({ action: 'profile_save', id: profile.id, role: profile.role, config: { ...profile.config, workspace, capabilities: { ...profile.config.capabilities, skills, mcpServers } }, requestToken: token });
  };
  await save(f.leader, fixedLeader ? { mode: 'fixed', projectKey: f.workspace } : { mode: 'team' }, ['shared-skill', 'leader-skill'], ['shared-mcp', 'leader-mcp'], 'leader-capabilities');
  await save(f.worker, fixedLeader ? { mode: 'team' } : { mode: 'fixed', projectKey: teammateWorkspace }, ['shared-skill', 'worker-skill'], ['shared-mcp', 'worker-mcp'], 'worker-capabilities');
  const probe = () => f.gateway.teamCommand!({ action: 'runtime_probe', team: { id: f.team.id }, sessionKey: f.sessionKey, storageProjectKey: f.workspace }) as Promise<TeamRuntimeProbe>;
  const available = await probe();
  assert.deepEqual(available.issues, []); assert.equal(available.compatible, true);
  assert.equal(available.participants.find(value => value.id === f.worker.id)!.projectKey, teammateWorkspace);
  assert.equal(f.requests.length, 0);
  if (!fixedLeader) {
    // Capabilities installed only in the Leader workspace cannot satisfy a fixed Teammate's requirements.
    await save(f.worker, { mode: 'fixed', projectKey: teammateWorkspace }, ['leader-skill'], ['leader-mcp'], 'worker-wrong-workspace');
    const missing = await probe();
    assert.equal(missing.compatible, false);
    assert.deepEqual(missing.issues.map(value => [value.severity, value.code, value.participantId]).sort(), [
      ['error', 'TEAM_CAPABILITY_MISSING', f.worker.id], ['error', 'TEAM_CAPABILITY_MISSING', f.worker.id],
    ]);
    await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_select', team: { id: f.team.id }, sessionKey: f.sessionKey, storageProjectKey: f.workspace, requestToken: 'missing-workspace-capability', probeFingerprint: missing.fingerprint }), /leader-skill|leader-mcp/);
  } else {
    await f.select();
    await rm(join(f.home, 'skills', 'shared-skill'), { recursive: true });
    await writeFile(join(f.home, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const missing = await probe();
    assert.equal(missing.compatible, false); assert.equal(missing.issues.length, 4);
    assert.ok(missing.issues.every(value => value.severity === 'error' && value.code === 'TEAM_CAPABILITY_MISSING'));
    await assert.rejects(f.gateway.teamCommand!({ action: 'runtime_select', team: { id: f.team.id }, sessionKey: 'web:missing-global', storageProjectKey: f.workspace, requestToken: 'missing-global' }), /shared-skill|shared-mcp/);
    const events = await f.submit({ runId: 'lost-capabilities' });
    assert.ok(events.some(event => event.type === 'error' && event.code === 'TEAM_INCOMPATIBLE'));
  }
  assert.equal(f.requests.length, 0);
});

test('Team rejects a configured MCP server that cannot connect without warning acceptance', async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'mcp.json'), JSON.stringify({ mcpServers: { broken: { command: join(f.home, 'nonexistent-mcp-server') } } }));
  await f.gateway.teamCommand!({ action: 'profile_save', id: f.worker.id, role: 'teammate', config: { ...f.worker.config, capabilities: { ...f.worker.config.capabilities, mcpServers: ['broken'] } }, requestToken: 'broken-mcp' });
  const probe = await f.gateway.teamCommand!({ action: 'runtime_probe', team: { id: f.team.id }, sessionKey: f.sessionKey, storageProjectKey: f.workspace }) as TeamRuntimeProbe;
  assert.equal(probe.compatible, false);
  assert.ok(probe.issues.some(issue => issue.severity === 'error' && issue.code === 'TEAM_MCP_UNAVAILABLE' && issue.participantId === f.worker.id));
  await assert.rejects(f.select(), /broken/); assert.equal(f.requests.length, 0);
});
