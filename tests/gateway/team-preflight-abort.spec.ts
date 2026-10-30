import assert from 'node:assert/strict';
import test from 'node:test';
import { InProcessGateway, type InProcessGatewayOptions } from '../../src/gateway/client/InProcessGateway.js';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';
import type { AgentSession } from '../../src/agent/session/AgentSession.js';
import type { AgentSteerMessage } from '../../src/agent/session/SteerMailbox.js';
import type { GatewayEvent, GatewaySubmitTurnInput } from '../../src/gateway/protocol/types.js';
import { DialogGatewayError } from '../../src/gateway/dialog/errors.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const draft: GatewaySubmitTurnInput = { sessionKey: 'leader', channelKey: 'web', message: 'start', runId: 'draft-run', teamSelection: { team: { id: 'team' }, requestToken: 'select-token' } };
function fixture(t: test.TestContext, options: InProcessGatewayOptions = {}) {
  const submitted: unknown[] = [], aborted: unknown[] = [], steers: Array<AgentSteerMessage & { turnId: string }> = [];
  let created = 0;
  const session = {
    async *submit(input: unknown) { submitted.push(input); },
    abort(reason: unknown) { aborted.push(reason); },
    steer(input: AgentSteerMessage & { turnId: string }) { steers.push(input); return { accepted: true } as const; },
    snapshot() { return { sessionId: 'leader', messages: [], usage: {}, status: 'idle', permissionDenials: [] }; },
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => { created++; return session; } });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, options);
  const consume = async (input: GatewaySubmitTurnInput) => { const events: GatewayEvent[] = []; for await (const event of gateway.submitTurn(input)) events.push(event); return events; };
  return { gateway, router, consume, submitted, aborted, steers, get created() { return created; } };
}

test('Abort of a draft Team during preflight prevents session execution and stops the identity created by preflight', async t => {
  const preparing = gate(), release = gate(), identityStopped = gate(); const stopCalls: unknown[] = [];
  const f = fixture(t, {
    prepareTurn: async input => { preparing.resolve(); await release.promise; return { input: { ...input, teamActivationId: 'activation', teamStopVersion: 7 } }; },
    abortTeam: async input => { stopCalls.push(input); identityStopped.resolve(); return true; },
  });
  t.after(release.resolve);
  const running = f.consume(draft); await preparing.promise;
  let finished = false; const stopping = f.gateway.abortTurn({ sessionKey: 'leader', runId: 'draft-run' }).then(() => { finished = true; });
  await tick(); assert.equal(finished, false); assert.equal(f.created, 0);
  release.resolve(); const events = await running; await stopping; await identityStopped.promise;
  assert.equal(f.created, 0); assert.deepEqual(f.submitted, []);
  assert.deepEqual(stopCalls, [{ sessionKey: 'leader', teamActivationId: 'activation', teamStopVersion: 7 }]);
  assert.ok(events.some(event => event.type === 'error' && event.code === 'TURN_ABORTED'));
  assert.equal(f.router.hasActiveTurn('leader'), false);
});

for (const explicitTeam of [false, true]) test(`late runId Abort does not stop a newer Team run (identity=${explicitTeam})`, async t => {
  const preparing = gate(), release = gate(), stopCalls: unknown[] = [];
  const f = fixture(t, { prepareTurn: async input => { preparing.resolve(); await release.promise; return { input }; }, abortTeam: async input => { stopCalls.push(input); return true; } });
  t.after(release.resolve);
  const running = f.consume({ ...draft, runId: 'new-run', teamSelection: undefined, teamActivationId: 'activation', teamStopVersion: 7 });
  await preparing.promise;
  await f.gateway.abortTurn({ sessionKey: 'leader', runId: 'old-run', ...(explicitTeam ? { teamActivationId: 'activation', teamStopVersion: 7 } : {}) });
  assert.deepEqual(stopCalls, []); assert.deepEqual(f.aborted, []); assert.equal(f.router.activeTurnRunId('leader'), 'new-run');
  release.resolve(); await running; assert.equal(f.submitted.length, 1);
});

