import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TeamControlCoordinator } from "../../src/agent/team/TeamControlCoordinator.js";
import { TeamMessageCoordinator } from "../../src/agent/team/TeamMessageCoordinator.js";
import {
  TeamMessageDeliveryScheduler,
  PermanentTeamMessageDeliveryError,
  buildLeaderMessageTurnInput,
  submitLeaderTeamMessages,
} from "../../src/agent/team/TeamMessageChannels.js";
import { TeammateSessionRuntime } from "../../src/agent/team/TeammateSessionRuntime.js";
import { createSendTeamMessageTool } from "../../src/tool/builtin/sendTeamMessage.js";
import type {
  PilotDeckTeamRuntimeApi,
  PilotDeckTeamSendMessageResult,
} from "../../src/tool/protocol/types.js";

const permission = {
  permissionMode: "bypassPermissions" as const,
  basePermissionMode: "bypassPermissions" as const,
  canPrompt: true,
  rules: { allow: [], deny: [], ask: [] },
};

test("TeamMessageCoordinator persists concurrent messages and reconciles pending delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-message-store-"));
  const path = join(dir, "messages.json");
  let sequence = 0;
  const coordinator = new TeamMessageCoordinator({
    path,
    leaderSessionId: "leader-1",
    uuid: () => `message-${++sequence}`,
  });
  const leader = { role: "leader" as const, id: "leader" as const, sessionId: "leader-1" };
  const teammate = {
    role: "teammate" as const,
    id: "implementer",
    sessionId: "leader-1::teammate::implementer",
  };

  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    coordinator.enqueue({
      from: leader,
      to: teammate,
      kind: "explicit",
      text: `message ${index}`,
      permission,
    })));
  const pending = await coordinator.listPending(teammate);
  assert.equal(pending.length, 8);
  assert.equal(pending[0]?.permission?.permissionMode, "bypassPermissions");

  const reconciled: string[] = [];
  const resumed = new TeamMessageCoordinator({
    path,
    leaderSessionId: "leader-1",
    onPending: (message) => reconciled.push(message.id),
  });
  await resumed.reconcile();
  assert.equal(new Set(reconciled).size, 8);
});

test("TeamMessageCoordinator stores one idle message per lifecycleId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-lifecycle-"));
  const coordinator = new TeamMessageCoordinator({
    path: join(dir, "messages.json"),
    leaderSessionId: "leader-1",
  });
  const message = {
    from: {
      role: "teammate" as const,
      id: "implementer",
      sessionId: "leader-1::teammate::implementer",
    },
    to: { role: "leader" as const, id: "leader" as const, sessionId: "leader-1" },
    kind: "idle" as const,
    text: 'Teammate "implementer" is idle.',
    lifecycleId: "lifecycle-1",
    lifecycleStatus: "available" as const,
  };
  await Promise.all([coordinator.enqueue(message), coordinator.enqueue(message)]);
  const pending = await coordinator.listPending(message.to);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, "lifecycle-1");
});

test("TeamMessageCoordinator keeps legacy completion messages readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-legacy-message-"));
  const path = join(dir, "messages.json");
  const leader = { role: "leader" as const, id: "leader" as const, sessionId: "leader-1" };
  await writeFile(path, JSON.stringify({
    version: 1,
    messages: [{
      id: "legacy-completion",
      leaderSessionId: "leader-1",
      from: {
        role: "teammate",
        id: "implementer",
        sessionId: "leader-1::teammate::implementer",
      },
      to: leader,
      kind: "completion",
      text: "Legacy report",
      status: "pending",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    }],
    updatedAt: "2026-07-24T00:00:00.000Z",
  }));
  const coordinator = new TeamMessageCoordinator({
    path,
    leaderSessionId: "leader-1",
  });
  const pending = await coordinator.listPending(leader);
  assert.equal(pending[0]?.kind, "completion");
  assert.equal(pending[0]?.text, "Legacy report");
});

test("TeamMessageDeliveryScheduler retries busy recipients and marks a batch delivered once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-message-delivery-"));
  let scheduler: TeamMessageDeliveryScheduler | undefined;
  const coordinator = new TeamMessageCoordinator({
    path: join(dir, "messages.json"),
    leaderSessionId: "leader-1",
    uuid: () => "message-1",
    onPending: (message) => scheduler?.enqueue(message),
  });
  const recipient = {
    role: "leader" as const,
    id: "leader" as const,
    sessionId: "leader-1",
  };
  let attempts = 0;
  const delivered: string[] = [];
  scheduler = new TeamMessageDeliveryScheduler({
    recipient,
    coordinator,
    busyBackoffMs: [0],
    sleep: async () => undefined,
    deliver: async () => ++attempts > 1,
    onDelivered: (messages) => {
      delivered.push(...messages.map((message) => message.id));
    },
  });

  await coordinator.enqueue({
    from: {
      role: "teammate",
      id: "implementer",
      sessionId: "leader-1::teammate::implementer",
    },
    to: recipient,
    kind: "explicit",
    text: "Need a decision.",
  });
  await waitFor(async () => (await coordinator.listPending(recipient)).length === 0);
  assert.equal(attempts, 2);
  assert.deepEqual(delivered, ["message-1"]);
});

