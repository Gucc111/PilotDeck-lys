import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayWsClient } from '../../src/gateway/client/GatewayWsClient.js';
import { RemoteGateway } from '../../src/gateway/client/RemoteGateway.js';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import { DialogGatewayError } from '../../src/gateway/dialog/errors.js';
import type { Gateway, GatewayEvent, GatewaySteerTurnInput, GatewaySubmitTurnInput } from '../../src/gateway/protocol/types.js';
import type { TeamRuntimeCommand } from '../../src/team/runtimeTypes.js';

test('Remote submit, steer, Abort, and runtime_stop preserve the selected generation and structured rejection', async t => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const validate = (input: { teamActivationId?: string | null; teamStopVersion?: number }) => {
    if (input.teamActivationId !== 'activation' || input.teamStopVersion !== 4) throw new DialogGatewayError('TEAM_GENERATION_EXPIRED', 'This Team run has ended.', { expectedVersion: 4 });
  };
  const gateway = {
    describeServer: async () => ({ mode: 'in_process', serverInstanceId: 'instance' }),
    async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> { calls.push({ method: 'submit', input }); validate(input); yield { type: 'input_accepted', runId: input.runId! }; },
    async steerTurn(input: GatewaySteerTurnInput) { calls.push({ method: 'steer', input }); validate(input); return { accepted: true }; },
    async abortTurn(input: Parameters<Gateway['abortTurn']>[0]) { calls.push({ method: 'abort', input }); validate(input); },
    async teamCommand(input: TeamRuntimeCommand) { calls.push({ method: 'runtime_stop', input }); return { activation: null }; },
  } as unknown as Gateway;
  const server = await startGatewayServer({ gateway, host: '127.0.0.1', port: 0, token: 'generation-contract' });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: 'test' });
  t.after(async () => { client.close(); await server.close(); });
  const hello = await client.connect(); assert.equal(hello.serverInfo.serverInstanceId, 'instance');
  const remote = new RemoteGateway(client), generation = { teamActivationId: 'activation', teamStopVersion: 4 };
  const submit = { ...generation, sessionKey: 'leader', channelKey: 'web' as const, runId: 'work', message: 'go' };
  const events: GatewayEvent[] = []; for await (const event of remote.submitTurn(submit)) events.push(event);
  assert.ok(events.some(event => event.type === 'input_accepted'));
  const steer = { ...generation, sessionKey: 'leader', runId: 'work', itemId: 'note', message: 'adjust' };
  assert.deepEqual(await remote.steerTurn(steer), { accepted: true });
  const abort = { ...generation, sessionKey: 'leader', runId: 'work', reason: 'user' }; await remote.abortTurn(abort);
  const stop = { action: 'runtime_stop' as const, sessionKey: 'leader', activationId: 'activation', stopVersion: 4 }; await remote.teamCommand(stop);
  assert.deepEqual(calls.slice(0, 4), [{ method: 'submit', input: submit }, { method: 'steer', input: steer }, { method: 'abort', input: abort }, { method: 'runtime_stop', input: stop }]);
  for (const operation of [() => remote.abortTurn({ ...abort, teamStopVersion: 3 }), () => remote.steerTurn({ ...steer, teamStopVersion: 3 }), async () => { for await (const _event of remote.submitTurn({ ...submit, teamStopVersion: 3 })) assert.fail('Stale turn was accepted'); }]) {
    await assert.rejects(operation, { code: 'TEAM_GENERATION_EXPIRED', details: { expectedVersion: 4 } });
  }
  assert.ok(calls.slice(4).every(call => (call.input as { teamStopVersion: number }).teamStopVersion === 3), 'Remote never upgrades an old generation');
});

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
for (const selection of [false, true]) test(`Team producer keeps consuming after its Remote observer disconnects (selection=${selection})`, async t => {
  const resume = gate(), done = gate(); let completed = false, finalized = false, aborts = 0;
  const gateway = {
    describeServer: async () => ({ mode: 'in_process' }),
    async *submitTurn(): AsyncIterable<GatewayEvent> {
      try { yield { type: 'input_accepted', runId: 'work' }; await resume.promise; yield { type: 'assistant_text_delta', text: 'after disconnect' }; completed = true; yield { type: 'turn_completed', usage: {}, finishReason: 'completed' }; }
      finally { finalized = true; done.resolve(); }
    },
    async abortTurn() { aborts++; },
  } as unknown as Gateway;
  const server = await startGatewayServer({ gateway, host: '127.0.0.1', port: 0, token: 'disconnect-team' });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: 'test' });
  t.after(async () => { resume.resolve(); client.close(); await server.close(); }); await client.connect();
  const remote = new RemoteGateway(client), disconnected = new Promise<void>(resolve => client.onDisconnect(() => resolve()));
  const iterator = remote.submitTurn({ sessionKey: 'leader', channelKey: 'web', message: 'go', ...(selection ? { teamSelection: { team: { id: 'team' }, requestToken: 'selection' } } : { teamActivationId: 'activation', teamStopVersion: 0 }) })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'input_accepted'); client.close(); await disconnected;
  assert.equal(aborts, 0); assert.equal(finalized, false); resume.resolve(); await done.promise;
  assert.equal(completed, true); assert.equal(aborts, 0);
});
