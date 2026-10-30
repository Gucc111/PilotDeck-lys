import assert from 'node:assert/strict';
import test from 'node:test';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import { GatewayWsClient, GatewayRequestError } from '../../src/gateway/client/GatewayWsClient.js';
import { RemoteGateway } from '../../src/gateway/client/RemoteGateway.js';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import type { SessionRouter } from '../../src/gateway/SessionRouter.js';
import type { TeamCommand } from '../../src/team/types.js';
import { TeamError } from '../../src/team/validation.js';

const router = () => ({ sessionCount: () => 0 }) as unknown as SessionRouter;

test('Team command uses the same contract in process and over authenticated WebSocket', async (t) => {
  const calls: TeamCommand[] = [];
  const gateway = new InProcessGateway(router(), {
    teamCommand: async (command) => {
      calls.push(command);
      if (command.action === 'team_delete') {
        throw Object.assign(new TeamError('TEAM_REVISION_CONFLICT', 'This Team was edited. Reload the current revision.'), { details: { profileId: 'leader-id' } });
      }
      return { profiles: [], teams: [] };
    },
  });
  assert.ok((await gateway.describeServer()).capabilities?.includes('team_command'));
  const server = await startGatewayServer({ gateway, host: '127.0.0.1', port: 0, token: 'team-command-test' });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: 'test' });
  t.after(async () => { client.close(); await server.close(); });
  await client.connect();
  const remote = new RemoteGateway(client);
  assert.deepEqual(await remote.teamCommand({ action: 'library' }), await gateway.teamCommand({ action: 'library' }));
  assert.equal(calls.length, 2);
  await assert.rejects(remote.teamCommand({ action: 'team_delete', id: 'team-id', requestToken: 'delete' }), (error: unknown) => {
    assert.ok(error instanceof GatewayRequestError);
    assert.equal(error.code, 'TEAM_REVISION_CONFLICT');
    assert.deepEqual(error.details, { profileId: 'leader-id' });
    return true;
  });
});

test('unconfigured Gateway advertises no Team support and returns a structured unavailable error', async () => {
  const gateway = new InProcessGateway(router());
  assert.equal((await gateway.describeServer()).capabilities?.includes('team_command'), false);
  await assert.rejects(gateway.teamCommand({ action: 'library' }), { code: 'CAPABILITY_UNAVAILABLE' });
});
