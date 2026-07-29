import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TeamProgressStore } from "../../src/agent/team/TeamProgressStore.js";
import { TeamControlCoordinator } from "../../src/agent/team/TeamControlCoordinator.js";
import { TeamMessageCoordinator } from "../../src/agent/team/TeamMessageCoordinator.js";
import {
  TeamControlGatewayEscalationAdapter,
  TeamLeaderControlTurnScheduler,
  createTeamPermissionHook,
  createTeamPlanElicitationChannel,
} from "../../src/agent/team/TeamControlChannels.js";
import { GatewayPermissionBus } from "../../src/gateway/permission/GatewayPermissionBus.js";
import { GatewayElicitationBus } from "../../src/gateway/elicitation/GatewayElicitationBus.js";
import { TeammateSessionRuntime } from "../../src/agent/team/TeammateSessionRuntime.js";
import { createDelegateToTeammateTool } from "../../src/tool/builtin/delegateToTeammate.js";
import { createSendTeamMessageTool } from "../../src/tool/builtin/sendTeamMessage.js";
import { createTeamProgressTool } from "../../src/tool/builtin/teamProgress.js";
import { getTeamModeViolation } from "../../src/tool/teamModeConstraints.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import type {
  PilotDeckTeamControlRequest,
  PilotDeckTeamRuntimeApi,
} from "../../src/tool/protocol/types.js";

function context(team: PilotDeckTeamRuntimeApi) {
  return {
    sessionId: "leader",
    turnId: "turn-1",
    cwd: "/tmp",
    runMode: "team" as const,
    permissionMode: "bypassPermissions" as const,
    basePermissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd: "/tmp",
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    team,
  };
}

test("TeamProgressStore persists and merges structured progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-"));
  const path = join(dir, "progress.json");
  let tick = 0;
  const store = new TeamProgressStore({
    path,
    now: () => new Date(`2026-07-22T00:00:0${tick++}.000Z`),
  });

  await store.update({
    items: [{ id: "task-a", content: "Inspect runtime", status: "in_progress", teammateId: "researcher" }],
    summary: "Started",
  });
  const merged = await store.update({
    merge: true,
    items: [{ id: "task-a", status: "completed", summary: "Runtime inspected" }],
  });

  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0]?.status, "completed");
  assert.equal(merged.items[0]?.subject, "Inspect runtime");
  assert.equal(merged.summary, "Started");
  assert.match(await readFile(path, "utf8"), /Runtime inspected/);
  await store.update({
    merge: true,
    items: [{
      id: "task-b",
      subject: "Use runtime findings",
      blockedBy: ["task-a", "missing-task"],
    }],
  });
  assert.deepEqual(
    (await store.list()).items.find((item) => item.id === "task-b")?.blockedBy,
    ["missing-task"],
  );
});

test("team_progress delegates persistence to the session team API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-tool-"));
  const store = new TeamProgressStore({ path: join(dir, "progress.json") });
  const team: PilotDeckTeamRuntimeApi = {
    listDefinitions: () => [],
    readProgress: () => store.read(),
    updateProgress: (input) => store.update(input),
    listControlRequests: async () => [],
    readControlRequest: async () => undefined,
    controlRequest: async () => {
      throw new Error("not used");
    },
    delegate: async () => {
      throw new Error("not used");
    },
    sendMessage: async () => {
      throw new Error("not used");
    },
  };

  const result = await createTeamProgressTool().execute({
    items: [{ id: "task-a", content: "Delegate work", status: "pending" }],
  }, context(team));

  assert.ok(result.data && "updated" in result.data);
  assert.equal(result.data?.updated[0]?.id, "task-a");
  assert.equal((await store.read()).items.length, 1);

  await store.update({
    merge: true,
    items: [{
      id: "task-a",
      briefing: `Full briefing ${"x".repeat(50_000)}`,
    }],
  });
  const listed = await createTeamProgressTool().execute(
    { action: "list" },
    context(team),
  );
  assert.ok(listed.data && "items" in listed.data);
  assert.equal(JSON.stringify(listed.data).includes("Full briefing"), false);
  assert.ok(JSON.stringify(listed.data).length < 2_000);

  const detail = await createTeamProgressTool().execute(
    { action: "get", taskId: "task-a" },
    context(team),
  );
  assert.ok(detail.data && "task" in detail.data);
  assert.match(detail.data?.task?.briefing ?? "", /Full briefing/);
});

