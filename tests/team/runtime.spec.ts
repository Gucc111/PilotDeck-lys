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
import type { AgentTurnResult } from '../../src/agent/protocol/result.js';
import type { AgentProfile, TeamDefinition } from '../../src/team/types.js';
import type { TeamParticipantExecution, TeamRuntimeActivation, TeamRuntimeMessage, TeamRuntimeOptions, TeamRuntimeParticipant, TeamRuntimeTurn } from '../../src/team/runtimeTypes.js';

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(fn: () => Promise<T | undefined | false>, label = 'condition'): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function profile(role: 'leader' | 'teammate', name: string): AgentProfile {
  return { id: randomUUID(), role, createdAt: '', updatedAt: '', config: { displayName: name, description: `${name} role`, systemPrompt: `${name} private persona`, model: { mode: 'model', provider: 'mock', model: 'test' }, workspace: { mode: 'team' }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default' } };
}
function result(turnId: string, finalText = 'Formal final answer', extra: Partial<AgentTurnResult> = {}): AgentTurnResult {
  return { type: 'success', sessionId: 'private', turnId, stopReason: 'completed', usage: {}, permissionDenials: [], turns: 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), finalMessage: { role: 'assistant', content: [{ type: 'text', text: finalText }] }, ...extra };
}
async function consume(runtime: TeamRuntime, input: TeamParticipantExecution, requestId = randomUUID()) {
  const actor = { sessionKey: input.activation.sessionKey, activationId: input.activation.id, participantId: input.participant.id, stopVersion: input.activation.stopVersion };
  const pending = await runtime.pendingMessages(actor, input.turnId);
  const dispatched = await runtime.dispatchMessages(actor, { turnId: input.turnId, requestId, messageIds: pending.map(message => message.id) }, accepted => Promise.resolve(accepted));
  await dispatched.value; return dispatched.messages;
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, overrides: Partial<TeamRuntimeOptions> = {}) {
  const pilotHome = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-team-runtime-'));
  const leader = profile('leader', 'Leader'), a = profile('teammate', 'A'), b = profile('teammate', 'B');
  const team: TeamDefinition = { id: randomUUID(), createdAt: '', updatedAt: '', leader, teammates: [a, b], config: { displayName: 'Review Team', description: '', instructions: 'Coordinate review', defaultProjectKey: 'project', leader: { id: leader.id }, teammates: [{ id: a.id }, { id: b.id }] } };
  const participants: TeamRuntimeParticipant[] = [leader, a, b].map(p => ({ id: p.id, role: p.role, profile: p, projectKey: 'project', projectPath: '/project', model: { mode: 'model', provider: 'mock', model: 'test' }, capabilities: p.config.capabilities }));
  const executed: TeamParticipantExecution[] = [];
  const options: TeamRuntimeOptions = { pilotHome, resolveTeam: async () => structuredClone(team), probe: async () => ({ projectKey: 'project', participants: structuredClone(participants), issues: [], environmentFingerprint: 'env1' }), isLeaderBusy: () => false, stopTimeoutMs: 1000, executeParticipant: async input => { executed.push(input); await consume(runtime, input); return { result: result(input.turnId) }; }, ...overrides };
  const runtime = new TeamRuntime(options);
  t.after(async () => { await runtime.dispose(); await rm(pilotHome, { recursive: true, force: true }); });
  const select = () => runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: { id: team.id }, requestToken: 'select-1' });
  const activate = async () => (await select()).activation!;
  const actor = (activation: TeamRuntimeActivation, participantId = leader.id): TeamRuntimeActor => ({ sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: activation.stopVersion, participantId });
  return { pilotHome, options, runtime, team, leader, a, b, participants, executed, select, activate, actor };
}
const messages = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.runtime.get('web:main')).activation!.messages;
const deletion = (activation: TeamRuntimeActivation, message: TeamRuntimeMessage) => ({ action: 'runtime_message_delete' as const, sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: message.stopVersion, participantId: message.recipientId, messageId: message.id });
const holdLeader = (f: Awaited<ReturnType<typeof fixture>>) => { f.options.isLeaderBusy = () => true; };

test('selection is idempotent, preserves its snapshot, and fences old activations', async t => {
  const f = await fixture(t), activation = await f.activate();
  assert.equal(f.executed.length, 0); assert.deepEqual(await f.select(), { activation }); f.team.config.displayName = 'Edited';
  assert.equal((await f.runtime.get('web:main')).activation?.team.config.displayName, 'Review Team');
  await assert.rejects(f.runtime.assertActivation('web:main', null), /changed Team mode/);
  await assert.rejects(f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'select-1' }), /different parameters/);
  assert.equal(await f.runtime.projectReferences('project'), true);
  await f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: null, requestToken: 'exit' });
  assert.equal((await f.runtime.get('web:main')).history?.[0]?.status, 'closed');
  await assert.rejects(f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Late', requestToken: 'late' }), /no longer current/);
});