test("TeamMessageDeliveryScheduler dead-letters permanent recipient errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-message-dead-letter-"));
  const path = join(dir, "messages.json");
  let scheduler: TeamMessageDeliveryScheduler | undefined;
  const coordinator = new TeamMessageCoordinator({
    path,
    leaderSessionId: "leader-1",
    uuid: () => "message-dead",
    onPending: (message) => scheduler?.enqueue(message),
  });
  const recipient = {
    role: "teammate" as const,
    id: "removed",
    sessionId: "leader-1::teammate::removed",
  };
  let failures = 0;
  scheduler = new TeamMessageDeliveryScheduler({
    recipient,
    coordinator,
    deliver: async () => {
      throw new PermanentTeamMessageDeliveryError('Unknown Teammate "removed".');
    },
    onFailed: () => {
      failures += 1;
    },
  });

  await coordinator.enqueue({
    from: { role: "leader", id: "leader", sessionId: "leader-1" },
    to: recipient,
    kind: "explicit",
    text: "Are you still available?",
    permission,
  });
  await waitFor(async () => (await coordinator.listPending(recipient)).length === 0);
  const snapshot = JSON.parse(await readFile(path, "utf8")) as {
    messages: Array<{ status: string; failureReason?: string }>;
  };
  assert.equal(failures, 1);
  assert.equal(snapshot.messages[0]?.status, "failed");
  assert.match(snapshot.messages[0]?.failureReason ?? "", /Unknown Teammate/);
});

test("send_team_message delegates plain text without mutating task progress", async () => {
  let sent: Parameters<PilotDeckTeamRuntimeApi["sendMessage"]>[0] | undefined;
  let progressUpdates = 0;
  const resultTemplate: PilotDeckTeamSendMessageResult = {
    messageId: "message-1",
    from: { role: "leader", id: "leader", sessionId: "leader-1" },
    to: {
      role: "teammate",
      id: "implementer",
      sessionId: "leader-1::teammate::implementer",
    },
    status: "queued",
  };
  const team: PilotDeckTeamRuntimeApi = {
    listDefinitions: () => [{ id: "implementer", description: "Implements changes" }],
    readProgress: async () => ({ version: 2, items: [], updatedAt: new Date().toISOString() }),
    updateProgress: async () => {
      progressUpdates += 1;
      return { version: 2, items: [], updatedAt: new Date().toISOString() };
    },
    listControlRequests: async () => [],
    readControlRequest: async () => undefined,
    controlRequest: async () => {
      throw new Error("not used");
    },
    delegate: async () => {
      throw new Error("not used");
    },
    sendMessage: async (input) => {
      sent = input;
      return resultTemplate;
    },
  };

  const output = await createSendTeamMessageTool().execute({
    to: "implementer",
    message: "Please verify the API contract.",
    summary: "Verify contract",
  }, toolContext(team, "team"));
  assert.equal(output.data?.messageId, "message-1");
  assert.equal(sent?.to, "implementer");
  assert.equal(sent?.message, "Please verify the API contract.");
  assert.equal(progressUpdates, 0);
});