test("TeamProgressStore lazily normalizes v1 content into v2 subject and briefing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-v1-"));
  const path = join(dir, "progress.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    items: [{
      id: "legacy",
      content: "Inspect runtime\n\nRead every implementation detail.",
      status: "pending",
      updatedAt: "2026-07-22T00:00:00.000Z",
    }],
    updatedAt: "2026-07-22T00:00:00.000Z",
  }));
  const store = new TeamProgressStore({ path });
  const snapshot = await store.read();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.items[0]?.subject, "Inspect runtime");
  assert.match(snapshot.items[0]?.briefing ?? "", /implementation detail/);
  assert.equal("briefing" in ((await store.list()).items[0] ?? {}), false);
  assert.match((await store.get("legacy")).task?.briefing ?? "", /implementation detail/);
});

test("delegate_to_teammate passes an internal stable Team permission snapshot", async () => {
  let delegated: Parameters<PilotDeckTeamRuntimeApi["delegate"]>[0] | undefined;
  const team: PilotDeckTeamRuntimeApi = {
    listDefinitions: () => [{ id: "implementer", description: "Implements changes" }],
    readProgress: async () => ({ version: 2, items: [], updatedAt: new Date().toISOString() }),
    updateProgress: async () => ({ version: 2, items: [], updatedAt: new Date().toISOString() }),
    listControlRequests: async () => [],
    readControlRequest: async () => undefined,
    controlRequest: async () => {
      throw new Error("not used");
    },
    delegate: async (input) => {
      delegated = input;
      return {
        teammateId: input.teammateId,
        teammateSessionId: "leader::teammate::implementer",
        action: input.action,
        status: "dispatched",
        summary: "dispatched",
        durationMs: 0,
      };
    },
    sendMessage: async () => {
      throw new Error("not used");
    },
  };
  const baseContext = context(team);
  const runtimeContext = {
    ...baseContext,
    permissionMode: "default" as const,
    basePermissionMode: "bypassPermissions" as const,
    permissionContext: {
      ...baseContext.permissionContext,
      mode: "default" as const,
      rules: {
        ...baseContext.permissionContext.rules,
        deny: [{
          source: "project" as const,
          behavior: "deny" as const,
          toolName: "bash",
        }],
      },
    },
  };

  await createDelegateToTeammateTool().execute({
    teammateId: "implementer",
    action: "run",
    prompt: "Implement the bounded task.",
  }, runtimeContext);

  assert.equal(delegated?.permission.permissionMode, "default");
  assert.equal(delegated?.permission.basePermissionMode, "bypassPermissions");
  assert.deepEqual(delegated?.permission.rules.deny, [{
    source: "project",
    behavior: "deny",
    toolName: "bash",
  }]);
  assert.notEqual(delegated?.permission.rules.deny, runtimeContext.permissionContext.rules.deny);
});

test("Team mode rejects ordinary implementation tools", () => {
  const violation = getTeamModeViolation(createReadFileTool());
  assert.match(violation ?? "", /TEAM_MODE_VIOLATION/);
  assert.match(violation ?? "", /Delegate the work instead/);
});

test("ToolRuntime hard-blocks forged non-Team calls", async () => {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const result = await runtime.execute({
    id: "call-1",
    name: "read_file",
    input: { path: "/tmp/secret" },
  }, context({
    listDefinitions: () => [],
    readProgress: async () => ({ version: 2, items: [], updatedAt: new Date().toISOString() }),
    updateProgress: async () => ({ version: 2, items: [], updatedAt: new Date().toISOString() }),
    listControlRequests: async () => [],
    readControlRequest: async () => undefined,
    controlRequest: async () => {
      throw new Error("not used");
    },
    delegate: async () => {
      throw new Error("not used");
    },
    sendMessage: async () => {
      throw new Error("not used");
    },
  }));

  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "team_mode_violation");
    assert.match(result.error.message, /TEAM_MODE_VIOLATION/);
  }
});

