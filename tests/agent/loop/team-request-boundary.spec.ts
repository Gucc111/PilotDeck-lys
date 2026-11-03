import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentLoop, type AgentLoopRunResult } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRouterRuntime, AgentTeamMessages } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { NullContextRuntime } from "../../../src/context/NullContextRuntime.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import { TeamRuntime } from "../../../src/team/TeamRuntime.js";
import { createTeamRuntimeTools } from "../../../src/team/runtimeTools.js";
import type { TeamRuntimeMessage, TeamRuntimeParticipant } from "../../../src/team/runtimeTypes.js";
import type { AgentProfile, TeamDefinition } from "../../../src/team/types.js";

function batch(id = "one", text = "internal message"): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }], metadata: { purpose: "team_runtime", teamEventIds: [id] } };
}
const human: CanonicalMessage = { role: "user", content: [{ type: "text", text: "human input" }] };
const wakeup: CanonicalMessage = { role: "user", content: [{ type: "text", text: "wakeup placeholder" }], metadata: { purpose: "team_runtime_wakeup" } };

function fixture(options: { messageOnly?: boolean; removeAtDispatch?: boolean; emptyBeforePrepare?: boolean; humanSteer?: boolean; lateHumanSteer?: boolean; failHumanPersistence?: boolean; duplicateDispatch?: boolean; busyArrival?: boolean; contextLimit?: number; text?: string; continuation?: boolean; historicalMessages?: CanonicalMessage[]; abortAt?: "prepare" | "dispatch" | "final-prepare" } = {}) {
  const requests: CanonicalModelRequest[] = [], auxiliary: CanonicalMessage[][] = [], durable: CanonicalMessage[] = [];
  const dispatches: Array<{ requestId: string; attemptId: string; hasHumanInput?: boolean }> = [];
  const controller = new AbortController();
  let prepares = 0;
  let pending = options.emptyBeforePrepare ? [] : [batch("one", options.text)], first = true;
  const teamMessages: AgentTeamMessages = {
    prepare: async () => {
      prepares += 1;
      if (options.abortAt === "prepare" || options.abortAt === "final-prepare" && prepares > 1) {
        controller.abort("team_stopped"); throw Object.assign(new Error("Team generation expired"), { code: "TEAM_GENERATION_EXPIRED" });
      }
      return { messages: pending, messageOnly: options.messageOnly ?? false };
    },
    dispatch: async ({ start, messages, requestId, attemptId, hasHumanInput }) => {
      if (options.abortAt === "dispatch") { controller.abort("team_stopped"); throw Object.assign(new Error("Team generation expired"), { code: "TEAM_GENERATION_EXPIRED" }); }
      dispatches.push({ requestId, attemptId, hasHumanInput });
      const accepted = options.removeAtDispatch ? [] : messages;
      pending = [];
      return { value: start(accepted), messages: accepted };
    },
  };
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => {
      auxiliary.push(request.messages);
      if (options.lateHumanSteer) steerPending = true;
      return { provider: request.provider, model: request.model, scenarioType: "default", isSubagent: false, orchestrating: false, resolvedFrom: "explicit", mutations: {} };
    },
    async *execute(_decision, request, context) {
      const start = async (accepted: CanonicalModelRequest) => { requests.push(accepted); return undefined; };
      if (context.dispatchRequest) {
        await (await context.dispatchRequest({ request, start })).value;
        if (options.duplicateDispatch) {
          const retry = options.continuation ? { ...request, messages: request.messages.concat({ role: "assistant", content: [{ type: "text", text: "partial answer" }] }) } : request;
          await (await context.dispatchRequest({ request: retry, start })).value;
        }
      } else await start(request);
      if (options.busyArrival && first) { pending = [batch("two", "arrived during generation")]; first = false; }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "answer" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream() {},
  };
  const nullContext = new NullContextRuntime();
  const loop = new AgentLoop({ provider: "test", model: "controlled", cwd: "/workspace", maxOutputTokens: 1,
    permissionMode: "default", permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: "default", canPrompt: false, bypassAvailable: true }),
  }, { router, teamMessages, tools: { registry: new ToolRegistry(), scheduler: { executeAll: async () => [] } },
    context: { prepareForModel: async input => { auxiliary.push(input.messages); return nullContext.prepareForModel(input); } },
    getModelMaxContextTokens: () => options.contextLimit,
  });
  let steerPending = options.humanSteer ?? false;
  const run = async () => {
    const iterator = loop.run({ sessionId: "s", turnId: "turn", messages: [...(options.historicalMessages ?? []), ...(options.messageOnly ? [wakeup] : [human])], abortSignal: controller.signal, maxTurns: 5,
      drainSteerMessages: () => { if (!steerPending) return []; steerPending = false; return [{ itemId: "human-steer", message: human }]; },
      onDurableMessage: message => { if (options.failHumanPersistence && message === human) throw new Error("human input persistence failed"); durable.push(message); } });
    const events: AgentEvent[] = [];
    while (true) { const next = await iterator.next(); if (next.done) return { events, result: next.value as AgentLoopRunResult }; events.push(next.value); }
  };
  return { requests, auxiliary, durable, dispatches, run };
}

