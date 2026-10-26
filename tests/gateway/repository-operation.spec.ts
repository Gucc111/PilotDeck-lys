import assert from "node:assert/strict";
import test from "node:test";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import { startGatewayServer } from "../../src/gateway/server/GatewayServer.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { RepositoryOperationInput } from "../../src/session/repository/operations.js";

test("repository_operation is independent of removed checkpoints across InProcess and Remote", async t => {
  const calls: RepositoryOperationInput[] = [];
  const gateway = new InProcessGateway({ sessionCount: () => 0 } as unknown as SessionRouter, {
    repositoryOperation: async input => { calls.push(input); return { success: true }; },
  });
  assert.ok((await gateway.describeServer()).capabilities?.includes("repository_operation"));
  const server = await startGatewayServer({ gateway, host: "127.0.0.1", port: 0, token: "repository-contract-test" });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
  t.after(async () => { client.close(); await server.close(); });
  await client.connect(); const remote = new RemoteGateway(client);
  const input: RepositoryOperationInput = { projectKey: "/project", repositoryOperation: { operation: "stage", files: ["a.txt"] } };
  assert.deepEqual(await remote.repositoryOperation(input), await gateway.repositoryOperation(input));
  assert.deepEqual(calls, [input, input]);
  await assert.rejects(remote.manageCheckpoints({ projectKey: "/project", sessionKey: "session", action: "git" }), { code: "CHECKPOINTS_REMOVED" });
  assert.equal(calls.length, 2);
});

test("unconfigured Gateway rejects Git with a capability error", async () => {
  const gateway = new InProcessGateway({} as SessionRouter);
  await assert.rejects(gateway.repositoryOperation({ projectKey: "/project", repositoryOperation: { operation: "init" } }), { code: "CAPABILITY_UNAVAILABLE" });
});
