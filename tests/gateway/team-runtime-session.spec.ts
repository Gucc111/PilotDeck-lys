import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createProjectId } from '../../src/pilot/index.js';
import { createModelRuntime, type CanonicalModelRequest, type CanonicalModelEvent } from '../../src/model/index.js';
import { createAgentProjectSessionStorage, readTranscript } from '../../src/session/index.js';
import type { AgentProfile, ProfileConfig, TeamDefinition } from '../../src/team/types.js';
import type { TeamRuntimeView, TeamParticipantExecution } from '../../src/team/runtimeTypes.js';
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
    __testModelFactory: (snapshot: any) => ({ ...createModelRuntime(snapshot.config.model), async *stream(request: CanonicalModelRequest) {
      requests.push(request); yield { type: 'request_started' as const, provider: request.provider, model: request.model }; yield { type: 'message_start' as const, role: 'assistant' as const };
      yield* respond(request); yield { type: 'message_end' as const, finishReason: 'stop' as const };
    }, async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '' }], finishReason: 'stop' as const }; } }),
  };
  let local = createLocalGateway(options);
  const bind = () => local.bindServer({ broadcastNotification: (name, payload) => broadcasts.push({ name, payload }) }); bind();
  t.after(async () => { await local.dispose(); await rm(base, { recursive: true, force: true }); });
  const profile = async (role: 'leader' | 'teammate', model: string) => local.gateway.teamCommand!({ action: 'profile_save', role, requestToken: role, config: {
    displayName: role, description: '', systemPrompt: `ROLE_MARKER_${role}`, model: { mode: 'model', provider: 'test', model }, workspace: { mode: 'team' },
    capabilities: { tools, skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode,
  } }) as Promise<AgentProfile>;
  const leader = await profile('leader', 'leader'), worker = await profile('teammate', 'worker');
  const team = await local.gateway.teamCommand!({ action: 'team_save', requestToken: 'team', config: { displayName: 'Release review', description: '', instructions: 'TEAM_MARKER', defaultProjectKey: workspace, leader: { id: leader.id, revision: leader.revision }, teammates: [{ id: worker.id, revision: worker.revision }] } }) as TeamDefinition;
  const sessionKey = 'web:team-test';
  return { home, workspace, sessionKey, requests, broadcasts, team, leader, worker,
    get gateway() { return local.gateway; }, get registry() { return local.registry; }, setResponse(value: typeof respond) { respond = value; },
    executeParticipant(input: TeamParticipantExecution) { return local.registry.executeTeamParticipant(input); },
    async restart() { await local.dispose(); local = createLocalGateway(options); bind(); },
    async select(storageProjectKey = workspace) { return await local.gateway.teamCommand!({ action: 'runtime_select', sessionKey, storageProjectKey, team: { id: team.id, revision: team.revision }, requestToken: 'select' }) as TeamRuntimeView; },
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
  assert.ok(request.tools?.some(tool => tool.name === 'team_delegate')); assert.ok(request.tools?.some(tool => tool.name === 'get_current_time'));
  assert.ok(!request.tools?.some(tool => ['bash', 'agent', 'task_create', 'read_skill'].includes(tool.name)));
  await f.restart(); await f.submit({ runId: 'two' });
  assert.equal(f.requests.at(-1)!.model, 'leader'); assert.match(f.requests.at(-1)!.systemPrompt!, /ROLE_MARKER_leader/);
  const stale = await f.submit({ teamActivationId: null }); assert.ok(stale.some(event => event.type === 'error' && event.code === 'TEAM_ACTIVATION_CHANGED'));
  const tamper = await f.submit({ workspaceCwd: f.home }); assert.ok(tamper.some(event => event.type === 'error' && event.code === 'TEAM_WORKSPACE_CONFLICT'));
  await assert.rejects(f.gateway.closeSession({ sessionKey: f.sessionKey, reason: 'session_deleted' }), /Team execution history/);
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
  const team = { id: f.team.id, revision: f.team.revision };
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
  const team = { id: f.team.id, revision: f.team.revision };
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
  const input = { runId: 'stable-input', teamSelection: { team: { id: f.team.id, revision: f.team.revision }, requestToken: 'first-send' } };
  const first = await f.submit(input); assert.deepEqual(first.filter(event => event.type === 'error'), []); assert.equal(f.requests.length, 1);
  await f.restart(); const retry = await f.submit(input);
  assert.ok(retry.some(event => event.type === 'input_accepted')); assert.equal(f.requests.length, 1);
  const conflict = await f.submit({ ...input, message: 'changed' }); assert.ok(conflict.some(event => event.type === 'error' && event.code === 'TEAM_INPUT_CONFLICT'));
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
    if (!delegated) { delegated = true; yield { type: 'tool_call_start', id: 'delegate-1', name: 'team_delegate' }; yield { type: 'tool_call_end', toolCall: { id: 'delegate-1', name: 'team_delegate', input: { participantId: f.worker.id, task: 'inspect release', requestToken: 'work-1' } } }; return; }
    yield { type: 'text_delta', text: 'leader-result' };
  });
  const { activation } = await f.select(); await f.submit({ runId: 'delegate', teamActivationId: activation!.id });
  for (let i = 0; i < 100 && !f.broadcasts.some(item => item.name === 'team_runtime_event' && item.payload.event.type === 'turn_completed'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  assert.equal(view.activation!.works[0]?.status, 'completed'); assert.equal(view.activation!.works[0]?.result, 'worker-result');
  const workerRequest = f.requests.find(request => request.model === 'worker')!; assert.ok(workerRequest); assert.match(workerRequest.systemPrompt!, /ROLE_MARKER_teammate/);
  assert.ok(!JSON.stringify(workerRequest.messages).includes('hello'));
  assert.ok(f.broadcasts.some(item => item.name === 'team_runtime_event' && item.payload.sessionKey === f.sessionKey && item.payload.event.type === 'assistant_text_delta'));
  const listed = await f.gateway.listSessions({ projectKey: f.workspace }); assert.equal(listed.sessions.length, 1);
  assert.ok(!JSON.stringify(listed.sessions[0]).includes('Team updates (internal background context)'));
  assert.equal(listed.sessions[0]!.firstPrompt, 'hello');
  const visible = await f.gateway.readSessionMessages!({ sessionKey: f.sessionKey, projectKey: f.workspace });
  assert.ok(!JSON.stringify(visible.messages).includes('Team updates (internal background context)'));
  const storage = createAgentProjectSessionStorage({ projectRoot: f.workspace, pilotHome: f.home, sessionId: f.sessionKey });
  const entries = (await readTranscript(storage.transcriptPath)).entries;
  assert.ok(entries.some(entry => entry.type === 'accepted_input' && entry.messages.some(message => message.metadata?.synthetic === true)));
  assert.ok((await readdir(join(f.home, 'team-runtime', 'contexts', activation!.id))).length > 0);
});

