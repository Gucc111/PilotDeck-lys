import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayWsConnection } from '../../src/gateway/server/GatewayWsConnection.js';
import type { TextWebSocketConnection } from '../../src/gateway/server/websocket.js';
import type { Gateway, GatewayEvent } from '../../src/gateway/protocol/types.js';
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from '../../src/gateway/protocol/version.js';

/** Controlled observer fault: error responses remain writable so this tests producer lifetime only. */
class FailingObserver {
  readonly sent: unknown[] = [];
  failNextEvent = true;
  onMessage(_handler: (message: string) => void) {}
  onClose(_handler: () => void) {}
  close() {}
  sendText(text: string) {
    const frame = JSON.parse(text);
    if (frame.type === 'event' && this.failNextEvent) { this.failNextEvent = false; throw new Error('observer write failed'); }
    this.sent.push(frame);
  }
}

test('Team observer write failure cannot close its server-owned generator', async () => {
  const socket = new FailingObserver(); let completed = false, finalized = false, consumed = 0;
  const gateway = {
    describeServer: async () => ({ mode: 'in_process' }),
    async *submitTurn(): AsyncIterable<GatewayEvent> {
      try { consumed++; yield { type: 'input_accepted', runId: 'work' }; consumed++; yield { type: 'assistant_text_delta', text: 'still running' }; completed = true; yield { type: 'turn_completed', usage: {}, finishReason: 'completed' }; }
      finally { finalized = true; }
    },
    async abortTurn() { assert.fail('Observer failure must not abort Team'); },
  } as unknown as Gateway;
  const connection = new GatewayWsConnection(socket as unknown as TextWebSocketConnection, { gateway, token: 'secret', serverVersion: 'test' });
  const handle = (connection as unknown as { handleMessage(message: string): Promise<void> }).handleMessage.bind(connection);
  await handle(JSON.stringify({ type: 'hello', protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION, clientName: 'test', clientVersion: 'test', token: 'secret' }));
  await handle(JSON.stringify({ type: 'request', id: 'stream', method: 'submit_turn', params: { sessionKey: 'leader', channelKey: 'web', message: 'go', teamActivationId: 'activation', teamStopVersion: 0 } }));
  assert.equal(finalized, true); assert.equal(completed, true); assert.equal(consumed, 2);
});