test("TeammateSessionRuntime keeps identity and updates task progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-runtime-"));
  const calls: string[] = [];
  const permission = {
    permissionMode: "bypassPermissions" as const,
    basePermissionMode: "bypassPermissions" as const,
    canPrompt: true,
    rules: { allow: [], deny: [], ask: [] },
  };
  const control = new TeamControlCoordinator({
    path: join(dir, "control.json"),
    leaderSessionId: "leader-1",
  });
  const messages = new TeamMessageCoordinator({
    path: join(dir, "messages.json"),
    leaderSessionId: "leader-1",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new TeammateSessionRuntime({
    leaderSessionId: "leader-1",
    projectRoot: dir,
    progressPath: join(dir, "progress.json"),
    control,
    messages,
    definitions: () => [{
      id: "implementer",
      name: "Implementer",
      description: "Implements scoped changes",
      prompt: "Implement carefully.",
      tools: [],
      sourcePath: join(dir, "teammates/implementer.md"),
      constraints: { allow: [], deny: [] },
      canonicalWorkspace: dir,
      workspaceBindingRevision: "revision",
      workspaceBindingFingerprint: "fingerprint",
      activeProjectRoot: dir,
    }],
    diagnostics: () => ["Workspace enablement is invalid."],
    host: {
      run: async (input) => {
        calls.push(`${input.definition.id}:${input.action}:${input.prompt}`);
        assert.equal(input.permission.permissionMode, "bypassPermissions");
        await gate;
        return {
          teammateId: input.definition.id,
          teammateSessionId: "leader-1::teammate::implementer",
          action: input.action,
          taskId: input.taskId,
          status: "completed",
          summary: "done",
          durationMs: 1,
        };
      },
      shutdown: async () => ({
        teammateId: "implementer",
        teammateSessionId: "leader-1::teammate::implementer",
        action: "shutdown",
        status: "shutdown",
        summary: "stopped",
        durationMs: 0,
      }),
    },
  });
  await runtime.updateProgress({
    items: [{ id: "task-1", subject: "Implement feature", status: "pending" }],
  });

  const dispatched = await runtime.delegate({
    teammateId: "implementer",
    action: "run",
    prompt: "Implement feature with full verification and evidence.",
    taskId: "task-1",
    parentTurnId: "turn-1",
    permission,
  });
  assert.equal(dispatched.status, "dispatched");
  await assert.rejects(
    runtime.delegate({
      teammateId: "implementer",
      action: "follow_up",
      prompt: "Add verification",
      parentTurnId: "turn-1",
      permission,
    }),
    /already running/,
  );
  release();
  await waitFor(async () => (await runtime.readProgress()).items[0]?.status === "completed");

  assert.deepEqual(calls, ["implementer:run:Implement feature with full verification and evidence."]);
  assert.deepEqual(runtime.listDiagnostics(), ["Workspace enablement is invalid."]);
  assert.equal((await runtime.readProgress()).items[0]?.status, "completed");
  assert.equal((await runtime.readProgress()).items[0]?.subject, "Implement feature");
  assert.equal(
    (await runtime.readProgress()).items[0]?.briefing,
    "Implement feature with full verification and evidence.",
  );
});