test("pending Team batch is absent from history preparation and routing, then persisted only at actual dispatch", async () => {
  const f = fixture({ messageOnly: true });
  const run = await f.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.messages.some(message => message.metadata?.purpose === "team_runtime_wakeup"), false);
  assert.equal(f.requests[0]!.messages.at(-1)?.metadata?.teamEventIds?.[0], "one");
  assert.equal(f.auxiliary.flat().some(message => message.metadata?.teamEventIds?.length), false);
  const injected = f.durable.filter(message => message.metadata?.teamConsumed);
  assert.equal(injected.length, 1);
  assert.ok(injected[0]!.metadata?.teamRequestId);
  assert.equal(run.events.filter(event => event.type === "steer_applied").length, 1);
});

test("continuation retries keep the accepted batch before partial assistant output", async () => {
  const f = fixture({ duplicateDispatch: true, continuation: true });
  await f.run();
  assert.equal(f.requests[1]!.messages.at(-1)?.role, "assistant");
  assert.equal(f.requests[1]!.messages.at(-2)?.metadata?.teamEventIds?.[0], "one");
});

test("deleting an entire message-only batch before dispatch makes no model request or durable injection", async () => {
  const f = fixture({ messageOnly: true, removeAtDispatch: true });
  const run = await f.run();
  assert.equal(f.requests.length, 0);
  assert.equal(f.durable.length, 0);
  assert.equal(run.result.result.turns, 0);
  assert.equal(run.events.some(event => event.type === "steer_applied"), false);
});

test("deleting Team input preserves concurrent human input and does not mark injection", async () => {
  const f = fixture({ removeAtDispatch: true });
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]!.messages, [human]);
  assert.equal(f.durable.some(message => message.metadata?.teamConsumed), false);
});

test("transport retry retains the accepted batch without duplicate transcript injection", async () => {
  const f = fixture({ duplicateDispatch: true });
  const run = await f.run();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.messages.at(-1)?.metadata?.teamEventIds?.[0], "one");
  assert.equal(f.durable.filter(message => message.metadata?.teamConsumed).length, 1);
  assert.equal(run.events.filter(event => event.type === "steer_applied").length, 1);
  assert.equal(f.dispatches[0]?.requestId, f.dispatches[1]?.requestId);
  assert.notEqual(f.dispatches[0]?.attemptId, f.dispatches[1]?.attemptId);
});

test("a batch arriving during generation is injected into the same Agent Loop's next request", async () => {
  const f = fixture({ busyArrival: true });
  const run = await f.run();
  assert.equal(f.requests.length, 2);
  const injections = f.durable.filter(message => message.metadata?.teamConsumed);
  assert.equal(injections[0]?.metadata?.teamInjectionMode, "start");
  assert.equal(injections[1]?.metadata?.teamInjectionMode, "during");
  assert.equal(run.result.result.turns, 2);
});

test("an oversized batch is retained without sending a partial request", async () => {
  const f = fixture({ contextLimit: 10, text: "whole message ".repeat(200) });
  const run = await f.run();
  assert.equal(f.requests.length, 0);
  assert.equal(f.durable.length, 0);
  assert.equal(run.result.result.errors?.[0]?.code, "TEAM_MESSAGE_BATCH_TOO_LARGE");
});

for (const abortAt of ["prepare", "dispatch", "final-prepare"] as const) {
  test(`Abort at ${abortAt} records a stopped loop rather than a generation error`, async () => {
    const f = fixture({ abortAt });
    const run = await f.run();
    assert.equal(run.result.result.type, "aborted");
    assert.equal(run.result.result.stopReason, "aborted_streaming");
    assert.equal(f.requests.length, abortAt === "final-prepare" ? 1 : 0);
  });
}

