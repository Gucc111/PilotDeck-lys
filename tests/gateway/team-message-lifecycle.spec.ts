import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createProjectId } from '../../src/pilot/index.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest, type ModelRuntimeOptions } from '../../src/model/index.js';
import { readTranscript } from '../../src/session/index.js';
import type { AgentProfile, TeamDefinition } from '../../src/team/types.js';
import type { TeamRuntimeMessage, TeamRuntimeView } from '../../src/team/runtimeTypes.js';
import type { TeamRuntime } from '../../src/team/TeamRuntime.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function eventually(condition: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${label}`);
}
async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'team-message-lifecycle-')), home = join(base, 'home'), workspace = join(base, 'workspace');
  await mkdir(join(home, 'skills'), { recursive: true }); await mkdir(workspace);
  const registration = join(home, 'projects', createProjectId(workspace)); await mkdir(registration, { recursive: true }); await writeFile(join(registration, '.cwd'), workspace);
  await writeFile(join(home, 'pilotdeck.yaml'), `schemaVersion: 1
agent: { model: test/leader, maxContextTokens: 32768, maxOutputTokens: 4096 }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: fixture-only
      models: { leader: {}, worker: {} }
`);
  const requests: CanonicalModelRequest[] = [];
  let boundary = gate(), release = gate(), blockWorker = true;
  const options = { pilotHome: home, projectRoot: workspace, builtinSkillsRoot: join(home, 'skills'), env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
    __testModelFactory: (snapshot: any) => ({ ...createModelRuntime(snapshot.config.model), async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '{"title":"Lifecycle check"}' }], finishReason: 'stop' as const }; }, async *stream(request: CanonicalModelRequest, callOptions?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent> {
      if (request.model === 'worker' && blockWorker) {
        boundary.resolve();
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(Object.assign(new Error('Controlled pre-send abort'), { name: 'AbortError' }));
          if (callOptions?.signal?.aborted) { aborted(); return; }
          callOptions?.signal?.addEventListener('abort', aborted, { once: true });
          void release.promise.then(() => { callOptions?.signal?.removeEventListener('abort', aborted); resolve(); });
        });
      }
      if (callOptions?.dispatchRequest) {
        const sent = await callOptions.dispatchRequest({ request, start: accepted => { requests.push(structuredClone(accepted)); return Promise.resolve(accepted); } });
        request = await sent.value;
      } else requests.push(structuredClone(request));
      yield { type: 'request_started', provider: request.provider, model: request.model }; yield { type: 'message_start', role: 'assistant' };
      yield { type: 'text_delta', text: request.model === 'worker' ? 'Formal worker result' : 'Leader response' }; yield { type: 'message_end', finishReason: 'stop' };
    } }),
  };
  let local = createLocalGateway(options);
  t.after(async () => { release.resolve(); await local.dispose(); await rm(base, { recursive: true, force: true }); });
  const saveProfile = (role: 'leader' | 'teammate', model: string) => local.gateway.teamCommand!({ action: 'profile_save', role, requestToken: role, config: { displayName: role, description: '', systemPrompt: `Role ${role}`, model: { mode: 'model', provider: 'test', model }, workspace: { mode: 'team' }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'bypassPermissions' } }) as Promise<AgentProfile>;
  const leader = await saveProfile('leader', 'leader'), worker = await saveProfile('teammate', 'worker');
  const team = await local.gateway.teamCommand!({ action: 'team_save', requestToken: 'team', config: { displayName: 'Lifecycle test', description: '', instructions: '', defaultProjectKey: workspace, leader: { id: leader.id }, teammates: [{ id: worker.id }] } }) as TeamDefinition;
  const sessionKey = 'web:lifecycle';
  await local.gateway.teamCommand!({ action: 'runtime_select', sessionKey, storageProjectKey: workspace, team: { id: team.id }, requestToken: 'select' });
  const view = async () => (await local.gateway.teamCommand!({ action: 'runtime_get', sessionKey }) as TeamRuntimeView).activation!;
  const runtime = () => (local.registry as unknown as { teamRuntime: TeamRuntime }).teamRuntime;
  return { home, workspace, sessionKey, worker, leader, requests, view,
    async send(text: string, token: string) { const activation = await view(); return runtime().send({ sessionKey, activationId: activation.id, stopVersion: activation.stopVersion, participantId: leader.id }, { recipientId: worker.id, text, requestToken: token }); },
    async remove(message: TeamRuntimeMessage) { const activation = await view(); return local.gateway.teamCommand!({ action: 'runtime_message_delete', sessionKey, activationId: activation.id, stopVersion: message.stopVersion, participantId: worker.id, messageId: message.id }); },
    async abort() { const activation = await view(); return local.gateway.abortTurn({ sessionKey, teamActivationId: activation.id, teamStopVersion: activation.stopVersion }); },
    async human(runId = 'new-human') { const activation = await view(); const events = []; for await (const event of local.gateway.submitTurn({ sessionKey, projectKey: workspace, channelKey: 'web', message: 'Continue with this new request', runId, teamActivationId: activation.id, teamStopVersion: activation.stopVersion })) events.push(event); return events; },
    get boundary() { return boundary.promise; }, release() { release.resolve(); },
    async restart() { await local.dispose(); release.resolve(); local = createLocalGateway(options); },
    allowWorker() { blockWorker = false; release.resolve(); },
    resetGate() { boundary = gate(); release = gate(); blockWorker = true; },
  };
}