test("TeammateSessionRuntime can dispatch fresh sessions while sharing leader progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-fresh-runtime-"));
  const progressPath = join(dir, "progress.json");
  const permission = {
    permissionMode: "bypassPermissions" as const,
    basePermissionMode: "bypassPermissions" as const,
    canPrompt: true,
    rules: { allow: [], deny: [], ask: [] },
  };
  let sessionCounter = 0;
  const seenSessions: string[] = [];
  const messages = new TeamMessageCoordinator({
    path: join(dir, "messages.json"),
    leaderSessionId: "leader-1",
  });
  const runtime = new TeammateSessionRuntime({
    leaderSessionId: "leader-1",
    projectRoot: dir,
    progressPath,
    control: new TeamControlCoordinator({
      path: join(dir, "control.json"),
      leaderSessionId: "leader-1",
    }),
    messages,
    resolveTeammateSessionId: ({ definition }) =>
      `leader-1::teammate::${definition.id}::delegation::${++sessionCounter}`,
    definitions: () => [{
      id: "implementer",
      name: "Implementer",
      description: "Implements scoped changes",
      prompt: "Implement carefully.",
      contextPolicy: "fresh_per_delegation",
      tools: [],
      sourcePath: join(dir, "teammates/implementer.md"),
      constraints: { allow: [], deny: [] },
      canonicalWorkspace: dir,
      workspaceBindingRevision: "revision",
      workspaceBindingFingerprint: "fingerprint",
      activeProjectRoot: dir,
    }],
    host: {
      run: async (input) => {
        seenSessions.push(input.teammateSessionId);
        return {
          teammateId: input.definition.id,
          teammateSessionId: input.teammateSessionId,
          action: input.action,
          taskId: input.taskId,
          status: "completed",
          summary: "done",
          durationMs: 1,
        };
      },
      shutdown: async () => {
        throw new Error("not used");
      },
    },
  });

  const first = await runtime.delegate({
    teammateId: "implementer",
    action: "run",
    prompt: "Implement feature A.",
    taskId: "task-a",
    parentTurnId: "turn-1",
    permission,
  });
  await waitFor(async () => (await runtime.readProgress()).items.some((item) =>
    item.id === "task-a" && item.status === "completed"));
  const second = await runtime.delegate({
    teammateId: "implementer",
    action: "run",
    prompt: "Implement feature B.",
    taskId: "task-b",
    parentTurnId: "turn-2",
    permission,
  });
  await waitFor(async () => (await runtime.readProgress()).items.some((item) =>
    item.id === "task-b" && item.status === "completed"));

  assert.notEqual(first.teammateSessionId, second.teammateSessionId);
  assert.deepEqual(seenSessions, [first.teammateSessionId, second.teammateSessionId]);
  const progress = await new TeamProgressStore({ path: progressPath }).list();
  assert.equal(progress.items.length, 2);
  assert.equal(progress.counts.completed, 2);
  const idleSessions = (await messages.listPending({
    role: "leader",
    id: "leader",
    sessionId: "leader-1",
  })).map((message) => message.from.sessionId);
  assert.ok(idleSessions.includes(first.teammateSessionId));
  assert.ok(idleSessions.includes(second.teammateSessionId));
});

