import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { LifecycleRuntime } from "../../src/lifecycle/runtime/LifecycleRuntime.js";
import {
  PermissionRuntime,
  createDefaultPermissionContext,
  matchPermissionRule,
  matchToolCallSelector,
  type PermissionRuleSource,
  type ToolCallSelector,
  type ToolCallSubject,
} from "../../src/permission/index.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/protocol/types.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

const cwd = path.resolve("/tmp/pilotdeck-policy-core");

test("V2 command selectors use all segments for allow and any segment for deny", () => {
  const selector = {
    version: 2,
    toolName: "bash",
    conditions: [{
      subject: "bash.command",
      operator: "executableEquals",
      value: "git",
    }],
  } satisfies ToolCallSelector;
  const context = createDefaultPermissionContext({ cwd });

  assert.equal(matchToolCallSelector(
    selector,
    "bash",
    { command: "git status && git log" },
    context,
  ).matched, true);
  assert.equal(matchToolCallSelector(
    selector,
    "bash",
    { command: "/tmp/evil/git status" },
    context,
  ).matched, false);
  assert.equal(matchPermissionRule(
    { source: "policy", behavior: "deny", toolName: "bash", selector },
    "bash",
    { command: "/tmp/evil/git status" },
    context,
  ), true);
  assert.equal(matchPermissionRule(
    { source: "user", behavior: "allow", toolName: "bash", selector },
    "bash",
    { command: "git status && npm test" },
    context,
  ), false);
  assert.equal(matchPermissionRule(
    { source: "policy", behavior: "deny", toolName: "bash", selector },
    "bash",
    { command: "git status && npm test" },
    context,
  ), true);
});

test("V2 command selectors support argv prefixes and fail closed on ambiguous shell", () => {
  const selector = {
    version: 2,
    toolName: "bash",
    conditions: [
      { subject: "bash.command", operator: "executableEquals", value: "git" },
      { subject: "bash.command", operator: "argvPrefix", value: ["git", "status", "--short"] },
    ],
  } satisfies ToolCallSelector;
  const context = createDefaultPermissionContext({ cwd });

  assert.equal(matchToolCallSelector(
    selector,
    "bash",
    { command: "git status --short" },
    context,
  ).matched, true);
  for (const command of [
    "MODE=ci git status --short",
    "PATH=/tmp/evil git status --short",
    "env PATH=/tmp/evil git status --short",
    "env -C /tmp git status --short",
    "env -S 'git status --short'",
    "/tmp/evil/git status --short",
    "python git status --short",
  ]) {
    assert.equal(matchToolCallSelector(
      selector,
      "bash",
      { command },
      context,
    ).matched, false, command);
  }
  for (const command of [
    "MODE=ci git status --short",
    "PATH=/tmp/evil git status --short",
    "env PATH=/tmp/evil git status --short",
    "env -C /tmp git status --short",
    "env -S 'git status --short'",
  ]) {
    assert.equal(matchPermissionRule(
      { source: "policy", behavior: "deny", toolName: "bash", selector },
      "bash",
      { command },
      context,
    ), true, `deny must unwrap ${command}`);
  }
  assert.equal(matchToolCallSelector(
    selector,
    "bash",
    { command: "git $(printf status) --short" },
    context,
  ).matched, false);
});

test("path descriptors match canonical tool parameters and effective search roots", () => {
  const context = createDefaultPermissionContext({ cwd });
  const withinWorkspace = (toolName: string, subject: ToolCallSubject) => ({
    version: 2,
    toolName,
    conditions: [{ subject, operator: "pathWithin", value: "$WORKSPACE/src" }],
  } as ToolCallSelector);

  assert.equal(matchToolCallSelector(
    withinWorkspace("read_file", "read_file.file_path"),
    "read_file",
    { file_path: "src/index.ts" },
    context,
  ).matched, true);
  assert.equal(matchToolCallSelector(
    withinWorkspace("edit_notebook", "edit_notebook.notebook_path"),
    "edit_notebook",
    { notebook_path: "src/demo.ipynb" },
    context,
  ).matched, true);
  assert.equal(matchToolCallSelector(
    withinWorkspace("glob", "glob.search_root"),
    "glob",
    { path: "/ignored", pattern: `${cwd}/src/**/*.ts` },
    context,
  ).matched, true);
  assert.equal(matchToolCallSelector(
    {
      version: 2,
      toolName: "grep",
      conditions: [{ subject: "grep.path", operator: "pathEquals", value: "$WORKSPACE" }],
    },
    "grep",
    { pattern: "needle" },
    context,
  ).matched, true);
});