test("unproven historical Team injections cannot return through a resumed model request", async () => {
  const unproven = batch("legacy", "unproven old Team message");
  const consumed = batch("sent", "already consumed old Team message");
  consumed.metadata!.teamConsumed = true;
  const f = fixture({ historicalMessages: [unproven, consumed] });
  await f.run();
  assert.doesNotMatch(JSON.stringify(f.requests), /unproven old Team message/);
  assert.match(JSON.stringify(f.requests), /already consumed old Team message/);
  assert.doesNotMatch(JSON.stringify(f.auxiliary), /unproven old Team message/);
});

for (const emptyBeforePrepare of [false, true]) {
  test(`human steer survives deletion of the message-only starter batch (already empty=${emptyBeforePrepare})`, async () => {
    const f = fixture({ messageOnly: true, humanSteer: true, removeAtDispatch: true, emptyBeforePrepare });
    const run = await f.run();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0]!.messages, [human]);
    assert.equal(f.dispatches[0]!.hasHumanInput, true);
    assert.equal(run.result.result.turns, 1);
    assert.equal(f.durable.some(message => message.metadata?.teamConsumed), false);
  });
}

test("human steer arriving during routing joins the first request after Team batch deletion", async () => {
  const f = fixture({ messageOnly: true, lateHumanSteer: true, removeAtDispatch: true, duplicateDispatch: true });
  const run = await f.run();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0]!.messages, [human]);
  assert.deepEqual(f.requests[1]!.messages, [human]);
  assert.equal(f.durable.filter(message => message === human).length, 1);
  assert.equal(run.result.result.type, "success");
});

test("late human input capacity and persistence failures do not dispatch the request", async () => {
  const capacity = fixture({ messageOnly: true, lateHumanSteer: true, removeAtDispatch: true, contextLimit: 1 });
  const capacityRun = await capacity.run();
  assert.equal(capacity.requests.length, 0);
  assert.equal(capacityRun.result.result.errors?.[0]?.code, "TEAM_MESSAGE_BATCH_TOO_LARGE");
  const persistence = fixture({ messageOnly: true, lateHumanSteer: true, removeAtDispatch: true, failHumanPersistence: true });
  const persistenceRun = await persistence.run();
  assert.equal(persistence.requests.length, 0);
  assert.equal(persistence.dispatches.length, 0);
  assert.equal(persistenceRun.result.result.type, "error");
});