test('compatibility warnings require the current probe and mandatory failures block selection', async t => {
  const f = await fixture(t); let fingerprint = 'v1', warning = true;
  f.options.probe = async () => ({ projectKey: 'project', participants: f.participants, environmentFingerprint: fingerprint, issues: [{ severity: warning ? 'warning' : 'error', code: 'MISSING', message: 'Search unavailable' }] });
  const old = await f.runtime.probe({ id: f.team.id }); await assert.rejects(f.select(), /confirm/); fingerprint = 'v2';
  await assert.rejects(f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: { id: f.team.id }, requestToken: 'old', probeFingerprint: old.fingerprint }), /changed/);
  const fresh = await f.runtime.probe({ id: f.team.id });
  await f.runtime.select({ action: 'runtime_select', sessionKey: 'web:main', team: { id: f.team.id }, requestToken: 'fresh', probeFingerprint: fresh.fingerprint }); warning = false;
  await assert.rejects(f.runtime.select({ action: 'runtime_select', sessionKey: 'other', team: { id: f.team.id }, requestToken: 'bad' }), /Search unavailable/);
});

test('direct communication returns after durable queueing before environment preparation ends', async t => {
  const gate = deferred(); let started: TeamParticipantExecution | undefined;
  const f = await fixture(t, { executeParticipant: async input => { started = input; await gate.promise; await consume(f.runtime, input); return { result: result(input.turnId) }; } });
  const activation = await f.activate(); holdLeader(f); const sender = f.actor(activation, f.a.id);
  const message = await f.runtime.send(sender, { recipientId: f.b.id, text: 'Which configuration?', requestToken: 'direct' });
  assert.equal(message.status, 'queued'); assert.equal(message.recipientId, f.b.id); assert.equal(message.senderId, f.a.id);
  const input = await until(async () => started); assert.equal(input.participant.id, f.b.id); assert.equal((await messages(f))[0]?.status, 'preparing');
  assert.equal((await f.runtime.send(sender, { recipientId: f.b.id, text: 'Which configuration?', requestToken: 'direct' })).id, message.id);
  await assert.rejects(f.runtime.send(sender, { recipientId: f.b.id, text: 'Changed', requestToken: 'direct' }), /different parameters/);
  assert.equal((await f.runtime.get('web:main')).activation!.works.length, 0); gate.resolve();
  await until(async () => (await messages(f))[0]?.status === 'consumed');
});

test('busy members consume the whole boundary batch in one turn while different members run in parallel', async t => {
  const gates = new Map<string, { promise: Promise<void>; resolve: (value: void) => void }>(), started: TeamParticipantExecution[] = [], batches: string[][] = [];
  const f = await fixture(t, { executeParticipant: async input => { started.push(input); const gate = deferred(); gates.set(input.participant.id, gate); await gate.promise; batches.push((await consume(f.runtime, input)).map(message => message.text)); return { result: result(input.turnId) }; } });
  const activation = await f.activate(); holdLeader(f); const actor = f.actor(activation);
  await f.runtime.send(actor, { recipientId: f.a.id, text: 'A1', requestToken: 'a1' }); await f.runtime.send(actor, { recipientId: f.b.id, text: 'B1', requestToken: 'b1' });
  await until(async () => started.length === 2);
  await f.runtime.send(actor, { recipientId: f.a.id, text: 'A2', requestToken: 'a2' }); await f.runtime.send(actor, { recipientId: f.a.id, text: 'A3', requestToken: 'a3' });
  await pause(20); assert.equal(started.length, 2); gates.get(f.a.id)!.resolve(); gates.get(f.b.id)!.resolve();
  await until(async () => batches.length === 2); assert.ok(batches.some(batch => JSON.stringify(batch) === JSON.stringify(['A1', 'A2', 'A3'])));
  await until(async () => (await f.runtime.get('web:main')).activation!.turns!.every(turn => turn.status === 'ended'));
  assert.equal(started.filter(input => input.participant.id === f.a.id).length, 1);
});

test('Leader human input and internal input share the execution guard', async t => {
  const f = await fixture(t), activation = await f.activate(), actor = f.actor(activation); holdLeader(f);
  await f.runtime.beginTurn(actor, { turnId: 'human', trigger: 'human' }); await assert.rejects(f.runtime.beginTurn(actor, { turnId: 'overlap', trigger: 'messages' }), /already has an active/);
  const msg = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Need requirements', requestToken: 'question' });
  assert.deepEqual((await f.runtime.pendingMessages(actor)).map(item => item.id), [msg.id]);
  await f.runtime.dispatchMessages(actor, { turnId: 'human', requestId: 'human-request', messageIds: [msg.id] }, accepted => accepted);
  assert.equal(f.executed.length, 0); await f.runtime.endTurn(actor, 'human', result('human')); assert.equal((await messages(f))[0]?.turnId, 'human');
});

test('human input waits for a losing auto preparation claim before starting its turn', async t => {
  const autoStarted = deferred(), releaseAuto = deferred(); let routerBusy = false;
  const f = await fixture(t, { isLeaderBusy: () => routerBusy, executeParticipant: async () => { autoStarted.resolve(); await releaseAuto.promise; assert.equal(routerBusy, true); return { retry: true }; } });
  const activation = await f.activate(), actor = f.actor(activation);
  const message = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Concurrent notice', requestToken: 'race' });
  await autoStarted.promise; routerBusy = true;
  let humanStarted = false; const human = f.runtime.beginTurn(actor, { turnId: 'human-winner', trigger: 'human' }).then(turn => { humanStarted = true; return turn; });
  await pause(20); assert.equal(humanStarted, false); releaseAuto.resolve();
  assert.equal((await human).turnId, 'human-winner');
  const turnRecords = (await f.runtime.get('web:main')).activation!.turns!;
  assert.equal(turnRecords.filter(turn => turn.status === 'preparing').length, 1); assert.equal(turnRecords[0]?.stopReason, 'execution_busy');
  assert.deepEqual((await f.runtime.pendingMessages(actor)).map(item => item.id), [message.id]);
});