test('Gateway filters a withdrawn full batch at actual send and sends each deletion feedback once', async t => {
  const f = await fixture(t), one = await f.send('First queued body', 'one'); await f.boundary;
  const two = await f.send('Second queued body', 'two');
  await f.remove(one); await f.remove(one); await f.remove(two); f.release();
  await eventually(async () => (await f.view()).turns!.some(turn => turn.participantId === f.worker.id && turn.status === 'ended'), 'empty execution exits');
  const view = await f.view();
  assert.equal(f.requests.filter(request => request.model === 'worker').length, 0);
  assert.equal(view.messages.filter(message => message.kind === 'message_deleted').length, 2);
  assert.equal(view.messages.filter(message => message.kind === 'turn_ended').length, 0);
  assert.ok(!view.messages.some(message => message.id === one.id || message.id === two.id));
  const transcript = await readTranscript(join(f.home, 'team-runtime', 'contexts', view.id, f.worker.id, 'context.jsonl'));
  assert.equal(JSON.stringify(transcript.entries).includes('First queued body'), false);
  assert.equal(JSON.stringify(transcript.entries).includes('Second queued body'), false);
});

test('Gateway Abort invalidates a pre-send batch and fresh human input cannot resurrect it', async t => {
  const f = await fixture(t), one = await f.send('OLD_ABORT_BODY', 'abort-one'); await f.boundary; await f.send('OLD_ABORT_BODY_TWO', 'abort-two');
  await f.abort(); f.allowWorker();
  let view = await f.view(); assert.equal(view.status, 'stopped'); assert.ok(view.messages.filter(message => message.kind === 'member').every(message => message.status === 'invalidated'));
  assert.equal(f.requests.filter(request => request.model === 'worker').length, 0); assert.equal(view.messages.filter(message => message.kind === 'turn_ended').length, 0);
  assert.ok(!(await f.human()).some(event => event.type === 'error'));
  assert.equal(JSON.stringify(f.requests).includes('OLD_ABORT_BODY'), false);
  await f.remove(one); view = await f.view(); assert.equal(view.messages.filter(message => message.kind === 'message_deleted').length, 0);
  await f.send('NEW_VALID_BODY', 'fresh');
  await eventually(async () => f.requests.some(request => request.model === 'worker'), 'fresh current-generation worker send');
  assert.equal(JSON.stringify(f.requests).includes('OLD_ABORT_BODY'), false); assert.equal(JSON.stringify(f.requests).includes('NEW_VALID_BODY'), true);
});

test('Gateway restart invalidates pre-send records without re-sending them or producing old notices', async t => {
  const f = await fixture(t); await f.send('OLD_RESTART_BODY', 'restart'); await f.boundary;
  await f.restart(); f.allowWorker();
  const recovered = await f.view(); assert.equal(recovered.status, 'stopped'); assert.equal(recovered.stopReason, 'restart'); assert.equal(recovered.messages[0]?.status, 'invalidated');
  assert.equal(f.requests.filter(request => request.model === 'worker').length, 0);
  assert.ok(!(await f.human('post-restart-human')).some(event => event.type === 'error'));
  assert.equal(JSON.stringify(f.requests).includes('OLD_RESTART_BODY'), false);
  assert.equal((await f.view()).messages.filter(message => message.kind === 'turn_ended').length, 0);
});
