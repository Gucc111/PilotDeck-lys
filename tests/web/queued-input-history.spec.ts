import test from "node:test";
import assert from "node:assert/strict";

import { flattenCanonicalMessage } from "../../src/web/server/readSessionMessages.js";

test("web history preserves queued guidance identity for restart reconciliation", () => {
  const messages = flattenCanonicalMessage({
    role: "user",
    content: [{ type: "text", text: "Use HTML instead" }],
    metadata: {
      purpose: "mid_turn_steer",
      queueItemId: "queue-1",
    },
  }, {
    index: 0,
    sessionKey: "web:s_test",
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.queueItemId, "queue-1");
});

test('Team history exposes only actual dispatches as system boundaries', () => {
  const message = { role: 'user' as const, content: [{ type: 'text' as const, text: 'private member message' }], metadata: { purpose: 'team_runtime', synthetic: true } };
  assert.deepEqual(flattenCanonicalMessage(message, { index: 0, sessionKey: 'web:team' }), []);
  const consumed = { ...message, metadata: { ...message.metadata, teamConsumed: true, teamInjectionMode: 'start' as const, teamRequestId: 'request-1', teamEventIds: ['message-1'] } };
  const [row] = flattenCanonicalMessage(consumed, { index: 1, sessionKey: 'web:team', turnId: 'turn-2' });
  assert.equal(row?.kind, 'team_message');
  assert.equal(row?.role, 'system');
  assert.equal(row?.id, 'team:request-1');
  assert.equal(row?.teamInjectionMode, 'start');
  assert.deepEqual(row?.teamMessageIds, ['message-1']);
  assert.ok(!JSON.stringify(row).includes('private member message'));
  const [human] = flattenCanonicalMessage({ ...consumed, metadata: { ...consumed.metadata, teamTurnOrigin: 'human' } }, { index: 2, sessionKey: 'web:team', turnId: 'human-turn' });
  assert.equal(human?.teamInjectionMode, 'during');
});