test("two Teammates emit one explicit report and one idle lifecycle each with compact progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-two-teammates-"));
  const permission = {
    permissionMode: "bypassPermissions" as const,
    basePermissionMode: "bypassPermissions" as const,
    canPrompt: true,
    rules: { allow: [], deny: [], ask: [] },
  };
  const progressPath = join(dir, "progress.json");
  const messages = new TeamMessageCoordinator({
    path: join(dir, "messages.json"),
    leaderSessionId: "leader-1",
  });
  const definitions = ["researcher", "reviewer"].map((id) => ({
    id,
    name: id,
    description: `${id} role`,
    prompt: `${id} prompt`,
    tools: [],
    sourcePath: join(dir, `teammates/${id}.md`),
    constraints: { allow: [], deny: [] },
    canonicalWorkspace: dir,
    workspaceBindingRevision: "revision",
    workspaceBindingFingerprint: `fingerprint-${id}`,
    activeProjectRoot: dir,
  }));
  const runtime = new TeammateSessionRuntime({
    leaderSessionId: "leader-1",
    projectRoot: dir,
    progressPath,
    control: new TeamControlCoordinator({
      path: join(dir, "control.json"),
      leaderSessionId: "leader-1",
    }),
    messages,
    definitions: () => definitions,
    host: {
      run: async (input) => {
        await messages.enqueue({
          from: {
            role: "teammate",
            id: input.definition.id,
            sessionId: `leader-1::teammate::${input.definition.id}`,
          },
          to: { role: "leader", id: "leader", sessionId: "leader-1" },
          kind: "explicit",
          text: `${input.definition.id} evidence`,
          taskId: input.taskId,
        });
        return {
          teammateId: input.definition.id,
          teammateSessionId: `leader-1::teammate::${input.definition.id}`,
          action: input.action,
          taskId: input.taskId,
          status: "completed",
          summary: "plain final text is not forwarded",
          durationMs: 1,
        };
      },
      shutdown: async () => {
        throw new Error("not used");
      },
    },
  });
  const longBriefing = `Bounded assignment\n${"detail ".repeat(10_000)}`;
  await Promise.all(definitions.map((definition, index) => runtime.delegate({
    teammateId: definition.id,
    action: "run",
    prompt: longBriefing,
    taskId: `task-${index + 1}`,
    parentTurnId: "turn-1",
    toolCallId: `tool-${index + 1}`,
    permission,
  })));
  await waitFor(async () =>
    (await runtime.readProgress()).items.every((item) => item.status === "completed"));

  const pending = await messages.listPending({
    role: "leader",
    id: "leader",
    sessionId: "leader-1",
  });
  assert.equal(pending.filter((message) => message.kind === "explicit").length, 2);
  assert.equal(pending.filter((message) => message.kind === "idle").length, 2);
  assert.equal(pending.some((message) => message.kind === "completion"), false);
  const compact = await new TeamProgressStore({ path: progressPath }).list();
  assert.equal(JSON.stringify(compact).includes("detail detail"), false);
  assert.ok(JSON.stringify(compact).length < 2_000);
});

test("TeamControlCoordinator persists and resolves permission and plan requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-control-"));
  const path = join(dir, "control.json");
  let id = 0;
  const coordinator = new TeamControlCoordinator({
    path,
    leaderSessionId: "leader-1",
    uuid: () => `request-${++id}`,
  });

  const permissionPromise = coordinator.requestPermission({
    teammateId: "implementer",
    teammateSessionId: "teammate-session",
    toolCallId: "tool-1",
    toolName: "write_file",
    toolInput: { path: "a.ts" },
  });
  await waitFor(async () => (await coordinator.list({ status: "pending" })).length === 1);
  await coordinator.decide({ requestId: "request-1", action: "allow_once" });
  assert.deepEqual(await permissionPromise, { action: "allow_once" });
  assert.equal((await coordinator.read("request-1"))?.status, "resolved");

  const planPromise = coordinator.requestPlan({
    teammateId: "implementer",
    teammateSessionId: "teammate-session",
    toolCallId: "tool-2",
    plan: "# Plan",
    planFilePath: join(dir, "plan.md"),
  });
  await waitFor(async () => Boolean(await coordinator.read("request-2")));
  await coordinator.escalate("request-2", "Needs product choice");
  assert.equal((await coordinator.read("request-2"))?.status, "escalated");
  await coordinator.decide({
    requestId: "request-2",
    action: "request_revision",
    feedback: "Add rollback steps.",
  });
  assert.deepEqual(await planPromise, {
    action: "request_revision",
    feedback: "Add rollback steps.",
  });
  assert.match(await readFile(path, "utf8"), /"status": "resolved"/);
});

