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
  const options: TeamRuntimeOptions = { pilotHome, resolveTeam: async () => structuredClone(team), probe: async () => ({ projectKey: 'project', participants: structuredClone(participants), issues: [], environmentFingerprint: 'env1' }), executeParticipant: async input => { executed.push(input); await input.acceptMessages(); return { text: `Result for ${input.work?.task ?? 'message'}` }; }, notifyLeader: async () => ({ delivered: true, startedTurn: true }), stopTimeoutMs: 1000, ...overrides };
  const runtime = new TeamRuntime(options);
  t.after(async () => { await runtime.dispose(); await rm(pilotHome, { recursive: true, force: true }); });
  const select = () => runtime.execute({ action: 'runtime_select', sessionKey: 'web:main', team: { id: team.id, revision: 1 }, requestToken: 'select-1' });
  const activate = async () => { const result = await select() as { activation: TeamRuntimeActivation }; return result.activation; };
  const actor = (activation: TeamRuntimeActivation, participantId = leader.id): TeamRuntimeActor => ({ sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: activation.stopVersion, participantId });
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
  const f = await fixture(t, { stopTimeoutMs: 30, executeParticipant: async () => { executed++; return gate.promise; }, notifyLeader: async () => { notifications++; return true; } });
  const activation = await f.activate(), actor = f.actor(activation);
  const first = await f.runtime.delegate(actor, { participantId: f.a.id, task: 'Active', requestToken: 'active' });
  await f.runtime.delegate(actor, { participantId: f.a.id, task: 'Queued', requestToken: 'queued' });
  await until(async () => executed === 1);
  await assert.rejects(f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'busy' }), /stop it/);
  await f.runtime.stop('web:main'); gate.resolve({ text: 'Too late' }); await until(async () => (await f.runtime.get('web:main')).activation?.status === 'stopped');
  assert.equal((await f.runtime.get('web:main')).activation!.works.find(w => w.id === first.id)!.status, 'stopped'); assert.equal(executed, 1); assert.equal(notifications, 0);
  await f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'solo' });
});

test('restart interrupts all old work and invalidates pending messages and notifications without replay', async t => {
  const f = await fixture(t, { notifyLeader: async () => false }); const activation = await f.activate();
  const store = new TeamRuntimeStore(f.pilotHome);
  await store.locked(async () => {
    const state = await store.read();
    state.activations[activation.id]!.works.push({ id: 'interrupted-work', stopVersion: activation.stopVersion, participantId: f.a.id, task: 'Uncertain tool side effect', status: 'running', createdAt: '', owner: { pid: process.pid, instanceId: 'dead-process-instance' } });
    await store.write(state);
  });
  await f.runtime.dispose();
  let executions = 0, seen = 0;
  const recovered = new TeamRuntime({ ...f.options, executeParticipant: async () => { executions++; return { text: 'Must not replay' }; }, notifyLeader: async ({ notifications }) => { seen += notifications.length; return true; } });
  t.after(async () => { await recovered.dispose(); });
  const restarted = (await recovered.get('web:main')).activation!;
  assert.equal(restarted.works[0]?.status, 'interrupted');
  assert.equal(restarted.status, 'stopped'); assert.equal(restarted.stopReason, 'restart');
  assert.equal(restarted.stopVersion, activation.stopVersion + 1);
  await pause(50); assert.equal(executions, 0); assert.equal(seen, 0);
  assert.equal(restarted.notifications.length, 0);
});

test('notification budget is bounded and renewed only by explicit human input', async t => {
  let seen = 0;
  const f = await fixture(t, { maxAutomaticWakeups: 1, notifyLeader: async ({ allowStartTurn }) => { if (!allowStartTurn) return { delivered: false }; seen++; return { delivered: true, startedTurn: true }; } }); const activation = await f.activate();
  await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'One', requestToken: '1' });
  await until(async () => seen === 1);
  await f.runtime.send(f.actor(activation, f.b.id), { recipientId: f.leader.id, text: 'Two', requestToken: '2' });
  await pause(40); assert.equal(seen, 1);
  assert.equal((await f.runtime.get('web:main')).continuationPaused, 'budget');
  await f.runtime.onHumanTurn('web:main', activation.id, activation.stopVersion);
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
      const question = await f.runtime.send({ sessionKey: input.activation.sessionKey, activationId: input.activation.id, stopVersion: input.activation.stopVersion, participantId: input.participant.id }, { recipientId: f.leader.id, workId: input.work.id, text: `Question for ${input.work.task}`, requestToken: input.work.id });
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