test('idle Leader wakes on member messages and notices without a cumulative automatic turn limit', async t => {
  const f = await fixture(t), activation = await f.activate();
  for (let i = 0; i < 3; i++) {
    await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: `Question ${i}`, requestToken: `q${i}` });
    await until(async () => f.executed.filter(input => input.participant.role === 'leader').length === i + 1);
    await until(async () => (await f.runtime.get('web:main')).activation!.turns!.filter(turn => turn.participantId === f.leader.id).every(turn => turn.status === 'ended'));
  }
  await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Review', requestToken: 'review' });
  await until(async () => f.executed.filter(input => input.participant.role === 'leader').length === 4); assert.equal((await f.runtime.get('web:main')).activation!.automaticWakeups, 0);
});

test('only dispatch consumes and retries retain exact message identities and body', async t => {
  const f = await fixture(t), activation = await f.activate(), actor = f.actor(activation); holdLeader(f); await f.runtime.beginTurn(actor, { turnId: 'manual', trigger: 'human' });
  const message = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Body evidence', requestToken: 'body' }); assert.equal((await messages(f))[0]?.consumedAt, undefined);
  const bodies: string[][] = [];
  for (let i = 0; i < 2; i++) await f.runtime.dispatchMessages(actor, { turnId: 'manual', requestId: 'request', messageIds: [message.id] }, accepted => { bodies.push(accepted.map(item => item.text)); return Promise.resolve('network'); });
  const current = (await f.runtime.get('web:main')).activation!;
  assert.deepEqual(bodies, [['Body evidence'], ['Body evidence']]); assert.equal(current.dispatches!.length, 2); assert.notEqual(current.dispatches![0]!.attemptId, current.dispatches![1]!.attemptId); assert.equal(current.turns![0]!.attemptIds!.length, 2); assert.equal(current.messages[0]?.status, 'consumed'); assert.deepEqual(current.turns![0]?.requestIds, ['request']);
  await assert.rejects(f.runtime.deleteMessage(deletion(activation, message)), /already been sent/);
});

test('deletion filters final dispatch, creates one feedback and hides the tombstone', async t => {
  const f = await fixture(t), activation = await f.activate(), actor = f.actor(activation); holdLeader(f);
  await f.runtime.beginTurn(actor, { turnId: 'delete-race', trigger: 'human' }); await f.runtime.beginTurn(f.actor(activation, f.a.id), { turnId: 'sender-busy', trigger: 'human' });
  const original = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Withdraw this', requestToken: 'withdraw' });
  const keep = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Keep this', requestToken: 'keep' });
  await f.runtime.deleteMessage(deletion(activation, original)); await f.runtime.deleteMessage(deletion(activation, original));
  let body: string[] = []; await f.runtime.dispatchMessages(actor, { turnId: 'delete-race', requestId: 'after-delete', messageIds: [original.id, keep.id] }, accepted => { body = accepted.map(item => item.text); }); assert.deepEqual(body, ['Keep this']);
  const feedback = (await messages(f)).filter(item => item.kind === 'message_deleted'); assert.equal(feedback.length, 1); assert.equal(feedback[0]?.recipientId, f.a.id); assert.match(feedback[0]!.text, /用户删除了/);
  await assert.rejects(f.runtime.deleteMessage(deletion(activation, feedback[0]!)), /System notifications/);
  const page = await f.runtime.execute({ action: 'runtime_get', sessionKey: 'web:main' }) as { activation: TeamRuntimeActivation }; assert.ok(!page.activation.messages.some(item => item.id === original.id));
  await assert.rejects(f.runtime.deleteMessage({ ...deletion(activation, original), participantId: f.b.id }), /not available/);
});

test('deletion cannot recall after transport start and never waits for its response', async t => {
  const f = await fixture(t), activation = await f.activate(), actor = f.actor(activation), response = deferred(); holdLeader(f);
  await f.runtime.beginTurn(actor, { turnId: 'transport', trigger: 'human' });
  const message = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Sent', requestToken: 'sent' });
  const send = await f.runtime.dispatchMessages(actor, { turnId: 'transport', requestId: 'transport-request', messageIds: [message.id] }, () => response.promise);
  await assert.rejects(f.runtime.deleteMessage(deletion(activation, message)), /already been sent/); response.resolve(); await send.value;
});

test('withdrawing the entire initial batch cancels empty execution without notifying Leader', async t => {
  const gate = deferred(); let started: TeamParticipantExecution | undefined, transport = false;
  const f = await fixture(t, { executeParticipant: async input => { started = input; await gate.promise; try { await f.runtime.dispatchMessages(f.actor(input.activation, input.participant.id), { turnId: input.turnId, requestId: 'empty', messageIds: input.messages!.map(item => item.id) }, () => { transport = true; }); } catch (error) { assert.equal((error as { code: string }).code, 'TEAM_EMPTY_BATCH'); } return { result: result(input.turnId) }; } });
  const activation = await f.activate(); holdLeader(f); const message = await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Remove', requestToken: 'remove-all' });
  await until(async () => started); await f.runtime.deleteMessage(deletion(activation, message)); gate.resolve();
  await until(async () => (await f.runtime.get('web:main')).activation!.turns![0]?.status === 'ended'); assert.equal(transport, false); assert.equal((await messages(f)).filter(item => item.kind === 'turn_ended').length, 0);
});