test("inspecting a pending inbox exposes message text while deletion prevents later Team reinjection", async t => {
  const pilotHome = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-inspect-boundary-"));
  const profile = (id: string, role: "leader" | "teammate"): AgentProfile => ({
    id, role, createdAt: "", updatedAt: "", config: {
      displayName: id, description: "", systemPrompt: "", model: { mode: "model", provider: "test", model: "controlled" },
      workspace: { mode: "team" }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: "default",
    },
  });
  const leader = profile("leader", "leader"), teammate = profile("teammate", "teammate");
  const team: TeamDefinition = { id: "team", createdAt: "", updatedAt: "", leader, teammates: [teammate], config: {
    displayName: "Inspect boundary", description: "", instructions: "", defaultProjectKey: "project", leader: { id: leader.id }, teammates: [{ id: teammate.id }],
  } };
  const participants: TeamRuntimeParticipant[] = [leader, teammate].map(p => ({ id: p.id, role: p.role, profile: p,
    projectKey: "project", projectPath: "/workspace", model: { mode: "model", provider: "test", model: "controlled" }, capabilities: p.config.capabilities,
  }));
  let leaderBusy = false;
  const runtime = new TeamRuntime({ pilotHome, resolveTeam: async () => team,
    probe: async () => ({ projectKey: "project", participants, issues: [], environmentFingerprint: "inspect" }),
    isLeaderBusy: () => leaderBusy, executeParticipant: async () => { throw new Error("Busy recipients must not start another Loop."); },
  });
  t.after(async () => { await runtime.dispose(); await rm(pilotHome, { recursive: true, force: true }); });
  const activation = (await runtime.select({ action: "runtime_select", sessionKey: "web:inspect", team: { id: team.id }, requestToken: "select" })).activation!;
  leaderBusy = true;
  const actor = { sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: activation.stopVersion, participantId: teammate.id };
  await runtime.beginTurn(actor, { turnId: "inspect-turn", trigger: "human" });
  const registry = new ToolRegistry();
  for (const tool of createTeamRuntimeTools(runtime, actor, "teammate")) registry.register(tool);
  const requests: CanonicalModelRequest[] = [], durable: CanonicalMessage[] = [], auxiliary: CanonicalMessage[][] = [];
  const secret = "PENDING_BODY_MUST_NOT_ESCAPE_INSPECT";
  let pending: TeamRuntimeMessage | undefined, removed = false, inspected = false;
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: false, orchestrating: false, resolvedFrom: "explicit", mutations: {} }),
    async *execute(_decision, request, context) {
      assert.ok(context.dispatchRequest);
      await (await context.dispatchRequest({ request, start: async accepted => { requests.push(structuredClone(accepted)); } })).value;
      if (requests.length === 1) {
        pending = await runtime.send({ ...actor, participantId: leader.id }, { recipientId: teammate.id, text: secret, requestToken: "pending" });
        yield { type: "tool_call_start", id: "inspect-call", name: "team_messages" };
        yield { type: "tool_call_end", toolCall: { id: "inspect-call", name: "team_messages", input: { limit: 200 } } };
      } else {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", finishReason: "stop" };
      }
    },
    async *stream() {},
  };
  const nullContext = new NullContextRuntime();
  const loop = new AgentLoop({ provider: "test", model: "controlled", cwd: "/workspace", permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/workspace", canPrompt: false }),
  }, { router, tools: { registry, scheduler: { executeAll: async (calls, context) => {
    assert.equal(calls.length, 1);
    const call = calls[0]!, startedAt = new Date().toISOString();
    const output = await registry.get(call.name)!.execute(call.input, context);
    inspected = true;
    assert.match(JSON.stringify(output), new RegExp(secret));
    assert.ok(!JSON.stringify(output).includes("bodyAvailable"));
    assert.equal((await runtime.get(actor.sessionKey)).activation!.messages.find(message => message.id === pending!.id)?.text, secret);
    return [{ type: "success", toolCallId: call.id, toolName: call.name, ...output, startedAt, completedAt: new Date().toISOString() }];
  } } }, context: { prepareForModel: async input => { auxiliary.push(structuredClone(input.messages)); return nullContext.prepareForModel(input); } },
    teamMessages: {
      prepare: async ({ turnId }) => ({ messageOnly: false, messages: (await runtime.pendingMessages(actor, turnId)).map(message => batch(message.id, message.text)) }),
      dispatch: async ({ turnId, requestId, attemptId, hasHumanInput, messages, start }) => {
        const sent = await runtime.dispatchMessages(actor, { turnId, requestId, attemptId, hasHumanInput, messageIds: messages.flatMap(message => message.metadata?.teamEventIds ?? []) },
          accepted => start(accepted.map(message => batch(message.id, message.text))));
        return { value: sent.value, messages: sent.messages.map(message => batch(message.id, message.text)) };
      },
    },
  });
  const iterator = loop.run({ sessionId: "private", turnId: "inspect-turn", messages: [human], maxTurns: 3, onDurableMessage: async message => {
    durable.push(structuredClone(message));
    if (message.content.some(block => block.type === "tool_result" && block.toolCallId === "inspect-call")) {
      assert.ok(inspected && pending);
      const deletion = await runtime.deleteMessage({ action: "runtime_message_delete", sessionKey: actor.sessionKey, activationId: actor.activationId,
        stopVersion: actor.stopVersion, participantId: actor.participantId, messageId: pending.id });
      assert.equal(deletion.deleted, true); removed = true;
    }
  } });
  while (!(await iterator.next()).done) {}
  assert.equal(inspected, true); assert.equal(removed, true); assert.equal(requests.length, 2);
  assert.ok(durable.some(message => message.content.some(block => block.type === "tool_result" && block.toolCallId === "inspect-call")));
  assert.match(JSON.stringify({ requests, durable, auxiliary }), new RegExp(secret));
  const stored = (await runtime.get(actor.sessionKey)).activation!;
  assert.equal(stored.messages.find(message => message.id === pending!.id)?.status, "deleted");
  assert.ok(stored.dispatches?.every(dispatch => !dispatch.messageIds.includes(pending!.id)));
});