test('Abort is idempotent for its original generation and reports real outstanding cleanup', async t => {
  const member = deferred<{ text: string }>(), leader = deferred<void>();
  let started = false, leaderStops = 0;
  const f = await fixture(t, {
    stopTimeoutMs: 30, executeParticipant: async () => { started = true; return member.promise; },
    stopLeader: async () => { leaderStops++; return leader.promise; },
  });
  const activation = await f.activate(), actor = f.actor(activation);
  await f.runtime.delegate(actor, { participantId: f.a.id, task: 'Slow cleanup', requestToken: 'slow' });
  await until(async () => started);
  const expected = { activationId: activation.id, stopVersion: activation.stopVersion };
  const stopping = (await f.runtime.stop('web:main', expected)).activation!;
  assert.equal(stopping.status, 'stopping'); assert.equal(stopping.stopVersion, 1);
  assert.equal(stopping.cleanup?.timedOut, true);
  // The timeout receipt can precede the asynchronous cleanup-detail write.
  // Wait for that observable boundary rather than assuming a 30 ms I/O budget.
  await until(async () => (await f.runtime.get('web:main')).activation?.cleanup?.pending.includes('leader'));
  assert.ok((await f.runtime.get('web:main')).activation!.cleanup!.pending.includes('leader'));
  const retry = (await f.runtime.stop('web:main', expected)).activation!;
  assert.equal(retry.stopVersion, 1); assert.equal(leaderStops, 1);
  await assert.rejects(f.runtime.onHumanTurn('web:main', activation.id, 1), /still stopping/);
  await assert.rejects(f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'exit-stopping' }), /stop it/);
  member.resolve({ text: 'late output' }); leader.resolve();
  await until(async () => (await f.runtime.get('web:main')).activation?.status === 'stopped');
  await f.runtime.onHumanTurn('web:main', activation.id, 1);
  await assert.rejects(f.runtime.stop('web:main', expected), /expired/);
  await assert.rejects(f.runtime.delegate(actor, { participantId: f.a.id, task: 'stale model response', requestToken: 'late' }), /expired/);
  assert.equal((await f.runtime.get('web:main')).activation?.status, 'active');
});

test('selection receipts and read tools never silently upgrade their captured generation', async t => {
  const f = await fixture(t), activation = await f.activate();
  await f.runtime.stop('web:main', { activationId: activation.id, stopVersion: 0 });
  await assert.rejects(f.select(), /expired Team run/);
  await assert.rejects(f.runtime.inspect(f.actor(activation)), /expired Team run/);
  await assert.rejects(f.runtime.assertActivation('web:main', activation.id, 0), /expired run/);
  await assert.rejects(f.runtime.execute({ action: 'runtime_stop', sessionKey: 'web:main' } as never), /activationId/);
});

test('restart invalidates queued work, unanswered coordination, and saved outbox batches', async t => {
  const f = await fixture(t), activation = await f.activate();
  const store = new TeamRuntimeStore(f.pilotHome);
  await f.runtime.dispose();
  await store.locked(async () => {
    const state = await store.read(), a = state.activations[activation.id]!;
    a.works = [{ id: 'queued', stopVersion: 0, participantId: f.a.id, task: 'never started', status: 'queued', createdAt: '' }, { id: 'done', stopVersion: 0, participantId: f.b.id, task: 'history', status: 'completed', result: 'keep me', createdAt: '' }];
    a.messages = [{ id: 'reminder', stopVersion: 0, senderId: f.leader.id, recipientId: f.a.id, intendedRecipientId: f.a.id, text: 'finish old task', status: 'queued', createdAt: '' }];
    a.notifications = [{ id: 'notice', stopVersion: 0, kind: 'work_completed', participantId: f.b.id, workId: 'done', summary: 'done', createdAt: '', batchId: 'saved-batch' }];
    await store.write(state);
  });
  let executions = 0, notices = 0;
  const recovered = new TeamRuntime({ ...f.options, executeParticipant: async () => { executions++; return { text: '' }; }, notifyLeader: async () => { notices++; return true; } });
  t.after(() => recovered.dispose());
  const result = (await recovered.get('web:main')).activation!;
  assert.equal(result.works[0]!.status, 'interrupted'); assert.equal(result.works[1]!.result, 'keep me');
  assert.equal(result.messages[0]!.status, 'interrupted'); assert.ok(result.messages[0]!.invalidatedAt);
  assert.ok(result.notifications[0]!.cancelledAt); assert.equal(result.stopReason, 'restart');
  await recovered.onLeaderIdle('web:main'); await pause(40);
  assert.equal(executions, 0); assert.equal(notices, 0);
  await recovered.onHumanTurn('web:main', result.id, result.stopVersion); await pause(40);
  assert.equal(executions, 0); assert.equal(notices, 0);
});