test('withdrawing an initial batch retains human input already joined to the same execution', async t => {
  const gate = deferred(); let started: TeamParticipantExecution | undefined, transport = false;
  const f = await fixture(t, { executeParticipant: async input => {
    started = input; await gate.promise;
    await f.runtime.dispatchMessages(f.actor(input.activation, input.participant.id), { turnId: input.turnId, requestId: 'human-after-withdrawal', messageIds: input.messages!.map(item => item.id), hasHumanInput: true }, accepted => { assert.deepEqual(accepted, []); transport = true; });
    return { result: result(input.turnId) };
  } });
  const activation = await f.activate(); holdLeader(f);
  const message = await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Remove before human input', requestToken: 'remove-before-human' });
  await until(async () => started); await f.runtime.deleteMessage(deletion(activation, message)); gate.resolve();
  const turn = await until(async () => (await f.runtime.get('web:main')).activation!.turns!.find(item => item.status === 'ended'));
  assert.equal(transport, true); assert.deepEqual(turn.requestIds, ['human-after-withdrawal']); assert.deepEqual(turn.messageIds, []);
  assert.equal((await messages(f)).filter(item => item.kind === 'turn_ended').length, 1);
});

test('capacity errors retain full pending input and retry only when the queue changes', async t => {
  let calls = 0;
  const f = await fixture(t, { executeParticipant: async input => { calls++; return { result: result(input.turnId, '', { type: 'error', stopReason: 'prompt_too_long', finalMessage: undefined, errors: [{ code: 'TEAM_MESSAGE_BATCH_TOO_LARGE', message: 'Full batch does not fit' }] }) }; } });
  const activation = await f.activate(); holdLeader(f); const first = await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Large body', requestToken: 'large' });
  await until(async () => (await messages(f)).find(item => item.id === first.id)?.error === 'Full batch does not fit'); await pause(40); assert.equal(calls, 1); assert.equal((await messages(f))[0]!.text, 'Large body');
  await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Queue changed', requestToken: 'change' }); await until(async () => calls === 2); await pause(40); assert.equal(calls, 2);
});

test('deleting after capacity evaluation cannot block the changed queue with an outdated error', async t => {
  const failedBoundary = deferred(), releaseFailure = deferred(); let calls = 0;
  const f = await fixture(t, { executeParticipant: async input => {
    calls++;
    if (calls === 1) {
      const actor = f.actor(input.activation, input.participant.id), pending = await f.runtime.pendingMessages(actor, input.turnId);
      try { await f.runtime.dispatchMessages(actor, { turnId: input.turnId, requestId: 'too-large', messageIds: pending.map(message => message.id) }, () => { throw Object.assign(new Error('Batch too large'), { code: 'TEAM_MESSAGE_BATCH_TOO_LARGE' }); }); } catch {}
      failedBoundary.resolve(); await releaseFailure.promise;
      return { result: result(input.turnId, '', { type: 'error', finalMessage: undefined, stopReason: 'prompt_too_long', errors: [{ code: 'TEAM_MESSAGE_BATCH_TOO_LARGE', message: 'Old batch did not fit' }] }) };
    }
    await consume(f.runtime, input); return { result: result(input.turnId) };
  } });
  const activation = await f.activate(); holdLeader(f);
  const first = await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Large', requestToken: 'large-race' });
  await failedBoundary.promise;
  const keep = await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Smaller', requestToken: 'smaller-race' });
  await f.runtime.deleteMessage(deletion(activation, first)); releaseFailure.resolve();
  await until(async () => (await messages(f)).find(message => message.id === keep.id)?.status === 'consumed'); assert.equal(calls, 2);
});

test('pre-transport errors restore pending but unknown send failures become uncertain', async t => {
  const f = await fixture(t), activation = await f.activate(), actor = f.actor(activation); holdLeader(f); await f.runtime.beginTurn(actor, { turnId: 'errors', trigger: 'human' });
  const message = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Pending', requestToken: 'pending' });
  await assert.rejects(f.runtime.dispatchMessages(actor, { turnId: 'errors', requestId: 'capacity', messageIds: [message.id] }, () => { throw Object.assign(new Error('too large'), { code: 'TEAM_MESSAGE_BATCH_TOO_LARGE' }); }), /too large/); assert.equal((await messages(f))[0]?.status, 'queued');
  await assert.rejects(f.runtime.dispatchMessages(actor, { turnId: 'errors', requestId: 'uncertain', messageIds: [message.id] }, () => { throw new Error('transport boundary failed'); }), /boundary failed/); assert.equal((await messages(f))[0]?.status, 'uncertain');
  await assert.rejects(f.runtime.dispatchMessages(actor, { turnId: 'errors', requestId: 'uncertain', messageIds: [message.id] }, () => {}), /cannot be replayed/); await assert.rejects(f.runtime.deleteMessage(deletion(activation, message)), /cannot be deleted/);
});

