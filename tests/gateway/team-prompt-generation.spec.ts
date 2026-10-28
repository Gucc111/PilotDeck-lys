import assert from 'node:assert/strict';
import test from 'node:test';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';
import type { GatewayEvent } from '../../src/gateway/protocol/types.js';

type Kind = 'permission' | 'elicitation';
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: test.TestContext, kind: Kind) {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => { throw new Error('No model should be started by an approval'); } });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router);
  const bus = kind === 'permission' ? gateway.getPermissionBus() : gateway.getElicitationBus();
  const resolved: string[] = [], rejected: Array<{ id: string; message: string }> = [], answered: string[] = [];
  const event = (id: string): GatewayEvent => kind === 'permission'
    ? { type: 'permission_request', requestId: id, toolName: 'bash', payload: {} }
    : { type: 'elicitation_request', requestId: id, toolCallId: `call-${id}`, toolName: 'ask_user_question', questions: [] };
  function register(id: string, internalSessionKey: string, isCurrent?: () => Promise<boolean>, team = true) {
    bus.register(internalSessionKey, { requestId: id, toolCallId: `call-${id}`, toolName: kind, resolve: () => { resolved.push(id); }, reject: error => { rejected.push({ id, message: error.message }); } });
    if (team) gateway.registerTeamPrompt('leader', internalSessionKey, event(id), () => { answered.push(id); }, isCurrent);
  }
  const reply = (id: string, sessionKey = 'leader') => kind === 'permission'
    ? gateway.permissionDecide({ sessionKey, requestId: id, decision: 'allow' })
    : gateway.respondElicitation({ sessionKey, requestId: id, answer: { type: 'answered', answers: {} } });
  return { gateway, bus, register, reply, resolved, rejected, answered, event };
}

for (const kind of ['permission', 'elicitation'] as const) {
  for (const internalSessionKey of ['leader', 'member-internal']) {
    test(`${kind} rejects only the expired ${internalSessionKey} request and unblocks its waiter`, async t => {
      const f = fixture(t, kind);
      f.register('old', internalSessionKey, async () => false);
      f.register('new', internalSessionKey, async () => true);
      assert.deepEqual(await f.reply('old'), { delivered: false });
      assert.deepEqual(f.rejected, [{ id: 'old', message: 'team_generation_expired' }]);
      assert.deepEqual(f.resolved, []); assert.deepEqual(f.answered, []);
      assert.equal(f.bus.hasPending(internalSessionKey, 'new'), true);
      assert.deepEqual(await f.reply('new'), { delivered: true });
      assert.deepEqual(f.resolved, ['new']); assert.deepEqual(f.answered, ['new']);
    });
  }

  test(`${kind} keeps Team UI scope and refuses the internal member key`, async t => {
    const f = fixture(t, kind); let checks = 0;
    f.register('request', 'member-internal', async () => { checks++; return true; });
    assert.deepEqual(await f.reply('request', 'other'), { delivered: false });
    assert.deepEqual(await f.reply('request', 'member-internal'), { delivered: false });
    assert.equal(checks, 0); assert.equal(f.bus.hasPending('member-internal', 'request'), true);
    assert.deepEqual(await f.reply('request'), { delivered: true }); assert.equal(checks, 1);
  });

  test(`${kind} concurrent replies consume once after generation validation`, async t => {
    const f = fixture(t, kind), release = gate();
    f.register('request', 'leader', async () => { await release.promise; return true; });
    const first = f.reply('request'), second = f.reply('request');
    assert.deepEqual(f.resolved, []); release.resolve();
    const responses = await Promise.all([first, second]);
    assert.equal(responses.filter(response => response.delivered).length, 1);
    assert.deepEqual(f.resolved, ['request']); assert.deepEqual(f.answered, ['request']);
  });

  test(`${kind} generation check failure rejects the old request without resolving approval`, async t => {
    const f = fixture(t, kind);
    f.register('request', 'leader', async () => { throw new Error('store unavailable'); });
    assert.deepEqual(await f.reply('request'), { delivered: false });
    assert.deepEqual(f.rejected, [{ id: 'request', message: 'team_generation_expired' }]);
    assert.deepEqual(f.resolved, []); assert.deepEqual(f.answered, []);
  });

  test(`${kind} an approval waiting on validation cannot consume a replacement request`, async t => {
    const f = fixture(t, kind), release = gate();
    f.register('request', 'leader', async () => { await release.promise; return true; });
    const stale = f.reply('request');
    f.gateway.clearTeamPrompts('leader');
    f.register('request', 'leader', async () => true);
    release.resolve(); assert.deepEqual(await stale, { delivered: false });
    assert.equal(f.bus.hasPending('leader', 'request'), true);
    assert.deepEqual(await f.reply('request'), { delivered: true });
    assert.deepEqual(f.resolved, ['request']); assert.deepEqual(f.answered, ['request']);
  });

  test(`${kind} ordinary prompts keep their existing scoped response behavior`, async t => {
    const f = fixture(t, kind); f.register('ordinary', 'ordinary', undefined, false);
    assert.deepEqual(await f.reply('ordinary', 'other'), { delivered: false });
    assert.deepEqual(await f.reply('ordinary', 'ordinary'), { delivered: true });
    assert.deepEqual(await f.reply('ordinary', 'ordinary'), { delivered: false });
    assert.deepEqual(f.resolved, ['ordinary']); assert.deepEqual(f.rejected, []);
  });
}

test('a missing Team waiter never invokes a ledger mutator, including through teamCommand', async t => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => { throw new Error('No model'); } });
  t.after(() => router.shutdown()); let mutations = 0;
  const gateway = new InProcessGateway(router, { teamInteractionRespond: async () => { mutations++; return { delivered: true }; } });
  const input = { sessionKey: 'web:root', activationId: 'activation', participantId: 'member', stopVersion: 0, requestId: 'missing', interactionId: 'interaction', kind: 'tool_permission' as const, decision: 'allow' as const };
  assert.deepEqual(await gateway.teamInteractionRespond(input), { delivered: false });
  await assert.rejects(gateway.teamCommand({ action: 'runtime_interaction_respond', ...input }), /no longer available/);
  assert.equal(mutations, 0);
});