test('legacy journals migrate atomically while malformed generations fail explicitly', async t => {
  const f = await fixture(t), activation = await f.activate(), store = new TeamRuntimeStore(f.pilotHome);
  await f.runtime.dispose();
  await store.locked(async () => {
    const state = await store.read(); state.version = 1;
    const a = state.activations[activation.id]!;
    delete (a as Partial<TeamRuntimeActivation>).stopVersion; delete a.runtimeOwner;
    a.messages.push({ id: 'legacy', senderId: f.leader.id, recipientId: f.a.id, intendedRecipientId: f.a.id, text: 'old pending', status: 'queued', createdAt: '' } as never);
    await store.write(state);
  });
  const recovered = new TeamRuntime(f.options); t.after(() => recovered.dispose());
  const migrated = (await recovered.get('web:main')).activation!;
  assert.equal(migrated.stopVersion, 1); assert.equal(migrated.messages[0]!.stopVersion, 0);
  assert.equal(migrated.messages[0]!.status, 'interrupted'); assert.equal((await store.read()).version, 2);
  await recovered.dispose();
  await store.locked(async () => { const state = await store.read(); state.activations[activation.id]!.messages[0]!.stopVersion = -1; await store.write(state); });
  const corrupt = new TeamRuntime(f.options); t.after(() => corrupt.dispose());
  await assert.rejects(corrupt.get('web:main'), /cannot be read.*generation/);
});

test('busy Leader injection does not consume automatic wakeup budget or include final result', async t => {
  let starts = 0, injected = 0;
  const f = await fixture(t, { maxAutomaticWakeups: 1, isLeaderBusy: () => true, executeParticipant: async () => ({ text: 'PRIVATE FINAL DELIVERABLE' }), notifyLeader: async ({ activation, notifications, allowStartTurn }) => {
    if (!starts) { assert.equal(allowStartTurn, true); starts++; return { delivered: true, startedTurn: true }; }
    assert.equal(allowStartTurn, false); injected++;
    assert.ok(notifications.every(n => !n.summary.includes('PRIVATE FINAL DELIVERABLE')));
    assert.ok(notifications.every(n => n.kind === 'message' || !n.summary.includes('SECRET TASK TEXT')));
    assert.equal(activation.automaticWakeups, 1);
    return { delivered: true, startedTurn: false };
  } });
  // Busy applies only after selection; it is a property of the current session.
  f.options.isLeaderBusy = () => false; const activation = await f.activate(); f.options.isLeaderBusy = () => true;
  await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'progress', requestToken: 'first-notice' });
  await until(async () => starts === 1 && (await f.runtime.get('web:main')).activation?.automaticWakeups === 1);
  await f.runtime.delegate(f.actor(activation), { participantId: f.a.id, task: 'SECRET TASK TEXT', requestToken: 'task-notice' });
  await until(async () => injected === 1);
  assert.equal((await f.runtime.get('web:main')).activation?.automaticWakeups, 1);
});

test('busy Teammate messages stay queued until durable steer application', async t => {
  const execution = deferred<{ text: string }>(), applied = deferred<boolean>(); let started = false, observed: string[] = [];
  const f = await fixture(t, { executeParticipant: async () => { started = true; return execution.promise; }, deliverParticipantMessages: async input => {
    observed = input.messages.map(m => m.id);
    assert.ok(input.messages.every(m => m.stopVersion === input.activation.stopVersion));
    return applied.promise;
  } });
  const activation = await f.activate(), actor = f.actor(activation);
  await f.runtime.delegate(actor, { participantId: f.a.id, task: 'busy', requestToken: 'busy' });
  await until(async () => started);
  const message = await f.runtime.send(actor, { recipientId: f.a.id, text: 'update', requestToken: 'steer' });
  await until(async () => observed.length === 1);
  assert.equal((await f.runtime.get('web:main')).activation!.messages[0]!.status, 'queued');
  applied.resolve(true);
  await until(async () => (await f.runtime.get('web:main')).activation!.messages[0]!.status === 'delivered');
  assert.deepEqual(observed, [message.id]); execution.resolve({ text: 'done' });
});