test("legacy patterns fail closed for unknown tools and write deny remains effective", () => {
  const context = createDefaultPermissionContext({ cwd });
  assert.equal(matchPermissionRule(
    { source: "user", behavior: "allow", toolName: "mystery", pattern: "*" },
    "mystery",
    { anything: "value" },
    context,
  ), false);
  assert.equal(matchPermissionRule(
    { source: "user", behavior: "deny", toolName: "write_file" },
    "write_file",
    { file_path: "/outside/workspace.txt" },
    context,
  ), true);
  assert.equal(matchPermissionRule(
    { source: "user", behavior: "allow", toolName: "write_file" },
    "write_file",
    { file_path: "/outside/workspace.txt" },
    context,
  ), false);
});

test("unknown V2 subjects, operators, and tools fail closed", () => {
  const context = createDefaultPermissionContext({ cwd });
  const selectors = [
    {
      version: 2,
      toolName: "bash",
      conditions: [{ subject: "bash.unknown", operator: "executableEquals", value: "git" }],
    },
    {
      version: 2,
      toolName: "bash",
      conditions: [{ subject: "bash.command", operator: "contains", value: "git" }],
    },
    {
      version: 2,
      toolName: "unknown_tool",
      conditions: [{ subject: "unknown.path", operator: "pathWithin", value: cwd }],
    },
  ] as unknown as ToolCallSelector[];

  for (const selector of selectors) {
    assert.equal(matchToolCallSelector(selector, selector.toolName, { command: "git status" }, context).matched, false);
  }
});

test("session allows never override explicit deny rules", async () => {
  const runtime = new PermissionRuntime();
  const tool = createTestTool();
  for (const source of ["user", "project", "policy", "cli"] satisfies PermissionRuleSource[]) {
    const context = runtimeContext({
      allow: [{ source: "session", behavior: "allow", toolName: "bash" }],
      deny: [{ source, behavior: "deny", toolName: "bash" }],
      ask: [],
    });
    const decision = await runtime.decide(tool, { command: "echo ok" }, context, `call-${source}`);
    assert.equal(decision.type, "deny", `${source} deny must win`);
  }
});

test("session allows only override ordinary ask or default decisions", async () => {
  const runtime = new PermissionRuntime();
  const tool = createTestTool();
  const sessionRule = { source: "session" as const, behavior: "allow" as const, toolName: "bash" };

  const ordinaryAsk = await runtime.decide(tool, { command: "echo ok" }, runtimeContext({
    allow: [sessionRule],
    deny: [],
    ask: [{ source: "user", behavior: "ask", toolName: "bash" }],
  }), "ordinary-ask");
  assert.equal(ordinaryAsk.type, "allow");

  const policyAsk = await runtime.decide(tool, { command: "echo ok" }, runtimeContext({
    allow: [sessionRule],
    deny: [],
    ask: [{ source: "policy", behavior: "ask", toolName: "bash" }],
  }), "policy-ask");
  assert.equal(policyAsk.type, "ask");
});