test("Team control channels park teammate permission and plan requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-channels-"));
  let id = 0;
  const coordinator = new TeamControlCoordinator({
    path: join(dir, "control.json"),
    leaderSessionId: "leader-1",
    uuid: () => `channel-${++id}`,
  });
  const permissionHook = createTeamPermissionHook({
    coordinator,
    teammateId: "implementer",
    teammateSessionId: "teammate-session",
  });
  const permissionOutputPromise = permissionHook({
    hookInput: {
      hookEventName: "PermissionRequest",
      sessionId: "teammate-session",
      transcriptPath: "",
      cwd: dir,
      toolName: "bash",
      toolUseId: "tool-1",
      toolInput: { command: "npm test" },
    },
  });
  await waitFor(async () => Boolean(await coordinator.read("channel-1")));
  await coordinator.decide({
    requestId: "channel-1",
    action: "deny",
    feedback: "Use the targeted test instead.",
  });
  const permissionOutput = await permissionOutputPromise;
  assert.equal(
    (permissionOutput as { specific?: { decision?: { behavior?: string } } }).specific?.decision?.behavior,
    "deny",
  );

  const planChannel = createTeamPlanElicitationChannel({
    coordinator,
    teammateId: "implementer",
    teammateSessionId: "teammate-session",
  });
  const planAnswerPromise = planChannel.askUser({
    toolCallId: "tool-2",
    toolName: "exit_plan_mode",
    questions: [{ question: "What should happen next?", header: "Plan", options: [] }],
    metadata: {
      source: "exit_plan_mode",
      plan: "# Implement safely",
      planFilePath: join(dir, "plan.md"),
    },
  });
  await waitFor(async () => Boolean(await coordinator.read("channel-2")));
  await coordinator.decide({ requestId: "channel-2", action: "approve_plan" });
  assert.deepEqual(await planAnswerPromise, {
    type: "answered",
    answers: { "What should happen next?": "execute_plan" },
  });
});

test("Team Leader control scheduler consumes busy streams and preserves serial order", async () => {
  const submissions: Array<{ requestId: string; consumed: boolean }> = [];
  let sawSyntheticControlMessage = false;
  let attempt = 0;
  const scheduler = new TeamLeaderControlTurnScheduler({
    leaderSessionId: "leader-1",
    projectRoot: "/workspace",
    busyBackoffMs: [0],
    sleep: async () => {},
    submitTurn: (input) => {
      assert.equal(input.message, "");
      sawSyntheticControlMessage ||= input.syntheticMessages?.[0]?.purpose === "team_control_request";
      const controlText = input.syntheticMessages?.[0]?.text ?? input.message;
      const parsed = JSON.parse(controlText.split("\n")[1]!) as { requestId: string };
      const currentAttempt = ++attempt;
      return (async function* () {
        if (currentAttempt === 1) {
          yield { type: "agent_status", event: "session_busy" } as const;
          submissions.push({ requestId: parsed.requestId, consumed: false });
          yield { type: "error", code: "session_busy", message: "busy", recoverable: true } as const;
          submissions[submissions.length - 1]!.consumed = true;
          return;
        }
        submissions.push({ requestId: parsed.requestId, consumed: true });
        yield { type: "turn_completed", usage: {}, finishReason: "completed" } as const;
      })();
    },
  });

  scheduler.enqueue(controlRequest("request-1", "permission"));
  scheduler.enqueue(controlRequest("request-2", "plan"));
  await waitFor(async () => submissions.length === 3);

  assert.deepEqual(
    submissions,
    [
      { requestId: "request-1", consumed: true },
      { requestId: "request-1", consumed: true },
      { requestId: "request-2", consumed: true },
    ],
  );
  assert.equal(sawSyntheticControlMessage, true);
});