test('idle coordination is accepted before completion and never creates a completion notice', async t => {
  const execution = deferred<{ text: string }>(); let accepted = false, noticeCount = 0;
  const f = await fixture(t, { executeParticipant: async input => { await input.acceptMessages(); accepted = true; return execution.promise; }, notifyLeader: async () => { noticeCount++; return true; } });
  const activation = await f.activate();
  await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'coordinate', requestToken: 'coordination' });
  await until(async () => accepted);
  assert.equal((await f.runtime.get('web:main')).activation!.messages[0]!.status, 'delivered');
  execution.resolve({ text: 'coordination complete, not task complete' }); await pause(40);
  assert.equal(noticeCount, 0); assert.equal((await f.runtime.get('web:main')).activation!.works.length, 0);
});

test('Abort fences pending message application and the resulting late execution output', async t => {
  const execution = deferred<{ text: string }>(), application = deferred<boolean>(); let begun = false, injecting = false;
  const f = await fixture(t, { stopTimeoutMs: 30, executeParticipant: async () => { begun = true; return execution.promise; }, deliverParticipantMessages: async () => { injecting = true; return application.promise; } });
  const activation = await f.activate(), actor = f.actor(activation);
  await f.runtime.delegate(actor, { participantId: f.a.id, task: 'active', requestToken: 'work' }); await until(async () => begun);
  await f.runtime.send(actor, { recipientId: f.a.id, text: 'late instruction', requestToken: 'message' }); await until(async () => injecting);
  const stopping = (await f.runtime.stop('web:main', { activationId: activation.id, stopVersion: 0 })).activation!;
  assert.equal(stopping.status, 'stopping');
  application.resolve(true); execution.resolve({ text: 'must not commit' });
  await until(async () => (await f.runtime.get('web:main')).activation?.status === 'stopped');
  const result = (await f.runtime.get('web:main')).activation!;
  assert.equal(result.messages[0]!.status, 'stopped'); assert.equal(result.messages[0]!.deliveredAt, undefined);
  assert.equal(result.works[0]!.result, undefined); assert.equal(result.notifications.length, 0);
});

test('pending Leader notification application never blocks the next task of the same member', async t => {
  const notice = deferred<boolean>(); const started: string[] = [];
  const f = await fixture(t, { executeParticipant: async input => { started.push(input.work!.task); return { text: 'done' }; }, notifyLeader: async () => notice.promise });
  const activation = await f.activate(), actor = f.actor(activation);
  await f.runtime.delegate(actor, { participantId: f.a.id, task: 'first', requestToken: 'first' });
  await f.runtime.delegate(actor, { participantId: f.a.id, task: 'second', requestToken: 'second' });
  await until(async () => started.length === 2);
  assert.deepEqual(started, ['first', 'second']); notice.resolve(true);
});

test('failed notification acknowledgement retries the same durable event without duplicate application', async t => {
  const applied = new Set<string>(); let attempts = 0, applications = 0;
  const f = await fixture(t, { notifyLeader: async ({ notifications }) => {
    attempts++;
    for (const notice of notifications) if (!applied.has(notice.id)) { applied.add(notice.id); applications++; }
    return { delivered: true, startedTurn: true };
  } });
  const activation = await f.activate();
  const store = (f.runtime as unknown as { store: TeamRuntimeStore }).store;
  const write = store.write.bind(store); let failed = false;
  store.write = async state => {
    if (!failed && state.activations[activation.id]?.notifications.some(notice => notice.deliveredAt)) { failed = true; throw new Error('injected acknowledgement write failure'); }
    return write(state);
  };
  await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'applied once', requestToken: 'retry-ack' });
  await until(async () => failed);
  await f.runtime.onLeaderIdle('web:main');
  await until(async () => (await f.runtime.get('web:main')).activation?.notifications.every(notice => notice.deliveredAt));
  assert.equal(applications, 1); assert.ok(attempts >= 2);
  assert.equal((await f.runtime.get('web:main')).activation?.automaticWakeups, 1);
});