test('inspect views protect final outputs and teammate communication is restricted to its own messages', async t => {
  const f = await fixture(t), activation = await f.activate(), leader = f.actor(activation), a = f.actor(activation, f.a.id), b = f.actor(activation, f.b.id); holdLeader(f);
  await f.runtime.send(leader, { recipientId: f.a.id, text: 'Review', requestToken: 'review' });
  const turn = await until(async () => (await f.runtime.get('web:main')).activation!.turns!.find(item => item.participantId === f.a.id && item.status === 'ended'));
  const overview = await f.runtime.inspect(a); assert.equal(JSON.stringify(overview).includes('private persona'), false); assert.equal(JSON.stringify(overview).includes('Formal final'), false);
  assert.equal(JSON.stringify(await f.runtime.inspect(a, { view: 'turns', participantId: f.a.id })).includes('Formal final'), false);
  const output = await f.runtime.inspect(leader, { view: 'turn', participantId: f.a.id, turnId: turn.turnId }); assert.equal(output.finalResultAvailable, true); assert.match(JSON.stringify(output), /Formal final/);
  await assert.rejects(f.runtime.inspect(leader, { view: 'turn' }), /participantId/); await assert.rejects(f.runtime.inspect(leader, { view: 'turn', participantId: f.a.id }), /turnId/);
  await assert.rejects(f.runtime.inspect(a, { view: 'turn', participantId: f.a.id, turnId: turn.turnId }), /Only the Leader/); await assert.rejects(f.runtime.inspect(b, { view: 'turns', participantId: f.a.id }), /only its own/);
  assert.deepEqual((await f.runtime.inspect(b, { view: 'messages' })).items, []); assert.equal(((await f.runtime.inspect(leader, { view: 'messages' })).items as unknown[]).length, 2);
});

test('model inspection exposes message bodies only after dispatch while the UI retains full inbox records', async t => {
  const f = await fixture(t), activation = await f.activate(); holdLeader(f);
  const recipient = f.actor(activation, f.a.id), leader = f.actor(activation);
  await f.runtime.beginTurn(recipient, { turnId: 'recipient-busy', trigger: 'human' });
  await f.runtime.beginTurn(f.actor(activation, f.b.id), { turnId: 'sender-busy', trigger: 'human' });
  const statuses: TeamRuntimeMessage['status'][] = ['queued', 'preparing', 'sending', 'invalidated', 'uncertain', 'legacy_unknown', 'delivered', 'interrupted', 'stopped', 'deleted', 'consumed'];
  const records = statuses.map((status): TeamRuntimeMessage => ({ id: `body-${status}`, stopVersion: activation.stopVersion, senderId: f.b.id, recipientId: f.a.id, intendedRecipientId: f.a.id, status, kind: 'member', text: `secret-body-${status}`, error: `secret-error-${status}`, createdAt: '' }));
  const store = new TeamRuntimeStore(f.pilotHome);
  await store.locked(async () => { const state = await store.read(); state.activations[activation.id]!.messages.push(...records); await store.write(state); });
  const context = { sessionId: 'web:main', turnId: 'inspect-turn', cwd: '/project', permissionMode: 'default' as const, permissionContext: createDefaultPermissionContext({ cwd: '/project', canPrompt: false }) };
  for (const [actor, role] of [[recipient, 'teammate'], [leader, 'leader']] as const) {
    const inspected = await createTeamRuntimeTools(f.runtime, actor, role)[1]!.execute({ view: 'messages' }, context) as { data: { items: Array<Record<string, unknown>> } };
    assert.equal(inspected.data.items.length, records.length - 1);
    for (const item of inspected.data.items) {
      assert.equal(item.bodyAvailable, item.status === 'consumed'); assert.equal('error' in item, false);
      if (item.status === 'consumed') assert.equal(item.text, 'secret-body-consumed');
      else { assert.equal('text' in item, false); assert.match(String(item.bodyUnavailableReason), /actual model dispatch/); }
    }
    const serialized = JSON.stringify(inspected);
    for (const status of statuses.filter(status => status !== 'consumed')) assert.ok(!serialized.includes(`secret-body-${status}`));
    assert.ok(!serialized.includes('secret-error-'));
  }
  const ui = await f.runtime.execute({ action: 'runtime_get', sessionKey: 'web:main' }) as { activation: TeamRuntimeActivation };
  for (const item of records.filter(item => item.status !== 'deleted')) assert.equal(ui.activation.messages.find(message => message.id === item.id)?.text, item.text);
  await f.runtime.dispatchMessages(recipient, { turnId: 'recipient-busy', requestId: 'consume-body', messageIds: ['body-queued'] }, accepted => { assert.equal(accepted[0]?.text, 'secret-body-queued'); });
  const consumed = (await f.runtime.inspect(leader, { view: 'messages', participantId: f.a.id })).items as Array<Record<string, unknown>>;
  assert.equal(consumed.find(item => item.id === 'body-queued')?.text, 'secret-body-queued');
  await f.runtime.deleteMessage(deletion(activation, records.find(item => item.status === 'preparing')!));
  assert.ok(!JSON.stringify(await f.runtime.inspect(recipient, { view: 'messages' })).includes('body-preparing'));
});

