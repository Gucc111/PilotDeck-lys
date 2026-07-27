import assert from "node:assert/strict";
import test from "node:test";

import { scopeTeammateTools } from "../../src/agent/team/TeammateToolScope.js";
import type { RuntimeTeammateDefinition } from "../../src/agent/team/types.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/protocol/types.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

const INFRASTRUCTURE_TOOLS = [
  "enter_plan_mode",
  "exit_plan_mode",
  "send_team_message",
];

test("empty or missing Teammate tools fail closed to infrastructure tools", () => {
  const registry = createRegistry();
  const empty = scopeTeammateTools(registry, definition([]));
  const missing = scopeTeammateTools(registry, {
    ...definition([]),
    tools: undefined,
  } as unknown as RuntimeTeammateDefinition);

  assert.deepEqual(empty.list().map((tool) => tool.name), INFRASTRUCTURE_TOOLS);
  assert.deepEqual(missing.list().map((tool) => tool.name), INFRASTRUCTURE_TOOLS);
});

test("non-empty Teammate tools retain only configured and infrastructure tools", () => {
  const scoped = scopeTeammateTools(createRegistry(), definition(["read_file"]));

  assert.deepEqual(scoped.list().map((tool) => tool.name), [
    "enter_plan_mode",
    "exit_plan_mode",
    "read_file",
    "send_team_message",
  ]);
});

test("permission allow rules cannot restore a tool removed from the Teammate registry", async () => {
  let executions = 0;
  const source = createRegistry(() => {
    executions += 1;
  });
  const scoped = scopeTeammateTools(source, definition([]));
  const runtime = new ToolRuntime(scoped, new PermissionRuntime());

  const result = await runtime.execute(
    { id: "call-1", name: "bash", input: {} },
    toolContext(),
  );

  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.error.code : undefined, "tool_not_found");
  assert.equal(executions, 0);
});

function definition(tools: string[]): RuntimeTeammateDefinition {
  return {
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews changes",
    prompt: "Review carefully.",
    tools,
    mcpServers: [],
    sourcePath: "/tmp/reviewer.md",
  };
}

function createRegistry(onBashExecute?: () => void): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of [
    "agent",
    "ask_user_question",
    "bash",
    "delegate_to_teammate",
    "enter_plan_mode",
    "exit_plan_mode",
    "read_file",
    "send_team_message",
    "team_progress",
  ]) {
    registry.register(noopTool(name, name === "bash" ? onBashExecute : undefined));
  }
  return registry;
}

function noopTool(
  name: string,
  onExecute?: () => void,
): PilotDeckToolDefinition<Record<string, never>> {
  return {
    name,
    title: name,
    description: name,
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async () => {
      onExecute?.();
      return { content: [{ type: "text", text: "executed" }] };
    },
  };
}

function toolContext(): PilotDeckToolRuntimeContext {
  return {
    sessionId: "teammate-session",
    turnId: "turn-1",
    cwd: "/tmp",
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: "/tmp",
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: {
        allow: [{
          source: "user",
          behavior: "allow",
          toolName: "bash",
        }],
        deny: [],
        ask: [],
      },
    },
  };
}