test('member messages arriving during setup retry at durable input acceptance', async t => {
  const setup = deferred<void>(), execution = deferred<{ text: string }>(), releasePrevious = deferred<void>();
  let constructing = false, ready = false, attempts = 0, cleaned = false, accepted = false;
  const f = await fixture(t, {
    executeParticipant: async input => { constructing = true; await setup.promise; ready = true; await input.acceptMessages(); accepted = true; return execution.promise; },
    deliverParticipantMessages: async () => { attempts++; return ready; },
  });
  const internal = f.runtime as unknown as { deliverToParticipant: (...args: any[]) => Promise<boolean> };
  const deliver = internal.deliverToParticipant.bind(f.runtime);
  let first = true;
  internal.deliverToParticipant = async (...args) => {
    const result = await deliver(...args);
    if (first) { first = false; cleaned = true; await releasePrevious.promise; }
    return result;
  };
  const activation = await f.activate(), actor = f.actor(activation);
  await f.runtime.delegate(actor, { participantId: f.a.id, task: 'setup', requestToken: 'setup' }); await until(async () => constructing);
  await f.runtime.send(actor, { recipientId: f.a.id, text: 'while starting', requestToken: 'starting-message' }); await until(async () => cleaned);
  assert.equal((await f.runtime.get('web:main')).activation!.messages[0]!.status, 'queued');
  setup.resolve();
  await until(async () => accepted);
  releasePrevious.resolve();
  await until(async () => (await f.runtime.get('web:main')).activation!.messages[0]!.status === 'delivered');
  assert.equal(attempts, 2); execution.resolve({ text: 'done' });
});

test('new run rejects old tool retry tokens but accepts an explicit follow-up to saved work', async t => {
  const f = await fixture(t), activation = await f.activate(), oldActor = f.actor(activation);
  const oldTask = { participantId: f.a.id, task: 'old task', requestToken: 'old-token' };
  const work = await f.runtime.delegate(oldActor, oldTask);
  await until(async () => (await f.runtime.collect(oldActor, work.id)).status === 'completed');
  await f.runtime.stop('web:main', { activationId: activation.id, stopVersion: 0 });
  const stopped = (await f.runtime.get('web:main')).activation!;
  await f.runtime.onHumanTurn('web:main', activation.id, stopped.stopVersion);
  const currentActor = f.actor(stopped);
  await assert.rejects(f.runtime.delegate(currentActor, oldTask), /token belongs to an expired/);
  await assert.rejects(f.runtime.delegate(oldActor, { ...oldTask, requestToken: 'stale-new-token' }), /expired/);
  const followup = await f.runtime.delegate(currentActor, { participantId: f.a.id, followupOf: work.id, task: 'explicit follow-up', requestToken: 'new-token' });
  assert.equal(followup.stopVersion, stopped.stopVersion); assert.equal(followup.followupOf, work.id);
  await until(async () => (await f.runtime.collect(currentActor, followup.id)).status === 'completed');
});

test('failed Leader cleanup remains stopping and retry preserves the same generation', async t => {
  let attempts = 0;
  const f = await fixture(t, { stopTimeoutMs: 1000, stopLeader: async () => { if (++attempts === 1) throw new Error('cleanup failed'); } });
  const activation = await f.activate(), expected = { activationId: activation.id, stopVersion: 0 };
  const failed = (await f.runtime.stop('web:main', expected)).activation!;
  assert.equal(failed.status, 'stopping'); assert.equal(failed.cleanup?.error, 'cleanup failed');
  assert.ok(failed.cleanup?.pending.includes('leader'));
  const retry = (await f.runtime.stop('web:main', expected)).activation!;
  assert.equal(retry.status, 'stopped'); assert.equal(retry.stopVersion, 1); assert.equal(attempts, 2);
});

