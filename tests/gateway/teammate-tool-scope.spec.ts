import assert from "node:assert/strict";
import test from "node:test";

import { scopeTeammateTools } from "../../src/agent/team/TeammateToolScope.js";
import type { RuntimeTeammateDefinition } from "../../src/agent/team/types.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import { LifecycleRuntime } from "../../src/lifecycle/index.js";
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

test("generic mcp capability retains tools only from selected MCP servers", () => {
  const registry = createRegistry();
  registry.register(noopTool("mcp__server-a__read"));
  registry.register(noopTool("mcp__server-b__write"));
  const scoped = scopeTeammateTools(registry, {
    ...definition(["mcp"]),
    mcpServers: ["server-a"],
  });

  assert.ok(scoped.has("mcp__server-a__read"));
  assert.equal(scoped.has("mcp__server-b__write"), false);
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

test("Teammate allow selectors constrain paths against the active checkout", async () => {
  let executions = 0;
  const runtime = new ToolRuntime(createRegistry(() => {
    executions += 1;
  }), new PermissionRuntime());
  const capability = {
    teammateId: "reviewer",
    allow: [{
      version: 2 as const,
      toolName: "read_file",
      conditions: [{
        subject: "read_file.file_path" as const,
        operator: "pathWithin" as const,
        value: "$WORKSPACE",
      }],
    }],
    deny: [],
    activeProjectRoot: "/tmp/active-checkout",
    canonicalWorkspace: "/tmp/canonical-project",
    workspaceBindingRevision: "revision-1",
    workspaceBindingFingerprint: "fingerprint-1",
  };

  const allowed = await runtime.execute(
    {
      id: "call-allowed",
      name: "read_file",
      input: { file_path: "/tmp/active-checkout/src/index.ts" },
    },
    { ...toolContext(), cwd: "/tmp/canonical-project", teammateCapability: capability },
  );
  const rejected = await runtime.execute(
    {
      id: "call-rejected",
      name: "read_file",
      input: { file_path: "/tmp/canonical-project/src/index.ts" },
    },
    { ...toolContext(), cwd: "/tmp/canonical-project", teammateCapability: capability },
  );

  assert.equal(allowed.type, "success");
  assert.equal(rejected.type, "error");
  assert.equal(
    rejected.type === "error" ? rejected.error.code : undefined,
    "teammate_scope_violation",
  );
  assert.equal(executions, 1);
});

test("Teammate deny selectors and allow lists override permission allow and bypass", async () => {
  let executions = 0;
  const lifecycleEvents: string[] = [];
  const runtime = new ToolRuntime(createRegistry(() => {
    executions += 1;
  }), new PermissionRuntime(), new TrackingLifecycleRuntime(lifecycleEvents));
  const baseCapability = {
    teammateId: "reviewer",
    activeProjectRoot: "/tmp/workspace",
    canonicalWorkspace: "/tmp/workspace",
    workspaceBindingRevision: "revision-2",
    workspaceBindingFingerprint: "fingerprint-2",
  };
  const denied = await runtime.execute(
    {
      id: "call-deny",
      name: "bash",
      input: { command: "echo ok && rm -rf build" },
    },
    {
      ...toolContext(),
      teammateCapability: {
        ...baseCapability,
        allow: [],
        deny: [{
          version: 2,
          toolName: "bash",
          conditions: [{
            subject: "bash.command",
            operator: "executableEquals",
            value: "rm",
          }],
        }],
      },
    },
  );
  const deniedWrapped = await runtime.execute(
    {
      id: "call-deny-wrapped",
      name: "bash",
      input: { command: "env -S 'rm -rf build'" },
    },
    {
      ...toolContext(),
      teammateCapability: {
        ...baseCapability,
        allow: [],
        deny: [{
          version: 2,
          toolName: "bash",
          conditions: [{
            subject: "bash.command",
            operator: "executableEquals",
            value: "rm",
          }],
        }],
      },
    },
  );
  const outsideAllow = await runtime.execute(
    {
      id: "call-allow-miss",
      name: "bash",
      input: { command: "npm test && node verify.js" },
    },
    {
      ...toolContext(),
      permissionContext: {
        ...toolContext().permissionContext,
        rules: {
          allow: [{
            source: "session",
            behavior: "allow",
            toolName: "bash",
          }],
          deny: [],
          ask: [],
        },
      },
      teammateCapability: {
        ...baseCapability,
        allow: [{
          version: 2,
          toolName: "bash",
          conditions: [{
            subject: "bash.command",
            operator: "executableEquals",
            value: "npm",
          }],
        }],
        deny: [],
      },
    },
  );

  for (const result of [denied, outsideAllow]) {
    assert.equal(result.type, "error");
    assert.equal(
      result.type === "error" ? result.error.code : undefined,
      "teammate_scope_violation",
    );
  }
  assert.equal(deniedWrapped.type, "error");
  assert.equal(
    deniedWrapped.type === "error" ? deniedWrapped.error.code : undefined,
    "teammate_scope_violation",
  );
  assert.equal(executions, 0);
  assert.equal(lifecycleEvents.includes("PermissionRequest"), false);
});

test("Teammate command allow selectors use all-segments semantics", async () => {
  let executions = 0;
  const runtime = new ToolRuntime(createRegistry(() => {
    executions += 1;
  }), new PermissionRuntime());
  const result = await runtime.execute(
    {
      id: "call-all-segments",
      name: "bash",
      input: { command: "npm test && npm run build" },
    },
    {
      ...toolContext(),
      teammateCapability: {
        teammateId: "reviewer",
        allow: [{
          version: 2,
          toolName: "bash",
          conditions: [{
            subject: "bash.command",
            operator: "executableEquals",
            value: "npm",
          }],
        }],
        deny: [],
        activeProjectRoot: "/tmp/workspace",
        canonicalWorkspace: "/tmp/workspace",
        workspaceBindingRevision: "revision-3",
        workspaceBindingFingerprint: "fingerprint-3",
      },
    },
  );

  assert.equal(result.type, "success");
  assert.equal(executions, 1);
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
    constraints: { allow: [], deny: [] },
    canonicalWorkspace: "/tmp",
    workspaceBindingRevision: "revision",
    workspaceBindingFingerprint: "fingerprint",
    activeProjectRoot: "/tmp",
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
    registry.register(noopTool(
      name,
      name === "bash" || name === "read_file" ? onBashExecute : undefined,
    ));
  }
  return registry;
}

function noopTool(
  name: string,
  onExecute?: () => void,
): PilotDeckToolDefinition<Record<string, unknown>> {
  return {
    name,
    title: name,
    description: name,
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        command: { type: "string" },
        file_path: { type: "string" },
      },
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

class TrackingLifecycleRuntime extends LifecycleRuntime {
  constructor(private readonly events: string[]) {
    super();
  }

  override async dispatch(
    input: Parameters<LifecycleRuntime["dispatch"]>[0],
  ): ReturnType<LifecycleRuntime["dispatch"]> {
    this.events.push(input.event);
    return {
      effects: [],
      messages: [],
      events: [],
      blockingErrors: [],
      nonBlockingErrors: [],
    };
  }
}
