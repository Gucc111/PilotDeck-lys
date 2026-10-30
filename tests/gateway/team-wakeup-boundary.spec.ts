import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../src/agent/loop/AgentLoop.js";
import { AgentSession } from "../../src/agent/session/AgentSession.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { AgentRouterRuntime, AgentTeamMessages } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import { NullContextRuntime } from "../../src/context/NullContextRuntime.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { ToolRegistry } from "../../src/tool/index.js";

test("gateway prepared internal input never sends the wakeup placeholder to context, routing or the model", async t => {
  const requests: CanonicalModelRequest[] = [], auxiliary: CanonicalMessage[][] = [];
  const internal: CanonicalMessage = { role: "user", content: [{ type: "text", text: "member asks whether to preserve compatibility" }], metadata: { purpose: "team_runtime", teamEventIds: ["one"] } };
  let pending = [internal];
  const teamMessages: AgentTeamMessages = {
    prepare: async () => ({ messages: pending, messageOnly: true }),
    dispatch: async ({ messages, start }) => { pending = []; return { messages, value: start(messages) }; },
  };
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => { auxiliary.push(request.messages); return { provider: request.provider, model: request.model, scenarioType: "default", isSubagent: false, orchestrating: false, resolvedFrom: "explicit", mutations: {} }; },
    async *execute(_decision, request, context) {
      await (await context.dispatchRequest!({ request, start: async accepted => { requests.push(accepted); } })).value;
      yield { type: "text_delta", text: "preserve compatibility" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream() {},
  };
  const context = new NullContextRuntime(), transcript = new InMemoryTranscriptWriter();
  const loop = new AgentLoop({ provider: "test", model: "controlled", cwd: "/workspace", permissionMode: "default", permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: "default", canPrompt: false, bypassAvailable: true }) }, { router, teamMessages, tools: { registry: new ToolRegistry(), scheduler: { executeAll: async () => [] } }, context: { prepareForModel: async input => { auxiliary.push(input.messages); return context.prepareForModel(input); } } });
  const sessions = new SessionRouter({ idleSweepIntervalMs: 0, createSession: ({ sessionKey }) => new AgentSession({ sessionId: sessionKey, turnRunner: new TurnRunner(loop, transcript, undefined, undefined, undefined, { cwd: "/workspace", transcriptPath: "", collectFileArtifacts: false }) }) });
  t.after(() => { sessions.shutdown(); });
  const gateway = new InProcessGateway(sessions, { prepareTurn: async input => ({ input, isMeta: true, metadata: { purpose: "team_runtime_wakeup" } }) });
  for await (const _event of gateway.submitTurn({ sessionKey: "leader", channelKey: "web", runId: "internal", message: "Team messages are waiting." })) { /* Drain the turn. */ }
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /Team messages are waiting/);
  assert.doesNotMatch(JSON.stringify(auxiliary), /Team messages are waiting|member asks/);
  assert.match(JSON.stringify(requests[0]!.messages), /member asks whether/);
  assert.ok(transcript.entries.some(entry => entry.type === "durable_message" && entry.message.metadata?.teamConsumed));
});
