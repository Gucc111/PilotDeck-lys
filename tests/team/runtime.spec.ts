import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { TeamRuntime, type TeamRuntimeActor } from '../../src/team/TeamRuntime.js';
import { TeamRuntimeStore } from '../../src/team/runtimeStore.js';
import { createTeamRuntimeTools } from '../../src/team/runtimeTools.js';
import { PermissionRuntime } from '../../src/permission/decision/PermissionRuntime.js';
import { createDefaultPermissionContext } from '../../src/permission/protocol/types.js';
import type { AgentProfile, TeamDefinition } from '../../src/team/types.js';
import type { TeamParticipantExecution, TeamRuntimeActivation, TeamRuntimeOptions, TeamRuntimeParticipant } from '../../src/team/runtimeTypes.js';

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(fn: () => Promise<T | undefined | false>, message = 'condition'): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(); }
  throw new Error(`Timed out: ${message}`);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function profile(role: 'leader' | 'teammate', name: string): AgentProfile {
  return { id: randomUUID(), revision: 1, role, archived: false, createdAt: '', updatedAt: '', config: { displayName: name, description: `${name} role`, systemPrompt: `${name} private persona`, model: { mode: 'default' }, workspace: { mode: 'team' }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default' } };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, overrides: Partial<TeamRuntimeOptions> = {}) {
  const pilotHome = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-team-runtime-'));
  const leader = profile('leader', 'Leader'), a = profile('teammate', 'A'), b = profile('teammate', 'B');
  const team: TeamDefinition = { id: randomUUID(), revision: 1, archived: false, createdAt: '', updatedAt: '', leader, teammates: [a, b], config: { displayName: 'Review Team', description: '', instructions: 'Coordinate review', defaultProjectKey: 'project', leader: { id: leader.id, revision: 1 }, teammates: [{ id: a.id, revision: 1 }, { id: b.id, revision: 1 }] } };
  const participants: TeamRuntimeParticipant[] = [leader, a, b].map(p => ({ id: p.id, role: p.role, profile: p, projectKey: 'project', projectPath: '/project', model: { mode: 'model', provider: 'mock', model: 'test' }, capabilities: p.config.capabilities }));
  const executed: TeamParticipantExecution[] = [];
  const options: TeamRuntimeOptions = { pilotHome, resolveTeam: async () => structuredClone(team), probe: async () => ({ projectKey: 'project', participants: structuredClone(participants), issues: [], environmentFingerprint: 'env1' }), executeParticipant: async input => { executed.push(input); return { text: `Result for ${input.work?.task ?? 'message'}` }; }, notifyLeader: async () => true, ...overrides };
  const runtime = new TeamRuntime(options);
  t.after(async () => { await runtime.dispose(); await rm(pilotHome, { recursive: true, force: true }); });
  const select = () => runtime.execute({ action: 'runtime_select', sessionKey: 'web:main', team: { id: team.id, revision: 1 }, requestToken: 'select-1' });
  const activate = async () => { const result = await select() as { activation: TeamRuntimeActivation }; return result.activation; };
  const actor = (activation: TeamRuntimeActivation, participantId = leader.id): TeamRuntimeActor => ({ sessionKey: activation.sessionKey, activationId: activation.id, participantId });
  return { pilotHome, options, runtime, team, leader, a, b, participants, executed, select, activate, actor };
}

test('selection freezes configuration, is idempotent, calls no models, and enforces activation identities', async t => {
  const f = await fixture(t); const activation = await f.activate();
  assert.equal(f.executed.length, 0);
  assert.deepEqual(await f.select(), { activation });
  f.team.config.displayName = 'Edited source';
  assert.equal((await f.runtime.get('web:main')).activation?.team.config.displayName, 'Review Team');
  assert.equal((await f.runtime.assertActivation('web:main', undefined))?.id, activation.id);
  await assert.rejects(f.runtime.assertActivation('web:main', null), /changed Team mode/);
  await assert.rejects(f.runtime.execute({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'select-1' }), /different parameters/);
  assert.equal(await f.runtime.projectReferences('project'), true);
  const solo = await f.runtime.execute({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'exit' });
  assert.deepEqual(solo, { activation: null });
  assert.equal((await f.runtime.get('web:main')).history?.[0]?.id, activation.id);
  assert.equal((await f.runtime.get('web:main')).history?.[0]?.status, 'closed');
  await assert.rejects(f.runtime.delegate(f.actor(activation), { participantId: f.a.id, task: 'Late task', requestToken: 'late' }), /no longer current/);
  const second = await f.runtime.execute({ action: 'runtime_select', sessionKey: 'web:main', team: { id: f.team.id, revision: 1 }, requestToken: 'new' }) as { activation: TeamRuntimeActivation };
  assert.notEqual(second.activation.id, activation.id);
});

test('missing mandatory requirements block selection; optional acceptance is bound to fresh probe', async t => {
  const f = await fixture(t); let environmentFingerprint = 'v1'; let warning = true;
  f.options.probe = async () => ({ projectKey: 'project', participants: f.participants, environmentFingerprint, issues: [{ severity: warning ? 'warning' : 'error', code: 'MISSING', message: 'Search server unavailable' }] });
  const probe = await f.runtime.probe({ id: f.team.id, revision: 1 });
  await assert.rejects(f.select(), /confirm.*compatibility warnings/);
  environmentFingerprint = 'v2';
  await assert.rejects(f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: { id: f.team.id, revision: 1 }, requestToken: 'stale', probeFingerprint: probe.fingerprint }), /changed/);
  const current = await f.runtime.probe({ id: f.team.id, revision: 1 });
  await f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: { id: f.team.id, revision: 1 }, requestToken: 'ok', probeFingerprint: current.fingerprint });
  warning = false;
  await assert.rejects(f.runtime.select({ action: 'runtime_select', sessionKey: 'web:other', team: { id: f.team.id, revision: 1 }, requestToken: 'blocked', probeFingerprint: current.fingerprint }), /Search server unavailable/);
});