test('formal results precede one fixed notice and max-step endings preserve their real reason', async t => {
  const f = await fixture(t, { executeParticipant: async input => { await consume(f.runtime, input); return { text: 'not the formal result', result: result(input.turnId, 'Saved result', { type: 'max_turns', stopReason: 'max_turns' }) }; } });
  const activation = await f.activate(); holdLeader(f); await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Review', requestToken: 'review' });
  const notice = await until(async () => (await messages(f)).find(item => item.kind === 'turn_ended'));
  const disk = (await new TeamRuntimeStore(f.pilotHome).read()).activations[activation.id]!, turn = disk.turns![0]!;
  assert.equal(turn.resultType, 'max_turns'); assert.equal(turn.stopReason, 'max_turns'); assert.match(JSON.stringify(turn.finalMessage), /Saved result/);
  assert.match(notice.text, /team_inspect/); assert.ok(!notice.text.includes('Saved result')); assert.ok(!notice.text.includes('工作已经完成'));
  await f.runtime.endTurn(f.actor(activation, f.a.id), turn.turnId, result(turn.turnId)); assert.equal((await messages(f)).filter(item => item.kind === 'turn_ended').length, 1);
});

test('preparation failure saves a real failure and notifies Leader without pretending a request was sent', async t => {
  const f = await fixture(t, { executeParticipant: async () => { throw new Error('MCP setup failed'); } }), activation = await f.activate(); holdLeader(f);
  await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Review after setup', requestToken: 'setup' });
  const notice = await until(async () => (await messages(f)).find(item => item.kind === 'turn_ended'));
  const turn = (await f.runtime.get('web:main')).activation!.turns![0]!; assert.deepEqual(turn.requestIds, []); assert.equal(turn.resultType, 'error'); assert.match(turn.error!, /MCP setup/); assert.match(notice.text, /model_error/);
});

test('Abort invalidates pending input; new human input cannot resurrect it or old retry tokens', async t => {
  const f = await fixture(t), activation = await f.activate(), actor = f.actor(activation); holdLeader(f);
  const message = await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Old pending', requestToken: 'old' });
  const stopped = (await f.runtime.stop('web:main', { activationId: activation.id, stopVersion: 0 })).activation!; assert.equal(stopped.messages[0]?.status, 'invalidated'); assert.equal(stopped.stopVersion, 1);
  await f.runtime.onHumanTurn('web:main', activation.id, 1); assert.deepEqual(await f.runtime.pendingMessages(f.actor(stopped)), []);
  await assert.rejects(f.runtime.send(actor, { recipientId: f.a.id, text: 'stale actor', requestToken: 'stale' }), /expired/);
  await assert.rejects(f.runtime.send(f.actor(stopped, f.a.id), { recipientId: f.leader.id, text: 'Old pending', requestToken: 'old' }), /expired/);
  await f.runtime.deleteMessage(deletion(activation, message)); assert.equal((await messages(f)).filter(item => item.kind === 'message_deleted').length, 0); assert.equal(f.executed.length, 0);
});

test('stopped configuration refresh happens before human acceptance without reactivating messages', async t => {
  let refreshes = 0;
  const f = await fixture(t, { refreshActivation: async activation => { refreshes++; return { team: { ...activation.team, config: { ...activation.team.config, displayName: 'Latest team' } }, participants: activation.participants.map(participant => ({ ...participant, model: { mode: 'model', provider: 'mock', model: 'latest' } })), probeFingerprint: 'latest' }; } });
  const activation = await f.activate(); holdLeader(f); await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Old queued', requestToken: 'old-refresh' });
  await f.runtime.stop('web:main', { activationId: activation.id, stopVersion: 0 });
  const refreshed = await f.runtime.refreshStoppedActivation('web:main', activation.id, 1);
  assert.equal(refreshed.status, 'stopped'); assert.equal(refreshed.team.config.displayName, 'Latest team'); assert.equal(refreshed.participants[0]!.model.model, 'latest'); assert.equal(refreshed.messages[0]!.status, 'invalidated');
  await f.runtime.onHumanTurn('web:main', activation.id, 1); assert.equal(refreshes, 1); assert.deepEqual(await f.runtime.pendingMessages(f.actor(refreshed)), []);
});

test('active configuration stays frozen until the next human run boundary', async t => {
  let refreshes = 0;
  const f = await fixture(t, { refreshActivation: async activation => {
    refreshes++;
    return { team: { ...activation.team, config: { ...activation.team.config, displayName: 'Latest team' } }, participants: activation.participants.map(participant => ({ ...participant, model: { mode: 'model', provider: 'mock', model: 'latest' } })), probeFingerprint: 'latest' };
  } });
  const activation = await f.activate();
  await f.runtime.onLeaderIdle('web:main');
  assert.equal(refreshes, 0);
  assert.equal((await f.runtime.get('web:main')).activation!.team.config.displayName, 'Review Team');
  const prepared = await f.runtime.prepareHumanTurn('web:main', activation.id, activation.stopVersion);
  assert.equal(refreshes, 1);
  assert.equal(prepared.refreshed, true);
  assert.equal(prepared.activation.team.config.displayName, 'Latest team');
  assert.equal(prepared.activation.participants[0]!.model.model, 'latest');
});

