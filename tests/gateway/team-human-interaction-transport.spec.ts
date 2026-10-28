import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayWsClient } from '../../src/gateway/client/GatewayWsClient.js';
import { RemoteGateway } from '../../src/gateway/client/RemoteGateway.js';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import { GatewayBrowserClient } from '../../src/web/client/GatewayBrowserClient.js';
import type { SessionRouter } from '../../src/gateway/SessionRouter.js';
import type { Gateway, GatewayTeamInteractionResponseInput, GatewayTeamParticipantMessagesInput } from '../../src/gateway/protocol/types.js';
import type { TeamHumanInteraction, TeamRuntimeParticipantMessages } from '../../src/team/runtimeTypes.js';
import { TeamError } from '../../src/team/validation.js';

const owner = { sessionKey: 'web:root', activationId: 'activation', stopVersion: 4, participantId: 'member' };
const interaction: TeamHumanInteraction = {
  ...owner, id: 'interaction', requestId: 'request', participantDisplayName: '审查员', kind: 'user_question',
  request: { questions: [{ question: '执行哪些检查？', multiSelect: true, options: [{ label: '单元测试', description: '本地验证' }, { label: '浏览器', description: '用户流程' }] }] },
  status: 'answered', createdAt: '2026-10-28T00:00:00.000Z', resolvedAt: '2026-10-28T00:01:00.000Z',
  resolution: { type: 'answered', answers: { '执行哪些检查？': ['单元测试', '浏览器'] }, annotations: { '执行哪些检查？': { notes: '保留两类验证。' } } },
};
const responseInput: GatewayTeamInteractionResponseInput = { ...owner, interactionId: interaction.id, requestId: interaction.requestId, kind: interaction.kind, answer: interaction.resolution, reason: '由用户直接回答' };
const readInput: GatewayTeamParticipantMessagesInput = { ...owner, cursor: '12', limit: 25 };
const transcript: TeamRuntimeParticipantMessages = {
  ...owner, messages: [{ id: 'turn:block', turnId: 'turn', role: 'assistant', isStreaming: true, content: [{ type: 'text', text: '正在检查…' }] }],
  nextCursor: '37', streaming: true, streamEpoch: 'process-epoch', revision: 9,
};
const router = () => ({ sessionCount: () => 0 }) as unknown as SessionRouter;

for (const clientKind of ['remote', 'browser'] as const) {
  test(`${clientKind} carries both Team RPCs and dedicated notifications across a real authenticated WebSocket`, { timeout: 5000 }, async t => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const configured = new InProcessGateway(router(), {
      teamInteractionRespond: async () => ({ delivered: false }),
      teamParticipantMessages: async () => transcript,
    });
    const validateOwner = (input: typeof owner) => {
      if (input.sessionKey !== owner.sessionKey || input.activationId !== owner.activationId || input.participantId !== owner.participantId || input.stopVersion !== owner.stopVersion) {
        throw Object.assign(new TeamError('TEAM_GENERATION_EXPIRED', 'The supplied Team owner is stale.'), { details: { expected: owner } });
      }
    };
    const gateway = {
      describeServer: () => configured.describeServer(),
      async teamInteractionRespond(input: GatewayTeamInteractionResponseInput) { calls.push({ method: 'respond', input }); validateOwner(input); return { delivered: true, interaction }; },
      async teamParticipantMessages(input: GatewayTeamParticipantMessagesInput) { calls.push({ method: 'messages', input }); validateOwner(input); return transcript; },
    } as unknown as Gateway;
    const server = await startGatewayServer({ gateway, host: '127.0.0.1', port: 0, token: 'team-human-transport' });
    const socket = clientKind === 'remote'
      ? new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: 'test' })
      : new GatewayBrowserClient({ url: server.wsUrl, token: server.token, clientName: 'test' });
    t.after(async () => { socket.close(); await server.close(); });
    const hello = await socket.connect();
    assert.ok(hello.serverInfo.capabilities?.includes('team_interaction_respond'));
    assert.ok(hello.serverInfo.capabilities?.includes('team_participant_messages'));
    const client = socket instanceof GatewayWsClient ? new RemoteGateway(socket) : socket;
    assert.deepEqual(await client.teamInteractionRespond(responseInput), { delivered: true, interaction });
    assert.deepEqual(await client.teamParticipantMessages(readInput), transcript);
    assert.deepEqual(calls, [{ method: 'respond', input: responseInput }, { method: 'messages', input: readInput }]);
    const badOwner = { ...owner, stopVersion: 3 };
    await assert.rejects(client.teamInteractionRespond({ ...responseInput, ...badOwner }), { code: 'TEAM_GENERATION_EXPIRED', details: { expected: owner } });
    await assert.rejects(client.teamParticipantMessages({ ...readInput, ...badOwner }), { code: 'TEAM_GENERATION_EXPIRED', details: { expected: owner } });
    assert.equal((calls[2]!.input as typeof owner).stopVersion, 3, 'clients must not silently upgrade stale owners');
    assert.equal((calls[3]!.input as typeof owner).stopVersion, 3);
    const events = [
      { type: 'team_interaction', interaction: { ...interaction, status: 'pending', resolvedAt: undefined, resolution: undefined } },
      { type: 'team_interaction_updated', interaction, delivered: true },
      { type: 'team_participant_message', ...owner, streamEpoch: transcript.streamEpoch, revision: transcript.revision, messages: transcript.messages, streaming: true },
      { type: 'team_participant_message', ...owner, streamEpoch: transcript.streamEpoch, revision: 10, messages: [], streaming: false, reload: true },
    ].map(event => ({ sessionKey: owner.sessionKey, event }));
    const received: Array<{ name: string; payload: unknown }> = [];
    let finish!: () => void;
    const notifications = new Promise<void>(resolve => { finish = resolve; });
    client.onNotification((name, payload) => { received.push({ name, payload }); if (received.length === events.length) finish(); });
    for (const payload of events) server.broadcastNotification('team_runtime_event', payload);
    await notifications;
    assert.deepEqual(received, JSON.parse(JSON.stringify(events.map(payload => ({ name: 'team_runtime_event', payload })))));
    assert.equal(calls.length, 4, 'notification observation never resubmits a response or reads another transcript');
  });

  test(`${clientKind} preserves unavailable capability errors for both Team RPCs`, { timeout: 5000 }, async t => {
    const gateway = { describeServer: async () => ({ mode: 'in_process', capabilities: [] }) } as unknown as Gateway;
    const server = await startGatewayServer({ gateway, host: '127.0.0.1', port: 0, token: 'team-unavailable' });
    const socket = clientKind === 'remote'
      ? new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: 'test' })
      : new GatewayBrowserClient({ url: server.wsUrl, token: server.token, clientName: 'test' });
    t.after(async () => { socket.close(); await server.close(); });
    const hello = await socket.connect(); assert.deepEqual(hello.serverInfo.capabilities, []);
    const client = socket instanceof GatewayWsClient ? new RemoteGateway(socket) : socket;
    await assert.rejects(client.teamInteractionRespond(responseInput), { code: 'CAPABILITY_UNAVAILABLE' });
    await assert.rejects(client.teamParticipantMessages(readInput), { code: 'CAPABILITY_UNAVAILABLE' });
  });
}