test("Team Gateway escalation adapter binds permission metadata and resumes teammate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-escalation-"));
  const permissionBus = new GatewayPermissionBus();
  const elicitationBus = new GatewayElicitationBus();
  let emitted: Parameters<TeamControlGatewayEscalationAdapter["handle"]>[0] | undefined;
  let permissionEvent: {
    requestId: string;
    metadata?: Record<string, unknown>;
  } | undefined;
  const coordinator = new TeamControlCoordinator({
    path: join(dir, "control.json"),
    leaderSessionId: "leader-1",
    uuid: () => "control-1",
  });
  const resolutionPromise = coordinator.requestPermission({
    teammateId: "implementer",
    teammateSessionId: "teammate-session",
    taskId: "task-1",
    toolCallId: "tool-1",
    toolName: "bash",
    toolInput: { command: "npm test" },
  });
  await waitFor(async () => Boolean(await coordinator.read("control-1")));
  emitted = await coordinator.escalate("control-1", "Needs user approval");
  const adapter = new TeamControlGatewayEscalationAdapter({
    coordinator,
    leaderSessionId: "leader-1",
    permissionBus,
    elicitationBus,
    uuid: () => "gateway-permission-1",
    emit: (event) => {
      if (event.type === "permission_request") permissionEvent = event;
      return true;
    },
  });
  const handling = adapter.handle(emitted);
  await waitFor(async () => permissionBus.hasPending("leader-1", "gateway-permission-1"));
  permissionBus.consume("leader-1", "gateway-permission-1")?.resolve({
    requestId: "gateway-permission-1",
    decision: "allow",
  });

  await handling;
  assert.deepEqual(await resolutionPromise, { action: "allow_once" });
  assert.deepEqual(permissionEvent?.metadata, {
    originSessionKey: "teammate-session",
    teammateId: "implementer",
    taskId: "task-1",
    controlRequestId: "control-1",
  });
});

test("Team Gateway escalation adapter cancels a plan when no Leader sink exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-plan-escalation-"));
  const coordinator = new TeamControlCoordinator({
    path: join(dir, "control.json"),
    leaderSessionId: "leader-1",
    uuid: () => "plan-control-1",
  });
  const resolutionPromise = coordinator.requestPlan({
    teammateId: "planner",
    teammateSessionId: "planner-session",
    toolCallId: "tool-plan",
    plan: "# Plan",
  });
  await waitFor(async () => Boolean(await coordinator.read("plan-control-1")));
  const request = await coordinator.escalate("plan-control-1");
  let planMetadata: Record<string, unknown> | undefined;
  await new TeamControlGatewayEscalationAdapter({
    coordinator,
    leaderSessionId: "leader-1",
    permissionBus: new GatewayPermissionBus(),
    elicitationBus: new GatewayElicitationBus(),
    uuid: () => "gateway-plan-1",
    emit: (event) => {
      if (event.type === "elicitation_request") planMetadata = event.metadata;
      return false;
    },
  }).handle(request);

  assert.deepEqual(await resolutionPromise, {
    action: "cancelled",
    reason: "Leader has no active event sink.",
  });
  assert.equal(planMetadata?.originSessionKey, "planner-session");
  assert.equal(planMetadata?.teammateId, "planner");
  assert.equal(planMetadata?.controlRequestId, "plan-control-1");
  assert.equal((await coordinator.read("plan-control-1"))?.status, "cancelled");
});

test("TeamControlCoordinator cancels restart-orphaned requests and refuses stale decisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-recovery-"));
  const path = join(dir, "control.json");
  const stale = controlRequest("stale-1", "permission");
  await writeFile(path, `${JSON.stringify({
    version: 1,
    requests: [stale],
    updatedAt: stale.updatedAt,
  })}\n`, "utf8");
  const coordinator = new TeamControlCoordinator({
    path,
    leaderSessionId: "leader-1",
  });

  assert.equal(await coordinator.reconcile(), 1);
  assert.equal((await coordinator.read("stale-1"))?.status, "cancelled");
  await assert.rejects(
    coordinator.decide({ requestId: "stale-1", action: "allow_once" }),
    /no active waiter/,
  );
  assert.equal((await coordinator.read("stale-1"))?.status, "cancelled");
});

function controlRequest(
  id: string,
  kind: PilotDeckTeamControlRequest["kind"],
): PilotDeckTeamControlRequest {
  const timestamp = "2026-07-24T00:00:00.000Z";
  return {
    id,
    kind,
    status: "pending",
    leaderSessionId: "leader-1",
    teammateId: "implementer",
    teammateSessionId: "teammate-session",
    toolCallId: `tool-${id}`,
    toolName: kind === "permission" ? "bash" : "exit_plan_mode",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(kind === "permission"
      ? { permission: { input: { command: "npm test" } } }
      : { plan: { content: "# Plan" } }),
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