test('a busy active run keeps the old snapshot and does not resolve deleted or changed configuration', async t => {
  let refreshes = 0;
  const f = await fixture(t, { refreshActivation: async activation => {
    refreshes++;
    return { team: { ...activation.team, config: { ...activation.team.config, displayName: 'Should not apply yet' } }, participants: activation.participants, probeFingerprint: 'changed' };
  } });
  const activation = await f.activate();
  holdLeader(f);
  const prepared = await f.runtime.prepareHumanTurn('web:main', activation.id, activation.stopVersion);
  assert.equal(refreshes, 0);
  assert.equal(prepared.refreshed, false);
  assert.equal(prepared.activation.team.config.displayName, 'Review Team');
});

test('Abort while preparing records interruption and cannot emit a late completion notice', async t => {
  let started = false;
  const f = await fixture(t, { executeParticipant: input => new Promise(resolve => { started = true; input.signal.addEventListener('abort', () => resolve({ result: result(input.turnId) }), { once: true }); }) });
  const activation = await f.activate(); holdLeader(f); await f.runtime.send(f.actor(activation), { recipientId: f.a.id, text: 'Stop while preparing', requestToken: 'stop' }); await until(async () => started);
  const stopped = (await f.runtime.stop('web:main', { activationId: activation.id, stopVersion: 0 })).activation!;
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.turns![0]?.status, 'stopped'); assert.equal(stopped.messages[0]?.status, 'invalidated'); assert.equal(stopped.messages.filter(item => item.kind === 'turn_ended').length, 0);
});

test('restart invalidates unsent input, preserves uncertain sends, and never replays old records', async t => {
  const f = await fixture(t), activation = await f.activate(), store = new TeamRuntimeStore(f.pilotHome); holdLeader(f);
  await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: 'Pending at restart', requestToken: 'restart' }); await f.runtime.dispose();
  const state = await store.read(); state.activations[activation.id]!.messages.push({ id: randomUUID(), stopVersion: 0, senderId: f.a.id, recipientId: f.leader.id, intendedRecipientId: f.leader.id, text: 'Uncertain at crash', status: 'sending', createdAt: '' }); await store.write(state);
  let executions = 0; const restarted = new TeamRuntime({ ...f.options, executeParticipant: async input => { executions++; return { result: result(input.turnId) }; } }); t.after(() => restarted.dispose());
  const recovered = (await restarted.get('web:main')).activation!; assert.equal(recovered.stopReason, 'restart'); assert.equal(recovered.stopVersion, 1); assert.deepEqual(recovered.messages.map(item => item.status), ['invalidated', 'uncertain']);
  await restarted.onHumanTurn('web:main', activation.id, 1); await restarted.onExecutionReady('web:main'); await pause(30); assert.equal(executions, 0);
});

test('legacy migration retains history, restores proven turns and never treats delivered as sent', async t => {
  const f = await fixture(t), activation = await f.activate(), store = new TeamRuntimeStore(f.pilotHome); await f.runtime.dispose(); const state = await store.read(); state.version = 2;
  const old = state.activations[activation.id]!; delete old.turns; delete old.dispatches; delete old.runtimeOwner;
  old.works.push({ id: 'old-task', participantId: f.a.id, stopVersion: 0, task: 'Old task', status: 'completed', result: 'Historic work', createdAt: '' });
  for (const status of ['queued', 'delivered'] as const) old.messages.push({ id: randomUUID(), stopVersion: 0, senderId: f.a.id, recipientId: f.leader.id, intendedRecipientId: f.leader.id, text: status, status, createdAt: '' }); await store.write(state);
  const recoveredTurn: TeamRuntimeTurn = { turnId: 'proven-turn', participantId: f.a.id, stopVersion: 0, trigger: 'messages', status: 'ended', startedAt: '', endedAt: '', messageIds: [], requestIds: [], finalMessage: result('proven-turn', 'Transcript final').finalMessage, resultType: 'success', stopReason: 'completed' };
  const restarted = new TeamRuntime({ ...f.options, readLegacyTurns: async () => [recoveredTurn] }); t.after(() => restarted.dispose());
  const migrated = (await restarted.get('web:main')).activation!; assert.equal((await store.read()).version, 3); assert.deepEqual(migrated.messages.map(item => item.status), ['invalidated', 'legacy_unknown']); assert.equal(migrated.works[0]?.result, 'Historic work');
  assert.match(JSON.stringify(await restarted.inspect(f.actor(migrated), { view: 'turn', participantId: f.a.id, turnId: 'proven-turn' })), /Transcript final/);
});