test('different members run in parallel, one member serially, and durable results precede notification', async t => {
  const gates = new Map<string, ReturnType<typeof deferred<{ text: string }>>>(); const started: string[] = []; const notifications: string[] = [];
  const f = await fixture(t, { executeParticipant: async input => {
    started.push(input.work!.task); const gate = deferred<{ text: string }>(); gates.set(input.work!.task, gate);
    assert.ok(input.activation.works.every(w => w.participantId === input.participant.id));
    return gate.promise;
  }, notifyLeader: async ({ activation, notifications: batch }) => {
    const saved = new TeamRuntimeStore(f.pilotHome); const disk = (await saved.read()).activations[activation.id]!;
    for (const n of batch) { assert.equal(disk.works.find(w => w.id === n.workId)?.status, 'completed'); notifications.push(n.workId!); }
    return true;
  } });
  const activation = await f.activate(), actor = f.actor(activation);
  const first = await f.runtime.delegate(actor, { participantId: f.a.id, task: 'A1', requestToken: 'a1' });
  const duplicate = await f.runtime.delegate(actor, { participantId: f.a.id, task: 'A1', requestToken: 'a1' }); assert.equal(duplicate.id, first.id);
  await assert.rejects(f.runtime.delegate(actor, { participantId: f.a.id, task: 'Changed', requestToken: 'a1' }), /different parameters/);
  const second = await f.runtime.delegate(actor, { participantId: f.a.id, task: 'A2', requestToken: 'a2' });
  const third = await f.runtime.delegate(actor, { participantId: f.b.id, task: 'B1', requestToken: 'b1' });
  await until(async () => started.includes('A1') && started.includes('B1')); assert.ok(!started.includes('A2'));
  gates.get('B1')!.resolve({ text: 'B result' }); gates.get('A1')!.resolve({ text: 'A1 result' });
  await until(async () => started.includes('A2')); gates.get('A2')!.resolve({ text: 'A2 result' });
  await until(async () => notifications.length === 3);
  assert.equal((await f.runtime.collect(actor, second.id)).result, 'A2 result');
  const count = started.length; await f.runtime.collect(actor, third.id); assert.equal(started.length, count);
});

