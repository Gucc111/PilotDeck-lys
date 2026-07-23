import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TeamProgressStore } from "../../src/agent/team/TeamProgressStore.js";
import { TeammateSessionRuntime } from "../../src/agent/team/TeammateSessionRuntime.js";
import { createTeamProgressTool } from "../../src/tool/builtin/teamProgress.js";
import { getTeamModeViolation } from "../../src/tool/teamModeConstraints.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import type { PilotDeckTeamRuntimeApi } from "../../src/tool/protocol/types.js";

function context(team: PilotDeckTeamRuntimeApi) {
  return {
    sessionId: "leader",
    turnId: "turn-1",
    cwd: "/tmp",
    runMode: "team" as const,
    permissionMode: "bypassPermissions" as const,
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
  assert.equal(merged.items[0]?.content, "Inspect runtime");
  assert.equal(merged.summary, "Started");
  assert.match(await readFile(path, "utf8"), /Runtime inspected/);
});

test("team_progress delegates persistence to the session team API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-team-tool-"));
  const store = new TeamProgressStore({ path: join(dir, "progress.json") });
  const team: PilotDeckTeamRuntimeApi = {
    listDefinitions: () => [],
    readProgress: () => store.read(),
    updateProgress: (input) => store.update(input),
    delegate: async () => {
      throw new Error("not used");
    },
  };

  const result = await createTeamProgressTool().execute({
    items: [{ id: "task-a", content: "Delegate work", status: "pending" }],
  }, context(team));

  assert.equal(result.data?.items[0]?.id, "task-a");
  assert.equal((await store.read()).items.length, 1);
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
    readProgress: async () => ({ version: 1, items: [], updatedAt: new Date().toISOString() }),
    updateProgress: async () => ({ version: 1, items: [], updatedAt: new Date().toISOString() }),
    delegate: async () => {
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
  const runtime = new TeammateSessionRuntime({
    leaderSessionId: "leader-1",
    projectRoot: dir,
    progressPath: join(dir, "progress.json"),
    definitions: () => [{
      id: "implementer",
      name: "Implementer",
      description: "Implements scoped changes",
      prompt: "Implement carefully.",
      sourcePath: join(dir, "teammates/implementer.md"),
    }],
    diagnostics: () => ["Workspace enablement is invalid."],
    host: {
      run: async (input) => {
        calls.push(`${input.definition.id}:${input.action}:${input.prompt}`);
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
    items: [{ id: "task-1", content: "Implement feature", status: "pending" }],
  });

  await runtime.delegate({
    teammateId: "implementer",
    action: "run",
    prompt: "Implement feature",
    taskId: "task-1",
    parentTurnId: "turn-1",
  });
  await runtime.delegate({
    teammateId: "implementer",
    action: "follow_up",
    prompt: "Add verification",
    parentTurnId: "turn-1",
  });

  assert.deepEqual(calls, [
    "implementer:run:Implement feature",
    "implementer:follow_up:Add verification",
  ]);
  assert.deepEqual(runtime.listDiagnostics(), ["Workspace enablement is invalid."]);
  assert.equal((await runtime.readProgress()).items[0]?.status, "completed");
});