test('mailbox-ready hook retries pre-model delivery without waiting for message application', async t => {
  const execution = deferred<{ text: string }>(), applied = deferred<boolean>();
  let started = false, ready = false, attempts = 0;
  const f = await fixture(t, {
    executeParticipant: async () => { started = true; return execution.promise; },
    deliverParticipantMessages: async () => { attempts++; return ready ? applied.promise : false; },
  });
  const activation = await f.activate();
  await f.runtime.delegate(f.actor(activation), { participantId: f.a.id, task: 'prepare', requestToken: 'task' }); await until(async () => started);
  await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'received during setup', requestToken: 'setup-steer' });
  await until(async () => attempts === 1 && !(await f.runtime.get('web:main')).activation!.messages[0]!.owner);
  ready = true;
  await f.runtime.onExecutionReady('web:main');
  await until(async () => attempts === 2);
  assert.equal((await f.runtime.get('web:main')).activation!.messages[0]!.status, 'queued');
  applied.resolve(true); execution.resolve({ text: 'done' });
  await until(async () => (await f.runtime.get('web:main')).activation!.messages[0]!.status === 'delivered');
});

test('Leader mailbox-ready hook returns while durable application is still pending', async t => {
  const applied = deferred<boolean>(); let ready = false, attempts = 0;
  const f = await fixture(t, { notifyLeader: async () => { attempts++; return ready ? applied.promise : false; } });
  const activation = await f.activate();
  await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'early notice', requestToken: 'early' });
  await until(async () => attempts === 1 && !(await f.runtime.get('web:main')).activation!.notifications[0]!.owner);
  ready = true;
  await f.runtime.onExecutionReady('web:main');
  await until(async () => attempts === 2);
  assert.equal((await f.runtime.get('web:main')).activation!.notifications[0]!.deliveredAt, undefined);
  applied.resolve(true);
  await until(async () => !!(await f.runtime.get('web:main')).activation!.notifications[0]!.deliveredAt);
});

test('final resource cleanup starts only after participant teardown and remains retryable', async t => {
  const execution = deferred<{ text: string }>(); let started = false, exited = false, cleanups = 0;
  const f = await fixture(t, {
    stopTimeoutMs: 30,
    executeParticipant: async () => { started = true; const result = await execution.promise; exited = true; return result; },
    finishCleanup: async () => { assert.equal(exited, true); if (++cleanups === 1) throw new Error('late MCP cleanup failed'); },
  });
  const activation = await f.activate(), expected = { activationId: activation.id, stopVersion: 0 };
  await f.runtime.delegate(f.actor(activation), { participantId: f.a.id, task: 'late resource', requestToken: 'late-resource' });
  await until(async () => started);
  const stopping = (await f.runtime.stop('web:main', expected)).activation!;
  assert.equal(stopping.status, 'stopping'); assert.equal(cleanups, 0);
  execution.resolve({ text: 'cancelled output' });
  await until(async () => (await f.runtime.get('web:main')).activation?.cleanup?.error === 'late MCP cleanup failed');
  const failed = (await f.runtime.get('web:main')).activation!;
  assert.equal(failed.status, 'stopping'); assert.ok(failed.cleanup!.pending.includes('final resource cleanup'));
  await f.runtime.stop('web:main', expected);
  await until(async () => (await f.runtime.get('web:main')).activation?.status === 'stopped');
  assert.equal(cleanups, 2); assert.equal((await f.runtime.get('web:main')).activation!.stopVersion, 1);
});

test('member ready boundary survives prior delivery owner cleanup before its promise settles', async t => {
  const execution = deferred<{ text: string }>(), releasePrevious = deferred<void>();
  let started = false, ready = false, attempts = 0, cleaned = false;
  const f = await fixture(t, {
    executeParticipant: async () => { started = true; return execution.promise; },
    deliverParticipantMessages: async () => { attempts++; return ready; },
  });
  const internal = f.runtime as unknown as { deliverToParticipant: (...args: any[]) => Promise<boolean> };
  const deliver = internal.deliverToParticipant.bind(f.runtime);
  let first = true;
  internal.deliverToParticipant = async (...args) => {
    const result = await deliver(...args);
    if (first) { first = false; cleaned = true; await releasePrevious.promise; }
    return result;
  };
  const activation = await f.activate();
  await f.runtime.delegate(f.actor(activation), { participantId: f.a.id, task: 'preparing', requestToken: 'task' }); await until(async () => started);
  await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'early message', requestToken: 'early' });
  await until(async () => cleaned);
  assert.equal((await f.runtime.get('web:main')).activation!.messages[0]!.owner, undefined);
  ready = true;
  await f.runtime.onExecutionReady('web:main');
  releasePrevious.resolve();
  await until(async () => (await f.runtime.get('web:main')).activation!.messages[0]!.status === 'delivered');
  assert.equal(attempts, 2); execution.resolve({ text: 'done' });
});