test('only send and inspect are visible, descriptions differ by role and identities are server-owned', async t => {
  const f = await fixture(t), activation = await f.activate(), actor = f.actor(activation, f.a.id); holdLeader(f);
  const tools = createTeamRuntimeTools(f.runtime, actor, 'teammate'), leaderTools = createTeamRuntimeTools(f.runtime, f.actor(activation), 'leader');
  assert.deepEqual(tools.map(tool => tool.name), ['team_send_message', 'team_inspect']); assert.match(tools[0]!.description!, /Do not put final work results/); assert.match(leaderTools[0]!.description!, /instructions/); assert.match(tools[1]!.description!, /Message bodies are available only after actual model dispatch/);
  const send = tools[0]!, context = { sessionId: 'web:main', turnId: 'tool-turn', cwd: '/project', permissionMode: 'default' as const, currentToolCallId: 'call-1', permissionContext: createDefaultPermissionContext({ cwd: '/project', canPrompt: false }) };
  for (const field of ['senderId', 'requestToken', 'replyTo', 'workId']) await assert.rejects(send.execute({ recipientId: f.leader.id, text: 'Question', [field]: 'spoof' }, context), /unsupported field/);
  const sent = await send.execute({ recipientId: f.leader.id, text: 'Question' }, context) as { data: unknown }; assert.deepEqual(Object.keys(sent.data as object).sort(), ['messageId', 'recipientId', 'status']);
  await assert.rejects(f.runtime.send(actor, { recipientId: actor.participantId, text: 'self', requestToken: 'self' }), /another participant/);
  const permissions = new PermissionRuntime(); context.permissionContext.mode = 'plan'; assert.equal((await permissions.decide(send, {}, context, 'call')).type, 'deny'); assert.equal((await permissions.decide(tools[1]!, {}, context, 'call')).type, 'allow');
  context.permissionContext.mode = 'default'; context.permissionContext.rules.deny.push({ source: 'project', behavior: 'deny', toolName: 'team_send_message' }); assert.equal((await permissions.decide(send, {}, context, 'call')).type, 'deny');
});

test('runtime and inspect message lists paginate and reject invalid cursors', async t => {
  const f = await fixture(t), activation = await f.activate(); holdLeader(f);
  for (let i = 0; i < 3; i++) await f.runtime.send(f.actor(activation, f.a.id), { recipientId: f.leader.id, text: `Message ${i}`, requestToken: `page-${i}` });
  const first = await f.runtime.execute({ action: 'runtime_get', sessionKey: 'web:main', limit: 2 }) as { activation: TeamRuntimeActivation; messagesNextCursor?: string }; assert.equal(first.activation.messages.length, 2); assert.equal(first.messagesNextCursor, '2');
  const second = await f.runtime.execute({ action: 'runtime_get', sessionKey: 'web:main', limit: 2, messageCursor: first.messagesNextCursor }) as { activation: TeamRuntimeActivation }; assert.equal(second.activation.messages.length, 1); assert.equal(second.activation.messages[0]?.text, 'Message 2');
  assert.equal((await f.runtime.inspect(f.actor(activation), { view: 'messages', limit: 1 })).nextCursor, '1');
  await f.runtime.beginTurn(f.actor(activation, f.a.id), { turnId: 'hold-delete-feedback', trigger: 'human' });
  await f.runtime.deleteMessage(deletion(activation, first.activation.messages[0]!));
  const afterDelete = await f.runtime.execute({ action: 'runtime_get', sessionKey: 'web:main', limit: 2, messageCursor: first.messagesNextCursor }) as { activation: TeamRuntimeActivation };
  assert.equal(afterDelete.activation.messages[0]?.text, 'Message 2');
  await assert.rejects(f.runtime.execute({ action: 'runtime_get', sessionKey: 'web:main', messageCursor: '-1' }), /cursor is invalid/);
});

test('human interaction responses remain owner-scoped, durable and idempotent across a write failure', async t => {
  const f = await fixture(t), activation = await f.activate();
  const interaction = await f.runtime.createInteraction({ sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: 0, participantId: f.a.id, requestId: 'permission', kind: 'tool_permission', request: { toolName: 'write_file' } });
  const input = { action: 'runtime_interaction_respond' as const, sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: 0, participantId: f.a.id, interactionId: interaction.id, requestId: interaction.requestId, kind: 'tool_permission' as const, decision: 'allow' as const };
  await assert.rejects(f.runtime.respondInteraction({ ...input, participantId: f.b.id }, () => true), /no longer available/);
  const store = (f.runtime as unknown as { store: TeamRuntimeStore }).store, write = store.write.bind(store); let failed = false, consumed = 0;
  store.write = async state => { if (!failed) { failed = true; throw new Error('simulated disk failure'); } await write(state); };
  await assert.rejects(f.runtime.respondInteraction(input, () => { consumed++; return true; }), /disk failure/);
  const replay = await f.runtime.respondInteraction(input, () => { consumed++; return true; }); assert.equal(replay.delivered, false); assert.equal(replay.interaction.status, 'allowed'); assert.equal(consumed, 1);
  const pending = await f.runtime.createInteraction({ sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: 0, participantId: f.a.id, requestId: 'plan', kind: 'plan_approval', request: { plan: 'Review' } }); await f.runtime.stop('web:main', { activationId: activation.id, stopVersion: 0 });
  assert.equal((await f.runtime.get('web:main')).activation!.interactions.find(item => item.id === pending.id)?.status, 'cancelled');
});

test('failed cleanup remains stopping; retries preserve the original stop generation', async t => {
  let attempts = 0; const f = await fixture(t, { stopLeader: async () => { if (++attempts === 1) throw new Error('cleanup failed'); } }), activation = await f.activate(), expected = { activationId: activation.id, stopVersion: 0 };
  const failed = (await f.runtime.stop('web:main', expected)).activation!; assert.equal(failed.status, 'stopping'); assert.equal(failed.cleanup?.error, 'cleanup failed');
  const retry = (await f.runtime.stop('web:main', expected)).activation!; assert.equal(retry.status, 'stopped'); assert.equal(retry.stopVersion, 1); assert.equal(attempts, 2);
});