test('draft Team Abort timeout reports cleanup pending and keeps the run reserved until preflight exits', async t => {
  const preparing = gate(), release = gate(), stopped = gate();
  // Runtime abort timers are unref'ed; retain a handle only for this controlled timeout.
  const alive = setInterval(() => {}, 100); t.after(() => clearInterval(alive));
  const f = fixture(t, { abortTurnTimeoutMs: 30,
    prepareTurn: async input => { preparing.resolve(); await release.promise; return { input: { ...input, teamActivationId: 'activation', teamStopVersion: 7 } }; },
    abortTeam: async () => { stopped.resolve(); return true; },
  });
  t.after(release.resolve);
  const running = f.consume(draft); await preparing.promise;
  await assert.rejects(f.gateway.abortTurn({ sessionKey: 'leader', runId: 'draft-run' }), { code: 'TEAM_STOPPING' });
  assert.equal(f.router.activeTurnRunId('leader'), 'draft-run'); assert.equal(f.created, 0);
  const blocked = await f.consume({ ...draft, runId: 'new-run' }); assert.ok(blocked.some(event => event.type === 'error' && event.code === 'session_busy'));
  release.resolve(); await running; await stopped.promise; assert.equal(f.router.hasActiveTurn('leader'), false); assert.deepEqual(f.submitted, []);
});

test('Team steer invalidated during attachment preparation is rejected before mailbox admission', async t => {
  const preparing = gate(), release = gate(); let current = true, validations = 0;
  const f = fixture(t, {
    validateTeamSteer: async () => { validations++; if (!current) throw new DialogGatewayError('TEAM_GENERATION_EXPIRED', 'Team run ended'); },
    resolveUploadedAttachments: async () => { preparing.resolve(); await release.promise; return [{ type: 'text', content: 'attachment body', name: 'notes.txt' }]; },
  });
  await f.router.getOrCreate({ sessionKey: 'leader', channelKey: 'web' }); f.router.beginTurn('leader', 'work'); t.after(() => f.router.endTurn('leader', 'work'));
  const pending = f.gateway.steerTurn({ sessionKey: 'leader', runId: 'work', itemId: 'note', message: 'update', teamActivationId: 'activation', teamStopVersion: 7, projectKey: '/workspace', uploadedAttachments: [{ uploadId: 'upload' }] });
  await preparing.promise; current = false; release.resolve();
  await assert.rejects(pending, { code: 'TEAM_GENERATION_EXPIRED' }); assert.ok(validations >= 2); assert.deepEqual(f.steers, []);
});

test('Team steer admission retains a generation fence that is checked again before durable application', async t => {
  let current = true, validations = 0;
  const f = fixture(t, { validateTeamSteer: async () => { validations++; if (!current) throw new DialogGatewayError('TEAM_GENERATION_EXPIRED', 'Team run ended'); } });
  await f.router.getOrCreate({ sessionKey: 'leader', channelKey: 'web' }); f.router.beginTurn('leader', 'work'); t.after(() => f.router.endTurn('leader', 'work'));
  assert.deepEqual(await f.gateway.steerTurn({ sessionKey: 'leader', runId: 'work', itemId: 'note', message: 'update', teamActivationId: 'activation', teamStopVersion: 7 }), { accepted: true });
  const fence = f.steers[0]!.beforeApply; assert.ok(fence); assert.equal(await fence(), true);
  current = false; assert.equal(await fence(), false); assert.ok(validations >= 3);
});

test('draft Abort does not report completed while its newly created Team is still cleaning up', async t => {
  const preparing = gate(), release = gate(), cleanupStarted = gate(), cleanupDone = gate();
  const f = fixture(t, {
    prepareTurn: async input => { preparing.resolve(); await release.promise; return { input: { ...input, teamActivationId: 'activation', teamStopVersion: 7 } }; },
    abortTeam: async () => { cleanupStarted.resolve(); await cleanupDone.promise; return true; },
  });
  t.after(() => { release.resolve(); cleanupDone.resolve(); });
  const running = f.consume(draft); await preparing.promise;
  let stopResolved = false;
  const stopping = f.gateway.abortTurn({ sessionKey: 'leader', runId: 'draft-run' }).then(() => { stopResolved = true; });
  await tick(); release.resolve(); await cleanupStarted.promise; await running; await tick();
  assert.equal(stopResolved, false, 'producer ended, but Team cleanup is still pending');
  cleanupDone.resolve(); await stopping; assert.deepEqual(f.submitted, []);
});
