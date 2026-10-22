import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";

import { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";

test("GatewayWsClient reports disconnects to existing and late observers", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address === "object");

  let serverSocket: ServerWebSocket | undefined;
  server.on("connection", (socket) => {
    serverSocket = socket;
    socket.once("message", () => {
      socket.send(JSON.stringify({
        type: "hello_ok",
        protocolVersion: "test",
        serverVersion: "test",
        serverInfo: {},
      }));
    });
  });

  const client = new GatewayWsClient({
    url: `ws://127.0.0.1:${address.port}`,
    token: "test-token",
    clientName: "test",
  });
  const disconnected = new Promise<Error>((resolve) => client.onDisconnect(resolve));

  await client.connect();
  assert.ok(serverSocket);
  serverSocket.close();

  const error = await disconnected;
  assert.match(error.message, /Gateway WebSocket closed/);
  assert.throws(
    () => client.request("list_projects", {}),
    /Gateway WebSocket is not connected/,
  );

  let lateError: Error | undefined;
  client.onDisconnect((value) => {
    lateError = value;
  });
  assert.equal(lateError, error);
});


test("GatewayWsClient rejects a stream when the server returns an error before its first event", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "hello") {
        socket.send(JSON.stringify({ type: "hello_ok", protocolVersion: "test", serverVersion: "test", serverInfo: {} }));
      } else {
        socket.send(JSON.stringify({ type: "response", id: frame.id, ok: false, error: {
          code: "INVALID_REQUEST", message: "Invalid request parameters.", details: { field: "message" },
        } }));
      }
    });
  });
  const client = new GatewayWsClient({ url: `ws://127.0.0.1:${address.port}`, token: "test-token", clientName: "test" });
  t.after(async () => { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  await client.connect();
  await assert.rejects(async () => {
    for await (const _event of client.stream("submit_turn", { sessionKey: "ordinary-session" })) {
      assert.fail("Rejected stream must not emit events.");
    }
  }, { code: "INVALID_REQUEST", message: "Invalid request parameters.", details: { field: "message" } });
});