test('peer messages go to Leader, relay preserves provenance, and tools reject actor spoofing', async t => {
  const f = await fixture(t); const activation = await f.activate();
  const message = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.b.id, text: 'Which config?', requestToken: 'message' });
  assert.equal(message.recipientId, f.leader.id); assert.equal(message.intendedRecipientId, f.b.id);
  await pause(30); assert.equal(f.executed.length, 0);
  await assert.rejects(f.runtime.relay(f.actor(activation, f.b.id), { messageId: message.id, requestToken: 'bad' }), /Only the receiving Leader/);
  const relayed = await f.runtime.relay(f.actor(activation), { messageId: message.id, requestToken: 'relay' });
  assert.equal(relayed.senderId, f.a.id); assert.equal(relayed.relayOf, message.id); assert.equal(relayed.recipientId, f.b.id);
  await until(async () => f.executed.length === 1);
  assert.deepEqual(f.executed[0]!.messages?.map(m => m.id), [relayed.id]);
  await assert.rejects(f.runtime.send(f.actor(activation, f.a.id), { recipientId: 'other-team-member', text: 'Leak', requestToken: 'foreign' }), /another participant/);
  await assert.rejects(f.runtime.delegate(f.actor(activation, f.a.id), { participantId: f.b.id, task: 'Cannot delegate', requestToken: 'deny' }), /Only the Leader/);
  const inspect = await f.runtime.inspect(f.actor(activation, f.b.id));
  assert.equal('profile' in inspect.participants[0]!, false);
  assert.ok(!JSON.stringify(inspect.participants).includes('private persona'));
  const sendTool = createTeamRuntimeTools(f.runtime, f.actor(activation, f.a.id)).find(tool => tool.name === 'team_send_message')!;
  await assert.rejects(sendTool.execute({ recipientId: f.b.id, text: 'Spoof', senderId: f.leader.id }, {} as never), /senderId: unsupported field/);
});

test('waiting for information resumes the same work when a message arrives', async t => {
  let invocations = 0; let workId = '';
  const f = await fixture(t, { executeParticipant: async input => {
    invocations++; workId = input.work!.id;
    if (invocations === 1) { await input.updateStatus('waiting_information'); return { text: 'Need environment' }; }
    assert.equal(input.work!.id, workId); assert.equal(input.messages?.[0]?.text, 'Use staging');
    return { text: 'Verified staging' };
  } });
  const activation = await f.activate(), actor = f.actor(activation);
  const work = await f.runtime.delegate(actor, { participantId: f.a.id, task: 'Verify', requestToken: 'verify' });
  await until(async () => (await f.runtime.collect(actor, work.id)).status === 'waiting_information');
  await f.runtime.send(actor, { recipientId: f.a.id, text: 'Use staging', requestToken: 'answer' });
  await until(async () => (await f.runtime.collect(actor, work.id)).status === 'completed');
  assert.equal(invocations, 2);
});

test('whole-team stop cancels queued and running work; late results cannot wake Leader or switch mode', async t => {
  const gate = deferred<{ text: string }>(); let executed = 0, notifications = 0;
  const f = await fixture(t, { executeParticipant: async () => { executed++; return gate.promise; }, notifyLeader: async () => { notifications++; return true; } });
  const activation = await f.activate(), actor = f.actor(activation);
  const first = await f.runtime.delegate(actor, { participantId: f.a.id, task: 'Active', requestToken: 'active' });
  await f.runtime.delegate(actor, { participantId: f.a.id, task: 'Queued', requestToken: 'queued' });
  await until(async () => executed === 1);
  await assert.rejects(f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'busy' }), /stop it/);
  await f.runtime.stop('web:main'); gate.resolve({ text: 'Too late' }); await pause(60);
  assert.equal((await f.runtime.collect(actor, first.id)).status, 'stopped'); assert.equal(executed, 1); assert.equal(notifications, 0);
  await f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'solo' });
});

