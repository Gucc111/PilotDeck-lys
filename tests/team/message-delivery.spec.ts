import assert from 'node:assert/strict';
import test from 'node:test';
import { TeamMessageDelivery } from '../../src/team/TeamMessageDelivery.js';
import type { CanonicalMessage } from '../../src/model/index.js';
import type { AgentEvent } from '../../src/agent/protocol/events.js';

const message: CanonicalMessage = { role: 'user', content: [{ type: 'text', text: 'Member needs clarification' }], metadata: { synthetic: true, purpose: 'team_runtime' } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(delivery = new TeamMessageDelivery(), turnId = 'turn-1') {
  const controller = new AbortController();
  let current = true, durable = false, enqueues = 0, cancels = 0, fence: (() => Promise<boolean>) | undefined;
  const input = {
    sessionKey: 'leader', turnId, itemId: 'event-1', message, signal: controller.signal,
    isCurrent: async () => current,
    wasApplied: async () => durable,
    enqueue: (beforeApply: () => Promise<boolean>) => { enqueues++; fence = beforeApply; return { accepted: true } as const; },
    cancel: () => { cancels++; },
  };
  const applied = (turn = turnId): AgentEvent => ({ type: 'steer_applied', sessionId: 'leader', turnId: turn, itemId: input.itemId, message });
  const unapplied = (turn = turnId): AgentEvent => ({ type: 'steer_unapplied', sessionId: 'leader', turnId: turn, itemId: input.itemId, reason: 'turn_ended' });
  return { delivery, controller, input, applied, unapplied, get enqueues() { return enqueues; }, get cancels() { return cancels; }, get fence() { return fence; }, setCurrent: (value: boolean) => { current = value; }, setDurable: () => { durable = true; } };
}

test('volatile mailbox admission is not a delivery receipt; only durable application resolves it', async () => {
  const f = setup(); let settled = false;
  const receipt = f.delivery.deliver(f.input).then(value => { settled = true; return value; });
  await tick(); assert.equal(f.enqueues, 1); assert.equal(settled, false); assert.equal(await f.fence!(), true);
  f.delivery.observe('another-session', f.applied()); await tick(); assert.equal(settled, false);
  f.delivery.observe('leader', f.applied()); assert.equal(await receipt, true);
});

test('concurrent retries share one mailbox item and a durable receipt prevents re-enqueue', async () => {
  const f = setup(); const first = f.delivery.deliver(f.input), retry = f.delivery.deliver(f.input);
  await tick(); assert.equal(f.enqueues, 1);
  f.setDurable(); f.delivery.observe('leader', f.applied()); assert.deepEqual(await Promise.all([first, retry]), [true, true]);
  assert.equal(await f.delivery.deliver(f.input), true); assert.equal(f.enqueues, 1);
});

test('abort cancels queued delivery, rejects a late application, and cannot be replayed', async () => {
  const f = setup(); const receipt = f.delivery.deliver(f.input); await tick();
  f.controller.abort(); assert.equal(await receipt, false); assert.equal(f.cancels, 1); assert.equal(await f.fence!(), false);
  f.delivery.observe('leader', f.applied()); f.setDurable();
  assert.equal(await f.delivery.deliver(f.input), false); assert.equal(f.enqueues, 1);
});

test('retry during a durable append still waits for the original steer_applied event', async () => {
  const f = setup(); const first = f.delivery.deliver(f.input); await tick(); f.setDurable();
  let settled = false; const retry = f.delivery.deliver(f.input).then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false); assert.equal(f.enqueues, 1);
  f.delivery.observe('leader', f.applied()); assert.deepEqual(await Promise.all([first, retry]), [true, true]);
});

test('generation is checked again after asynchronous transcript lookup and by the application fence', async () => {
  const f = setup(); let release!: (value: boolean) => void;
  const transcript = new Promise<boolean>(resolve => { release = resolve; });
  const pending = f.delivery.deliver({ ...f.input, wasApplied: () => transcript }); await tick();
  f.setCurrent(false); release(false); assert.equal(await pending, false); assert.equal(f.enqueues, 0);
  f.setCurrent(true); const next = f.delivery.deliver(f.input); await tick(); f.setCurrent(false);
  assert.equal(await f.fence!(), false); f.delivery.observe('leader', f.unapplied()); assert.equal(await next, false);
});

test('unapplied and terminal results allow a valid event to be retried by the idle host', async () => {
  const f = setup(); const first = f.delivery.deliver(f.input); await tick();
  f.delivery.observe('leader', f.unapplied()); assert.equal(await first, false);
  const next = f.delivery.deliver({ ...f.input, turnId: 'turn-2' }); await tick(); assert.equal(f.enqueues, 2);
  f.delivery.close('leader', 'turn-1'); let resolved = false; void next.then(() => { resolved = true; }); await tick(); assert.equal(resolved, false);
  f.delivery.observe('leader', f.applied('turn-2')); assert.equal(await next, true);
});

test('late application from an old turn cannot acknowledge a retry admitted to a new turn', async () => {
  const f = setup(); const first = f.delivery.deliver(f.input); await tick(); f.delivery.close('leader', 'turn-1'); assert.equal(await first, false);
  const next = f.delivery.deliver({ ...f.input, turnId: 'turn-2' }); let resolved = false; void next.then(() => { resolved = true; }); await tick();
  f.delivery.observe('leader', f.applied('turn-1')); await tick(); assert.equal(resolved, false);
  f.delivery.observe('leader', f.applied('turn-2')); assert.equal(await next, true);
});

test('closed mailbox and enqueue failure clear delivery tracking for a later valid retry', async () => {
  const f = setup();
  assert.equal(await f.delivery.deliver({ ...f.input, enqueue: () => ({ accepted: false, reason: 'turn_closing' }) }), false);
  await assert.rejects(f.delivery.deliver({ ...f.input, enqueue: () => { throw new Error('mailbox failed'); } }), /mailbox failed/);
  const retry = f.delivery.deliver(f.input); await tick(); f.delivery.observe('leader', f.applied()); assert.equal(await retry, true);
});

test('a durable receipt lookup cannot acknowledge a generation invalidated while the lookup was pending', async () => {
  const f = setup(); let release!: (value: boolean) => void;
  const transcript = new Promise<boolean>(resolve => { release = resolve; });
  const receipt = f.delivery.deliver({ ...f.input, wasApplied: () => transcript }); await tick();
  f.setCurrent(false); release(true);
  assert.equal(await receipt, false); assert.equal(f.enqueues, 0);
});

test('Abort during durable receipt lookup returns invalidated rather than applied', async () => {
  const f = setup(); let release!: (value: boolean) => void;
  const transcript = new Promise<boolean>(resolve => { release = resolve; });
  const receipt = f.delivery.deliver({ ...f.input, wasApplied: () => transcript }); await tick();
  f.controller.abort(); release(true);
  assert.equal(await receipt, false); assert.equal(f.enqueues, 0);
});