test("TeammateSessionRuntime enforces message direction and reports idle lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-message-runtime-"));
  const pending: string[] = [];
  const messages = new TeamMessageCoordinator({
    path: join(dir, "messages.json"),
    leaderSessionId: "leader-1",
    onPending: (message) => pending.push(`${message.kind}:${message.from.id}:${message.to.id}`),
  });
  const runtime = new TeammateSessionRuntime({
    leaderSessionId: "leader-1",
    projectRoot: dir,
    progressPath: join(dir, "progress.json"),
    control: new TeamControlCoordinator({
      path: join(dir, "control.json"),
      leaderSessionId: "leader-1",
    }),
    messages,
    definitions: () => [{
      id: "implementer",
      name: "Implementer",
      description: "Implements changes",
      prompt: "Implement carefully.",
      tools: [],
      sourcePath: join(dir, "teammates/implementer.md"),
    }],
    host: {
      run: async (input) => ({
        teammateId: input.definition.id,
        teammateSessionId: "leader-1::teammate::implementer",
        action: input.action,
        taskId: input.taskId,
        status: "completed",
        summary: "Implementation complete.",
        durationMs: 1,
      }),
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

  await runtime.sendMessage({
    to: "implementer",
    message: "Check the contract.",
    parentTurnId: "turn-1",
    permission,
  });
  await runtime.delegate({
    teammateId: "implementer",
    action: "run",
    prompt: "Implement the contract.",
    taskId: "task-1",
    parentTurnId: "turn-1",
    permission,
  });
  await waitFor(() => Promise.resolve(pending.includes("idle:implementer:leader")));
  assert.ok(pending.includes("explicit:leader:implementer"));

  const teammateRuntime = new TeammateSessionRuntime({
    leaderSessionId: "leader-1",
    actorTeammateId: "implementer",
    projectRoot: dir,
    progressPath: join(dir, "progress.json"),
    control: new TeamControlCoordinator({
      path: join(dir, "control.json"),
      leaderSessionId: "leader-1",
    }),
    messages,
    definitions: runtime.listDefinitions as never,
    host: {
      run: async () => {
        throw new Error("not used");
      },
      shutdown: async () => {
        throw new Error("not used");
      },
    },
  });
  await teammateRuntime.sendMessage({
    to: "leader",
    message: "I need a product decision.",
    parentTurnId: "turn-2",
    permission,
  });
  await assert.rejects(
    teammateRuntime.sendMessage({
      to: "other",
      message: "Peer message",
      parentTurnId: "turn-2",
      permission,
    }),
    /only send Team messages to "leader"/,
  );
  assert.ok(pending.includes("explicit:implementer:leader"));
});

test("Leader message turns include teammate reports as synthetic Team context", () => {
  const input = buildLeaderMessageTurnInput({
    leaderSessionId: "leader-1",
    projectRoot: "/tmp/project",
    messages: [{
      id: "message-1",
      leaderSessionId: "leader-1",
      from: {
        role: "teammate",
        id: "reviewer",
        sessionId: "leader-1::teammate::reviewer",
      },
      to: { role: "leader", id: "leader", sessionId: "leader-1" },
      kind: "completion",
      text: "Review complete.",
      status: "pending",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    }],
  });
  assert.equal(input.channelKey, "team_message");
  assert.equal(input.runMode, "team");
  assert.equal(input.syntheticMessages?.[0]?.purpose, "team_message");
  assert.match(input.syntheticMessages?.[0]?.text ?? "", /Review complete/);
});

test("idle lifecycle is transient and separated from explicit Team reports", () => {
  const base = {
    leaderSessionId: "leader-1",
    from: {
      role: "teammate" as const,
      id: "reviewer",
      sessionId: "leader-1::teammate::reviewer",
    },
    to: { role: "leader" as const, id: "leader" as const, sessionId: "leader-1" },
    status: "pending" as const,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
  const input = buildLeaderMessageTurnInput({
    leaderSessionId: "leader-1",
    projectRoot: "/tmp/project",
    messages: [
      {
        ...base,
        id: "report-1",
        kind: "explicit",
        text: "Evidence report.",
      },
      {
        ...base,
        id: "idle-1",
        kind: "idle",
        text: 'Teammate "reviewer" is idle.',
        lifecycleId: "idle-1",
        lifecycleStatus: "available",
      },
    ],
  });
  assert.equal(input.syntheticMessages?.length, 2);
  assert.equal(input.syntheticMessages?.[0]?.purpose, "team_message");
  assert.equal(input.syntheticMessages?.[0]?.transient, undefined);
  assert.equal(input.syntheticMessages?.[1]?.purpose, "team_lifecycle");
  assert.equal(input.syntheticMessages?.[1]?.transient, true);
  assert.doesNotMatch(input.syntheticMessages?.[0]?.text ?? "", /is idle/);
  assert.doesNotMatch(input.syntheticMessages?.[1]?.text ?? "", /Evidence report/);
});

test("Leader message delivery retries non-busy error streams", async () => {
  const delivered = await submitLeaderTeamMessages(async function* () {
    yield {
      type: "error",
      code: "gateway_submit_failed",
      message: "failed",
      recoverable: true,
    };
  }, {
    leaderSessionId: "leader-1",
    projectRoot: "/tmp/project",
    messages: [],
  });
  assert.equal(delivered, false);
});

function toolContext(team: PilotDeckTeamRuntimeApi, runMode: "team" | "agent") {
  return {
    sessionId: runMode === "team" ? "leader-1" : "leader-1::teammate::implementer",
    turnId: "turn-1",
    cwd: "/tmp",
    runMode,
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

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Team message state.");
}