test('restart marks uncertain running work interrupted and retries durable notifications without replay', async t => {
  const f = await fixture(t, { notifyLeader: async () => false }); const activation = await f.activate();
  const store = new TeamRuntimeStore(f.pilotHome);
  await store.locked(async () => {
    const state = await store.read();
    state.activations[activation.id]!.works.push({ id: 'interrupted-work', participantId: f.a.id, task: 'Uncertain tool side effect', status: 'running', createdAt: '', owner: { pid: process.pid, instanceId: 'dead-process-instance' } });
    await store.write(state);
  });
  await f.runtime.dispose();
  let executions = 0, seen = 0;
  const recovered = new TeamRuntime({ ...f.options, executeParticipant: async () => { executions++; return { text: 'Must not replay' }; }, notifyLeader: async ({ notifications }) => { seen += notifications.length; return true; } });
  t.after(async () => { await recovered.dispose(); });
  await until(async () => seen === 1);
  assert.equal((await recovered.get('web:main')).activation?.works[0]?.status, 'interrupted');
  assert.equal(executions, 0);
  await until(async () => (await recovered.get('web:main')).activation?.notifications[0]?.deliveredAt !== undefined);
});

test('notification budget is bounded and renewed only by explicit human input', async t => {
  let seen = 0;
  const f = await fixture(t, { maxAutomaticWakeups: 1, notifyLeader: async () => { seen++; return true; } }); const activation = await f.activate();
  await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'One', requestToken: '1' });
  await until(async () => seen === 1);
  await f.runtime.send(f.actor(activation, f.b.id), { recipientId: f.leader.id, text: 'Two', requestToken: '2' });
  await pause(40); assert.equal(seen, 1);
  assert.equal((await f.runtime.get('web:main')).continuationPaused, 'budget');
  await f.runtime.onHumanTurn('web:main', activation.id);
  await until(async () => seen === 2);
  await until(async () => !(await f.runtime.get('web:main')).continuationPaused);
});

test('coordination works in default permission mode while plan and explicit rules retain authority', async t => {
  const f = await fixture(t); const activation = await f.activate();
  const tools = createTeamRuntimeTools(f.runtime, f.actor(activation));
  const permissions = new PermissionRuntime();
  const context = { sessionId: 'web:main', turnId: 'turn', cwd: '/project', permissionMode: 'default' as const, permissionContext: createDefaultPermissionContext({ cwd: '/project', canPrompt: false }) };
  for (const tool of tools) assert.equal((await permissions.decide(tool, {}, context, 'call')).type, 'allow');
  const delegate = tools.find(tool => tool.name === 'team_delegate')!;
  context.permissionContext.mode = 'plan';
  assert.equal((await permissions.decide(delegate, {}, context, 'call')).type, 'deny');
  const inspect = tools.find(tool => tool.name === 'team_inspect')!;
  assert.equal((await permissions.decide(inspect, {}, context, 'call')).type, 'allow');
  context.permissionContext.mode = 'default';
  context.permissionContext.rules.deny.push({ source: 'project', behavior: 'deny', toolName: 'team_delegate' });
  assert.equal((await permissions.decide(delegate, {}, context, 'call')).type, 'deny');
});