test('resuming the same member work gives each model turn a distinct tool retry namespace', async t => {
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
  const input: TeamParticipantExecution = {
    activation: activation!, participant: activation!.participants.find(item => item.role === 'teammate')!,
    work: { id: 'same-work', stopVersion: activation!.stopVersion, participantId: f.worker.id, task: 'resume work', status: 'running', createdAt: new Date().toISOString() },
    signal: new AbortController().signal, executionId: "test-execution", acceptMessages: async () => {}, updateStatus: async () => {},
  };
  await f.executeParticipant(input); await f.executeParticipant(input);
  const view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  assert.deepEqual(view.activation!.messages.filter(message => message.senderId === f.worker.id).map(message => message.text), ['first continuation', 'second continuation']);
  const transcript = await readTranscript(join(f.home, 'team-runtime', 'contexts', activation!.id, f.worker.id, 'context.jsonl'));
  const accepted = transcript.entries.filter(entry => entry.type === 'accepted_input');
  assert.equal(accepted.length, 2); assert.notEqual(accepted[0]!.turnId, accepted[1]!.turnId);
  assert.ok(accepted.every(entry => entry.type === 'accepted_input' && entry.metadata?.teamWorkId === 'same-work'));
});

test('member human permission survives Leader end and refresh, scopes decisions to parent, and resumes work', async t => {
  const f = await fixture(t, ['bash'], 'default'); let delegated = false, requested = false;
  f.setResponse(async function* (request) {
    if (request.model === 'worker') {
      if (!requested) { requested = true; yield { type: 'tool_call_start', id: 'permission-tool', name: 'bash' }; yield { type: 'tool_call_end', toolCall: { id: 'permission-tool', name: 'bash', input: { command: 'printf team-permission-test > permission-output.txt' } } }; return; }
      yield { type: 'text_delta', text: 'permission-result' }; return;
    }
    if (!delegated) { delegated = true; yield { type: 'tool_call_start', id: 'delegate-permission', name: 'team_delegate' }; yield { type: 'tool_call_end', toolCall: { id: 'delegate-permission', name: 'team_delegate', input: { participantId: f.worker.id, task: 'check permission', requestToken: 'permission-work' } } }; return; }
    yield { type: 'text_delta', text: 'awaiting permission' };
  });
  const { activation } = await f.select(); await f.submit({ runId: 'permission-human', teamActivationId: activation!.id });
  let prompt: Extract<GatewayEvent, { type: 'permission_request' }> | undefined;
  for (let i = 0; i < 100 && !prompt; i++) {
    const snapshot = await f.gateway.getActiveTurnSnapshot!({ sessionKey: f.sessionKey });
    prompt = snapshot.events.find((event): event is typeof prompt & {} => event.type === 'permission_request');
    if (!prompt) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(prompt, 'root active snapshot retains member permission after Leader exits');
  let view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  for (let i = 0; i < 30 && view.activation!.works[0]!.status === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
  }
  assert.equal(String(view.activation!.works[0]!.status), 'waiting_approval');
  assert.equal((await f.gateway.permissionDecide({ sessionKey: 'web:other', requestId: prompt.requestId, decision: 'deny' })).delivered, false);
  assert.equal((await f.gateway.permissionDecide({ sessionKey: f.sessionKey, requestId: prompt.requestId, decision: 'deny' })).delivered, true);
  for (let i = 0; i < 100; i++) {
    view = await f.gateway.teamCommand!({ action: 'runtime_get', sessionKey: f.sessionKey }) as TeamRuntimeView;
    if (view.activation!.works[0]!.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(view.activation!.works[0]!.status, 'completed');
  assert.ok(!(await f.gateway.getActiveTurnSnapshot!({ sessionKey: f.sessionKey })).events.some(event => event.type === 'permission_request'));
});

function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function eventually(check: () => Promise<boolean>, label: string) {
  const until = Date.now() + 6000;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`Timed out: ${label}`);
}

test('same-workspace member message reaches busy Leader before next LLM without ending its run', async t => {
  const f = await fixture(t, []);
  const leaderWaiting = gate(), releaseLeader = gate(), messageEnqueued = gate(); let leaderCalls = 0, workerCalls = 0;
  const router = (f.gateway as any).router;
  const originalSteer = router.steer.bind(router);
  router.steer = (sessionKey: string, input: any) => { const result = originalSteer(sessionKey, input); if (sessionKey === f.sessionKey && result.accepted) messageEnqueued.resolve(); return result; };
  f.setResponse(async function* (request) {
    if (request.model === 'worker') {
      await leaderWaiting.promise;
      if (++workerCalls === 1) {
        yield { type: 'tool_call_start', id: 'question', name: 'team_send_message' };
        yield { type: 'tool_call_end', toolCall: { id: 'question', name: 'team_send_message', input: { recipientId: f.leader.id, text: 'COORDINATION_MARKER', requestToken: 'question' } } }; return;
      }
      yield { type: 'text_delta', text: 'FINAL_WORKER_RESULT_PRIVATE' }; return;
    }
    if (++leaderCalls === 1) {
      yield { type: 'tool_call_start', id: 'delegate', name: 'team_delegate' };
      yield { type: 'tool_call_end', toolCall: { id: 'delegate', name: 'team_delegate', input: { participantId: f.worker.id, task: 'inspect', requestToken: 'inspect' } } }; return;
    }
    if (leaderCalls === 2) { leaderWaiting.resolve(); await releaseLeader.promise; }
    yield { type: 'text_delta', text: 'leader continues' };
  });
  const { activation } = await f.select(); const events: GatewayEvent[] = [];
  const running = (async () => { for await (const event of f.gateway.submitTurn({ sessionKey: f.sessionKey, projectKey: f.workspace, channelKey: 'web', message: 'inspect', runId: 'busy-leader', teamActivationId: activation!.id, teamStopVersion: activation!.stopVersion })) events.push(event); })();
  t.after(() => releaseLeader.resolve());
  await leaderWaiting.promise;
  await messageEnqueued.promise;
  await eventually(async () => {
    const view = await f.gateway.teamCommand!({ action:'runtime_get', sessionKey:f.sessionKey }) as TeamRuntimeView;
    return !!view.activation?.notifications.some(n => n.kind === 'message' && n.owner);
  }, 'message claimed while Leader LLM is in flight');
  assert.ok(f.requests.some(request => request.model === 'worker'), 'member starts while Leader still holds its run');
  releaseLeader.resolve(); await running;
  await eventually(async () => { const view = await f.gateway.teamCommand!({action:'runtime_get',sessionKey:f.sessionKey}) as TeamRuntimeView; return view.activation!.notifications.every(n => !!n.deliveredAt); }, 'notifications applied');
  const mainStorage = createAgentProjectSessionStorage({projectRoot:f.workspace,pilotHome:f.home,sessionId:f.sessionKey});
  const transcript = await readTranscript(mainStorage.transcriptPath);
  const applied = transcript.entries.filter(entry => entry.type === 'durable_message' && entry.message.metadata?.purpose === 'team_runtime');
  assert.ok(applied.some(entry => entry.turnId === 'busy-leader' && JSON.stringify(entry).includes('COORDINATION_MARKER')));
  assert.ok(events.some(event => event.type === 'steer_applied' && event.purpose === 'team_runtime'));
  assert.ok(f.requests.filter(request => request.model === 'leader').slice(2).some(request => JSON.stringify(request.messages).includes('COORDINATION_MARKER')));
  assert.ok(!f.requests.filter(request => request.model === 'leader').some(request => JSON.stringify(request.messages).includes('FINAL_WORKER_RESULT_PRIVATE')), 'auto notification omits final member reply');
  await assert.rejects(stat(join(f.home, 'checkpoints')), {code:'ENOENT'});
});

test('running member receives coordination in its current task turn', async t => {
  const f = await fixture(t, []); const workerWaiting = gate(), releaseWorker = gate(), allowMessage = gate(), messageEnqueued = gate(); let leaderCalls = 0, workerCalls = 0;
  f.setResponse(async function* (request) {
    if (request.model === 'worker') {
      if (++workerCalls === 1) { workerWaiting.resolve(); await releaseWorker.promise; }
      yield {type:'text_delta',text:'member final'}; return;
    }
    if (++leaderCalls === 1) {
      yield {type:'tool_call_start',id:'delegate',name:'team_delegate'};
      yield {type:'tool_call_end',toolCall:{id:'delegate',name:'team_delegate',input:{participantId:f.worker.id,task:'work'}}}; return;
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
  const active = (f.registry as any).activeTeamParticipants.get(`team-internal:${activation!.id}:${f.worker.id}`);
  const originalSteer = active.session.steer.bind(active.session);
  active.session.steer = (input: any) => { const result=originalSteer(input); if(result.accepted) messageEnqueued.resolve(); return result; };
  allowMessage.resolve(); await messageEnqueued.promise;
  await eventually(async () => {const view=await f.gateway.teamCommand!({action:'runtime_get',sessionKey:f.sessionKey}) as TeamRuntimeView;return !!view.activation!.messages.find(m=>m.text==='MEMBER_COORDINATION' && m.owner);}, 'member message claimed');
  releaseWorker.resolve(); await running;
  await eventually(async () => {const view=await f.gateway.teamCommand!({action:'runtime_get',sessionKey:f.sessionKey}) as TeamRuntimeView;return view.activation!.works[0]?.status==='completed';}, 'member task completion');
  const entries=(await readTranscript(join(f.home,'team-runtime','contexts',activation!.id,f.worker.id,'context.jsonl'))).entries;
  assert.equal(entries.filter(entry=>entry.type==='accepted_input').length,1,'no extra coordination turn');
  assert.ok(entries.some(entry=>entry.type==='durable_message' && JSON.stringify(entry).includes('MEMBER_COORDINATION')));
  assert.equal(workerCalls,2);
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
