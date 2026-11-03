import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type { AgentSession } from "../../src/agent/session/AgentSession.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import { TeamRuntime } from "../../src/team/TeamRuntime.js";
import type { AgentProfile, TeamDefinition } from "../../src/team/types.js";

const finalResult = (turnId: string): AgentTurnResult => ({ type: "success", sessionId: "leader-session", turnId, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "", completedAt: "", finalMessage: { role: "assistant", content: [{ type: "text", text: "formal answer" }] } });

for (const failAfterCompletion of [false, true]) {
  test(`settled fallback releases the Team human execution after ${failAfterCompletion ? "completion storage failure" : "transcript failure before final event"}`, async t => {
    const home = await mkdtemp(join(tmpdir(), "team-turn-settled-"));
    const profile: AgentProfile = { id: "leader", role: "leader", createdAt: "", updatedAt: "", config: { displayName: "Leader", description: "", systemPrompt: "", model: { mode: "model", provider: "test", model: "test" }, workspace: { mode: "team" }, capabilities: { tools: [], skills: [], mcpServers: [] }, permissionMode: "default" } };
    const worker: AgentProfile = { ...profile, id: "worker", role: "teammate" };
    const team: TeamDefinition = { id: "team", createdAt: "", updatedAt: "", leader: profile, teammates: [worker], config: { displayName: "Team", description: "", instructions: "", defaultProjectKey: "/tmp/project", leader: { id: profile.id }, teammates: [{ id: worker.id }] } };
    const runtime = new TeamRuntime({ pilotHome: home, resolveTeam: async () => team, probe: async () => ({ projectKey: "/tmp/project", participants: [profile, worker].map(profile => ({ id: profile.id, role: profile.role, profile, projectKey: "/tmp/project", model: { mode: "model", provider: "test", model: "test" }, capabilities: profile.config.capabilities })), issues: [], environmentFingerprint: "controlled" }), isLeaderBusy: () => false, executeParticipant: async () => ({}) });
    const activation = (await runtime.select({ action: "runtime_select", sessionKey: "leader-session", team: { id: team.id }, requestToken: "select" })).activation!;
    const actor = { sessionKey: activation.sessionKey, activationId: activation.id, participantId: profile.id, stopVersion: activation.stopVersion };
    const session = {
      async *submit(_input: unknown, options: { turnId: string }): AsyncGenerator<AgentEvent> {
        yield { type: "input_accepted", sessionId: activation.sessionKey, turnId: options.turnId, messages: [] };
        if (!failAfterCompletion) throw new Error("transcript durable append failed");
        yield { type: "turn_completed", sessionId: activation.sessionKey, turnId: options.turnId, result: finalResult(options.turnId) };
      },
      snapshot: () => ({ sessionId: activation.sessionKey, status: "idle", messages: [], usage: {}, permissionDenials: [] }),
      abort() {},
    } as unknown as AgentSession;
    const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
    t.after(async () => { router.shutdown(); await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
    let settled = 0;
    const gateway = new InProcessGateway(router, {
      prepareTurn: async input => { await runtime.beginTurn(actor, { turnId: input.runId!, trigger: "human" }); return { input }; },
      onAgentEvent: async (_sessionKey, event) => { if (event.type === "turn_completed") throw new Error("Team final record write failed"); },
      onTurnSettled: async ({ runId, error }) => { settled += 1; await runtime.endTurn(actor, runId, undefined, error); },
    });
    const events: GatewayEvent[] = [];
    for await (const event of gateway.submitTurn({ sessionKey: activation.sessionKey, channelKey: "web", message: "work", runId: "failed-human" })) events.push(event);
    const failed = (await runtime.get(activation.sessionKey)).activation!.turns!.find(turn => turn.turnId === "failed-human")!;
    assert.equal(settled, 1);
    assert.equal(failed.status, "ended");
    assert.equal(failed.resultType, "error");
    assert.match(failed.error!, failAfterCompletion ? /final record write failed/ : /durable append failed/);
    assert.equal(router.hasActiveTurn(activation.sessionKey), false);
    assert.ok(events.some(event => event.type === "error"));
    await runtime.beginTurn(actor, { turnId: "next-human", trigger: "human" });
    await runtime.endTurn(actor, "next-human", finalResult("next-human"));
    await runtime.endTurn(actor, "next-human", undefined, "duplicate fallback");
    const next = (await runtime.get(activation.sessionKey)).activation!.turns!.find(turn => turn.turnId === "next-human")!;
    assert.equal(next.resultType, "success");
    assert.equal(next.error, undefined);
  });
}