test('lost notification acknowledgement keeps the same delivery batch across retries', async t => {
  const deliveries: Array<{ batchId: string | undefined; ids: string[] }> = []; let acknowledge = false;
  const f = await fixture(t, { notifyLeader: async ({ notifications }) => {
    deliveries.push({ batchId: notifications[0]!.batchId, ids: notifications.map(n => n.id) });
    return acknowledge;
  } }); const activation = await f.activate();
  await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'First', requestToken: 'first' });
  await until(async () => deliveries.length === 1);
  await f.runtime.send(f.actor(activation, f.b.id), { recipientId: f.leader.id, text: 'Later', requestToken: 'later' });
  await until(async () => deliveries.length >= 2);
  assert.ok(deliveries[0]!.batchId); assert.deepEqual(deliveries[1], deliveries[0]);
  acknowledge = true;
  await f.runtime.onLeaderIdle('web:main');
  await until(async () => (await f.runtime.get('web:main')).activation!.notifications.every(n => n.deliveredAt));
  assert.deepEqual(deliveries.at(-2), deliveries[0]);
  assert.notEqual(deliveries.at(-1)!.batchId, deliveries[0]!.batchId);
});

test('stop fences inputs already preparing but a later explicit input can continue', async t => {
  const f = await fixture(t); const activation = await f.activate();
  await f.runtime.stop('web:main');
  await assert.rejects(f.runtime.onHumanTurn('web:main', activation.id, activation.stopVersion), /stopped while being prepared/);
  const stopped = (await f.runtime.get('web:main')).activation!;
  assert.equal(stopped.status, 'stopped');
  await f.runtime.onHumanTurn('web:main', activation.id, stopped.stopVersion);
  assert.equal((await f.runtime.get('web:main')).activation?.status, 'active');
});

test('answers resume their related waiting work and ambiguous messages remain coordination', async t => {
  const executions: Array<{ workId?: string; texts: string[] }> = [];
  const questions = new Map<string, string>();
  const f = await fixture(t, { executeParticipant: async input => {
    executions.push({ workId: input.work?.id, texts: input.messages?.map(message => message.text) ?? [] });
    if (input.work && !input.messages?.length) {
      const question = await f.runtime.send({ sessionKey: input.activation.sessionKey, activationId: input.activation.id, participantId: input.participant.id }, { recipientId: f.leader.id, workId: input.work.id, text: `Question for ${input.work.task}`, requestToken: input.work.id });
      questions.set(input.work.id, question.id);
      await input.updateStatus('waiting_information');
      return { text: 'Awaiting answer' };
    }
    return { text: input.messages?.[0]?.text ?? '' };
  } });
  const activation = await f.activate(), actor = f.actor(activation);
  const a = await f.runtime.delegate(actor, { participantId: f.a.id, task: 'Task A', requestToken: 'task-a' });
  const b = await f.runtime.delegate(actor, { participantId: f.a.id, task: 'Task B', requestToken: 'task-b' });
  await until(async () => (await f.runtime.get('web:main')).activation?.works.every(work => work.status === 'waiting_information'));
  await f.runtime.send(actor, { recipientId: f.a.id, text: 'Unlabelled coordination', requestToken: 'ambiguous' });
  await until(async () => executions.length === 3);
  assert.deepEqual(executions[2], { workId: undefined, texts: ['Unlabelled coordination'] });
  assert.equal((await f.runtime.collect(actor, a.id)).status, 'waiting_information');
  assert.equal((await f.runtime.collect(actor, b.id)).status, 'waiting_information');
  await f.runtime.send(actor, { recipientId: f.a.id, workId: b.id, text: 'Answer B', requestToken: 'answer-b' });
  await until(async () => (await f.runtime.collect(actor, b.id)).status === 'completed');
  assert.deepEqual(executions[3], { workId: b.id, texts: ['Answer B'] });
  assert.equal((await f.runtime.collect(actor, a.id)).status, 'waiting_information');
  await f.runtime.send(actor, { recipientId: f.a.id, replyTo: questions.get(a.id), text: 'Answer A', requestToken: 'answer-a' });
  await until(async () => (await f.runtime.collect(actor, a.id)).status === 'completed');
  assert.deepEqual(executions[4], { workId: a.id, texts: ['Answer A'] });
});