test("PermissionRequest updatedInput is validated and permission-checked once", async () => {
  let executeCount = 0;
  let validateCount = 0;
  const tool = createTestTool({
    validateInput: async (input) => {
      validateCount += 1;
      return input.command === "invalid"
        ? {
            ok: false,
            issues: [{ path: "$.command", code: "invalid_schema", message: "command rejected" }],
          }
        : { ok: true, input };
    },
    execute: async () => {
      executeCount += 1;
      return { content: [{ type: "text", text: "executed" }] };
    },
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  const lifecycle = new UpdatingPermissionLifecycle({ command: "rm -rf build" });
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), lifecycle);
  const context = runtimeContext({
    allow: [],
    ask: [{ source: "user", behavior: "ask", toolName: "bash", pattern: "echo*" }],
    deny: [{ source: "policy", behavior: "deny", toolName: "bash", pattern: "rm*" }],
  });

  const result = await runtime.execute(
    { id: "updated-denied", name: "bash", input: { command: "echo ok" } },
    context,
  );

  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.error.code : undefined, "permission_denied");
  assert.equal(lifecycle.permissionRequestCount, 1);
  assert.equal(validateCount, 2);
  assert.equal(executeCount, 0);
});

test("PermissionRequest updatedInput must pass the tool schema", async () => {
  let executeCount = 0;
  const registry = new ToolRegistry();
  registry.register(createTestTool({
    execute: async () => {
      executeCount += 1;
      return { content: [{ type: "text", text: "executed" }] };
    },
  }));
  const lifecycle = new UpdatingPermissionLifecycle({ replacement: "missing command" });
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), lifecycle);
  const context = runtimeContext({
    allow: [],
    deny: [],
    ask: [{ source: "user", behavior: "ask", toolName: "bash" }],
  });

  const result = await runtime.execute(
    { id: "updated-invalid-schema", name: "bash", input: { command: "echo ok" } },
    context,
  );

  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.error.code : undefined, "invalid_tool_input");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /PermissionRequest hook/);
  assert.equal(lifecycle.permissionRequestCount, 1);
  assert.equal(executeCount, 0);
});

test("PermissionRequest update that still asks exits without another update loop", async () => {
  let executeCount = 0;
  const registry = new ToolRegistry();
  registry.register(createTestTool({
    execute: async () => {
      executeCount += 1;
      return { content: [{ type: "text", text: "executed" }] };
    },
  }));
  const lifecycle = new UpdatingPermissionLifecycle({ command: "npm test" });
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), lifecycle);
  const context = runtimeContext({
    allow: [],
    deny: [],
    ask: [{ source: "user", behavior: "ask", toolName: "bash" }],
  });

  const result = await runtime.execute(
    { id: "updated-still-ask", name: "bash", input: { command: "echo ok" } },
    context,
  );

  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.error.code : undefined, "permission_required");
  assert.equal(lifecycle.permissionRequestCount, 1);
  assert.equal(executeCount, 0);
});

class UpdatingPermissionLifecycle extends LifecycleRuntime {
  permissionRequestCount = 0;
  readonly updatedInput: Record<string, unknown>;

  constructor(updatedInput: Record<string, unknown>) {
    super();
    this.updatedInput = updatedInput;
  }

  override async dispatch(input: Parameters<LifecycleRuntime["dispatch"]>[0]) {
    if (input.event === "PermissionRequest") {
      this.permissionRequestCount += 1;
      return {
        effects: [{
          type: "permission_request_result" as const,
          result: { behavior: "allow" as const, updatedInput: this.updatedInput },
        }],
        messages: [],
        events: [],
        blockingErrors: [],
        nonBlockingErrors: [],
      };
    }
    return {
      effects: [],
      messages: [],
      events: [],
      blockingErrors: [],
      nonBlockingErrors: [],
    };
  }
}

function createTestTool(
  overrides: Partial<PilotDeckToolDefinition<{ command: string }>> = {},
): PilotDeckToolDefinition<{ command: string }> {
  return {
    name: "bash",
    description: "test tool",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: { command: { type: "string" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

function runtimeContext(
  rules: PilotDeckToolRuntimeContext["permissionContext"]["rules"],
): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session",
    turnId: "turn",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd,
      canPrompt: true,
      rules,
    }),
  };
}
