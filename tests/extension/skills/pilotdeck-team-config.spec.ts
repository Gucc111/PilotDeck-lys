import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { loadSkillFromPath } from "../../../src/extension/plugins/loading/PluginLoader.js";

const skillRoot = resolve("skills/pilotdeck-team-config");
const helper = `${skillRoot}/scripts/team-command.mjs`;

async function withGateway(run: (url: string, frames: any[]) => Promise<void>, closeReason?: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const frames: any[] = [];
  server.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    if (frame.type === "hello") {
      if (closeReason) ws.close(4001, closeReason);
      else ws.send(JSON.stringify({ type: "hello_ok", protocolVersion: "1.1" }));
    } else {
      ws.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result: { saved: true } }));
    }
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`ws://127.0.0.1:${address.port}/ws`, frames);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function call(url: string, input: object) {
  const child = spawn(process.execPath, [helper, JSON.stringify(input), "--url", url], {
    env: { ...process.env, PILOTDECK_GATEWAY_TOKEN: "fixture-token" },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("bundled Team skill exposes a useful description to implicit selection", async () => {
  const plugin = await loadSkillFromPath(skillRoot, "builtin");
  const skill = plugin.skills?.find(item => item.name === "pilotdeck-team-config");
  assert.ok(skill);
  assert.equal(typeof skill.frontmatter.description, "string");
  assert.match(String(skill.frontmatter.description), /Create.*Team configurations/);
});

test("Team helper uses the current handshake and supported RPC routes", async () => {
  await withGateway(async (url, frames) => {
    for (const [action, method] of [["library", "team_command"], ["models", "model_catalog_list"], ["projects", "list_projects"]]) {
      const result = await call(url, { action });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { saved: true });
      assert.equal(frames.at(-2).protocolVersion, "1.1");
      assert.equal(frames.at(-2).clientName, "cli");
      assert.equal(frames.at(-1).method, method);
      assert.deepEqual(frames.at(-1).params, action === "library" ? { action } : {});
      assert.ok(!result.stdout.includes("fixture-token"));
    }
  });
});

test("Team helper rejects extra discovery fields before connecting", async () => {
  const result = await call("ws://127.0.0.1:1/ws", { action: "models", unexpected: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /models accepts only the action field/);
});

test("Team helper reports protocol rejection reasons", async () => {
  await withGateway(async url => {
    const result = await call(url, { action: "library" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /4001: incompatible protocol/);
  }, "incompatible protocol");
});
