import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLocalGateway,
  isGlobalTeammatePath,
} from "../../src/cli/createLocalGateway.js";
import { TeamSetStore } from "../../src/extension/team-sets/index.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";

const CONFIG = `schemaVersion: 1
agent:
  model: fixture/main
model:
  providers:
    fixture:
      protocol: openai
      url: https://fixture.invalid
      apiKey: test
      models:
        main:
          capabilities:
            maxContextTokens: 100000
            maxOutputTokens: 4096
`;

function tokenConfig(agentExtra = ""): string {
  return `schemaVersion: 1
agent:
  model: fixture/main
${agentExtra.trim() ? agentExtra : ""}
model:
  providers:
    fixture:
      protocol: openai
      url: https://fixture.invalid
      apiKey: test
      models:
        main:
          capabilities:
            maxContextTokens: 200000
            maxOutputTokens: 128000
`;
}

function definition(id: string, extra = ""): string {
  return `---
schemaVersion: 1
id: ${id}
name: ${id}
${extra.trim()}
---

Handle the assigned task.
`;
}

async function enableTeammates(
  pilotHome: string,
  projectRoot: string,
  teammateIds: string[],
  teamSetId = "test-team",
  overrides?: Record<string, Record<string, unknown>>,
): Promise<void> {
  const store = new TeamSetStore({ pilotHome });
  const teammates: Record<string, { toolProfile: { mode: "inherit" } }> = {};
  for (const id of teammateIds) {
    const config: Record<string, unknown> = { toolProfile: { mode: "inherit" } };
    if (overrides?.[id]) {
      Object.assign(config, overrides[id]);
    }
    teammates[id] = config as never;
  }
  try {
    await store.create({
      id: teamSetId,
      name: teamSetId,
      leader: { mode: "inherit" },
      teammates,
    });
  } catch {
    // already exists, update it
    const current = await store.read(teamSetId);
    await store.write(teamSetId, {
      id: teamSetId,
      name: teamSetId,
      leader: { mode: "inherit" },
      teammates,
    }, current.revision);
  }
  const assignment = await store.getAssignment(projectRoot);
  await store.setAssignment(projectRoot, teamSetId, assignment.revision);
}

test("local gateway treats blank agent maxOutputTokens as no explicit output reserve", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-token-config-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(pilotHome, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    await writeFile(
      join(pilotHome, "pilotdeck.yaml"),
      tokenConfig("  maxContextTokens: 128000"),
      "utf8",
    );

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const runtime = local.registry.resolve(projectRoot);
    const config = (local.registry as unknown as {
      createAgentConfig(runtime: unknown, sessionKey: string): {
        maxContextTokens?: number;
        maxOutputTokens?: number;
      };
    }).createAgentConfig(runtime, "web:s_token_blank_output");

    assert.equal(config.maxContextTokens, 128000);
    assert.equal(config.maxOutputTokens, undefined);
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("local gateway preserves explicit agent maxOutputTokens as output reserve", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-token-config-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(pilotHome, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    await writeFile(
      join(pilotHome, "pilotdeck.yaml"),
      tokenConfig(`  maxContextTokens: 128000
  maxOutputTokens: 65536`),
      "utf8",
    );

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const runtime = local.registry.resolve(projectRoot);
    const config = (local.registry as unknown as {
      createAgentConfig(runtime: unknown, sessionKey: string): {
        maxContextTokens?: number;
        maxOutputTokens?: number;
      };
    }).createAgentConfig(runtime, "web:s_token_explicit_output");

    assert.equal(config.maxContextTokens, 128000);
    assert.equal(config.maxOutputTokens, 65536);
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("local gateway wires configured subagent default model into agent config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-default-model-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(pilotHome, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    await writeFile(
      join(pilotHome, "pilotdeck.yaml"),
      `schemaVersion: 1
agent:
  model: fixture/main
  subagents:
    default: fixture/child
model:
  providers:
    fixture:
      protocol: openai
      url: https://fixture.invalid
      apiKey: test
      models:
        main:
          capabilities:
            maxContextTokens: 100000
            maxOutputTokens: 4096
        child:
          capabilities:
            maxContextTokens: 32000
            maxOutputTokens: 2048
`,
      "utf8",
    );

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome, PILOTDECK_MAX_OUTPUT_TOKENS: "999" },
    });
    dispose = local.dispose;

    const runtime = local.registry.resolve(projectRoot);
    const config = (local.registry as unknown as {
      createAgentConfig(runtime: unknown, sessionKey: string): {
        subagentModel?: {
          provider: string;
          model: string;
          modelMultimodal?: unknown;
          maxContextTokens?: number;
          maxOutputTokens?: number;
        };
      };
    }).createAgentConfig(runtime, "web:s_subagent_default_model");

    assert.equal(config.subagentModel?.provider, "fixture");
    assert.equal(config.subagentModel?.model, "child");
    assert.equal(config.subagentModel?.maxContextTokens, 32000);
    assert.equal(config.subagentModel?.maxOutputTokens, 999);
    assert.ok(config.subagentModel?.modelMultimodal);
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("local gateway applies teammate token overrides to teammate sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-token-overrides-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  const disposers: Array<() => void> = [];
  try {
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(pilotHome, "pilotdeck.yaml"),
        tokenConfig(`  maxContextTokens: 128000
  maxOutputTokens: 65536`),
        "utf8",
      ),
      writeFile(
        join(pilotHome, "teammates", "worker.md"),
        definition("worker", `maxContextTokens: 64000
maxOutputTokens: 8192`),
        "utf8",
      ),
    ]);
    await enableTeammates(pilotHome, projectRoot, ["worker"]);

    const resolveConfig = async (env: Record<string, string | undefined> = {}) => {
      const local = createLocalGateway({
        projectRoot,
        pilotHome,
        env: { PILOT_HOME: pilotHome, ...env },
      });
      disposers.push(local.dispose);
      await local.registry.listEnabledTeammates(projectRoot);
      const runtime = local.registry.resolve(projectRoot);
      const teammate = runtime.teammates[0]!;
      const sessionKey = `team:${env.PILOTDECK_MAX_OUTPUT_TOKENS ?? "default"}`;
      const registry = local.registry as unknown as {
        compileTeammateBinding(
          leaderSessionId: string,
          projectRoot: string,
          definition: unknown,
          sessionKey: string,
        ): Promise<unknown>;
        createAgentConfig(runtime: unknown, sessionKey: string): {
          maxContextTokens?: number;
          maxOutputTokens?: number;
        };
      };
      await registry.compileTeammateBinding("leader", projectRoot, teammate, sessionKey);
      return registry.createAgentConfig(runtime, sessionKey);
    };

    const teammateConfig = await resolveConfig();
    assert.equal(teammateConfig.maxContextTokens, 64_000);
    assert.equal(teammateConfig.maxOutputTokens, 8_192);

    const envOverrideConfig = await resolveConfig({
      PILOTDECK_MAX_OUTPUT_TOKENS: "32768",
    });
    assert.equal(envOverrideConfig.maxContextTokens, 64_000);
    assert.equal(envOverrideConfig.maxOutputTokens, 32_768);
  } finally {
    for (const dispose of disposers) dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime resolves only globally defined teammates enabled via team set for the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-runtime-"));
  const pilotHome = join(root, "pilot-home");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      mkdir(projectA, { recursive: true }),
      mkdir(projectB, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG, "utf8"),
      writeFile(join(pilotHome, "teammates", "valid.md"), definition("valid"), "utf8"),
      writeFile(
        join(pilotHome, "teammates", "enabled-invalid.md"),
        definition(
          "enabled-invalid",
          `model: fixture/missing
tools: [missing_enabled_tool]
plugins: [missing_plugin]
skills: [missing_skill]
mcpServers: [missing_mcp]`,
        ),
        "utf8",
      ),
      writeFile(
        join(pilotHome, "teammates", "disabled-invalid.md"),
        definition("disabled-invalid", "tools: [missing_disabled_tool]"),
        "utf8",
      ),
      writeFile(
        join(pilotHome, "teammates", "enabled-broken.md"),
        definition("enabled-broken").replace("schemaVersion: 1", "schemaVersion: 2"),
        "utf8",
      ),
      writeFile(join(pilotHome, "teammates", "broken.md"), "not frontmatter\n", "utf8"),
    ]);
    await enableTeammates(pilotHome, projectA, ["enabled-broken", "enabled-invalid", "stale", "valid"], "team-a");
    await enableTeammates(pilotHome, projectB, ["disabled-invalid"], "team-b");

    const local = createLocalGateway({
      projectRoot: projectA,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    assert.equal(
      local.registry.getTeammateManager(),
      local.registry.getTeammateManager(),
    );
    assert.deepEqual(
      (await local.registry.listAllTeammates()).teammates.map((entry) => entry.id),
      ["disabled-invalid", "enabled-invalid", "valid"],
    );

    const listedA = await local.registry.listEnabledTeammates(projectA);
    assert.deepEqual(listedA.teammates.map((entry) => entry.id), ["valid"]);
    const initialRuntimeDefinition = local.registry.resolve(projectA).teammates[0]!;
    assert.deepEqual(initialRuntimeDefinition.tools, []);
    assert.equal(
      listedA.diagnostics.some((entry) => entry.code === "FRONTMATTER_MISSING"),
      false,
    );
    assert.ok(
      listedA.diagnostics.some(
        (entry) =>
          entry.code === "SCHEMA_VERSION_UNSUPPORTED" &&
          entry.id === "enabled-broken",
      ),
    );
    assert.equal(
      listedA.diagnostics.some(
        (entry) =>
          entry.code === "TEAMMATE_NOT_FOUND" &&
          entry.id === "enabled-broken",
      ),
      false,
    );
    assert.ok(
      listedA.diagnostics.some(
        (entry) => entry.code === "TOOL_NOT_FOUND" && entry.id === "enabled-invalid",
      ),
    );
    for (const code of [
      "MODEL_NOT_FOUND",
      "PLUGIN_NOT_FOUND",
      "SKILL_NOT_FOUND",
      "MCP_SERVER_NOT_FOUND",
    ] as const) {
      assert.ok(
        listedA.diagnostics.some(
          (entry) => entry.code === code && entry.id === "enabled-invalid",
        ),
      );
    }
    assert.ok(
      listedA.diagnostics.some(
        (entry) => entry.code === "TEAMMATE_NOT_FOUND" && entry.id === "stale",
      ),
    );
    assert.equal(
      listedA.diagnostics.some(
        (entry) => entry.code === "TOOL_NOT_FOUND" && entry.id === "disabled-invalid",
      ),
      false,
    );
    assert.ok(local.gateway.teammateCatalog);
    const catalogA = await local.gateway.teammateCatalog({ projectKey: projectA });
    assert.ok(
      catalogA.diagnostics.some(
        (entry) => entry.code === "TOOL_NOT_FOUND" && entry.id === "enabled-invalid",
      ),
    );
    assert.ok(
      catalogA.diagnostics.some(
        (entry) => entry.code === "TEAMMATE_NOT_FOUND" && entry.id === "stale",
      ),
    );
    assert.equal(
      catalogA.diagnostics.some((entry) => entry.code === "FRONTMATTER_MISSING"),
      false,
    );

    assert.ok(local.gateway.teammatesList);
    assert.deepEqual(
      (await local.gateway.teammatesList({})).teammates.map(
        (entry) => entry.id,
      ),
      ["disabled-invalid", "enabled-invalid", "valid"],
    );
    assert.equal((await local.gateway.teammateRead?.({ id: "valid" }))?.teammate.id, "valid");

    // Verify Team Set gateway operations
    assert.ok(local.gateway.teamSetList);
    const teamSets = await local.gateway.teamSetList();
    assert.ok(teamSets.teamSets.length >= 1);

    assert.ok(local.gateway.teamSetWorkspaceAssignmentGet);
    const assignmentA = await local.gateway.teamSetWorkspaceAssignmentGet({ projectKey: projectA });
    assert.equal(assignmentA.teamSetId, "team-a");
    assert.match(assignmentA.revision, /^[a-f0-9]{64}$/);

    // Update team set to only include "valid"
    assert.ok(local.gateway.teamSetRead);
    const currentTeamSet = await local.gateway.teamSetRead({ id: "team-a" });
    assert.ok(local.gateway.teamSetWrite);
    await local.gateway.teamSetWrite({
      id: "team-a",
      teamSet: {
        id: "team-a",
        name: "team-a",
        leader: { mode: "inherit" },
        teammates: {
          valid: {
            toolProfile: {
              mode: "custom",
              tools: ["read_file"],
              constraints: { allow: [], deny: [] },
            },
          },
        },
      },
      expectedRevision: currentTeamSet.revision,
    });

    await local.registry.listEnabledTeammates(projectA);
    const rebuiltRuntimeDefinition = local.registry.resolve(projectA).teammates[0]!;
    assert.deepEqual(rebuiltRuntimeDefinition.tools, ["read_file"]);
    assert.notEqual(
      rebuiltRuntimeDefinition.workspaceBindingFingerprint,
      initialRuntimeDefinition.workspaceBindingFingerprint,
    );

    // Verify revision conflict
    await assert.rejects(
      local.gateway.teamSetWrite({
        id: "team-a",
        teamSet: {
          id: "team-a",
          name: "team-a",
          leader: { mode: "inherit" },
          teammates: { valid: { toolProfile: { mode: "inherit" } } },
        },
        expectedRevision: currentTeamSet.revision,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "revision_conflict",
    );

    assert.ok(local.gateway.teamState);
    assert.deepEqual(
      (await local.gateway.teamState({
        projectKey: projectA,
        leaderSessionId: "leader",
      })).teammates.map((entry) => entry.id),
      ["valid"],
    );
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("team set tool profiles resolve distinct effective tools and isolate invalid profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-profiles-"));
  const pilotHome = join(root, "pilot-home");
  const projects = ["a", "b", "c", "d"].map((name) => join(root, `project-${name}`));
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      ...projects.map((project) => mkdir(project, { recursive: true })),
    ]);
    await Promise.all([
      writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG, "utf8"),
      writeFile(
        join(pilotHome, "teammates", "worker.md"),
        definition("worker", "tools: [missing_default_tool]"),
        "utf8",
      ),
    ]);

    const store = new TeamSetStore({ pilotHome });

    // Project A: custom profile with read_file + constraint
    await store.create({
      id: "team-a",
      name: "Team A",
      leader: { mode: "inherit" },
      teammates: {
        worker: {
          toolProfile: {
            mode: "custom",
            tools: ["read_file"],
            constraints: {
              allow: [{
                version: 2,
                toolName: "read_file",
                conditions: [{
                  subject: "read_file.file_path",
                  operator: "pathWithin",
                  value: "$WORKSPACE",
                }],
              }],
              deny: [],
            },
          },
        },
      },
    });

    // Project B: custom profile with bash
    await store.create({
      id: "team-b",
      name: "Team B",
      leader: { mode: "inherit" },
      teammates: {
        worker: {
          toolProfile: {
            mode: "custom",
            tools: ["bash"],
            constraints: { allow: [], deny: [] },
          },
        },
      },
    });

    // Project C: custom profile with missing tool
    await store.create({
      id: "team-c",
      name: "Team C",
      leader: { mode: "inherit" },
      teammates: {
        worker: {
          toolProfile: {
            mode: "custom",
            tools: ["missing_custom_tool"],
            constraints: { allow: [], deny: [] },
          },
        },
      },
    });

    // Project D: inherit profile (falls back to definition's tools, which has missing_default_tool)
    await store.create({
      id: "team-d",
      name: "Team D",
      leader: { mode: "inherit" },
      teammates: {
        worker: { toolProfile: { mode: "inherit" } },
      },
    });

    // Assign each project to its team set
    for (let i = 0; i < projects.length; i++) {
      const teamSetId = `team-${["a", "b", "c", "d"][i]}`;
      const assignment = await store.getAssignment(projects[i]!);
      await store.setAssignment(projects[i]!, teamSetId, assignment.revision);
    }

    const local = createLocalGateway({
      projectRoot: projects[0],
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const listedA = await local.registry.listEnabledTeammates(projects[0]!);
    const runtimeA = local.registry.resolve(projects[0]!).teammates[0]!;
    assert.deepEqual(listedA.teammates.map((entry) => entry.tools), [["read_file"]]);
    assert.deepEqual(runtimeA.tools, ["read_file"]);
    assert.equal(runtimeA.constraints.allow.length, 1);
    assert.equal(runtimeA.activeProjectRoot, projects[0]);
    assert.match(runtimeA.workspaceBindingRevision, /^[a-f0-9]{64}$/);
    assert.match(runtimeA.workspaceBindingFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(
      listedA.diagnostics.some((entry) => /missing_default_tool/.test(entry.message)),
      false,
    );

    const listedB = await local.registry.listEnabledTeammates(projects[1]!);
    const runtimeB = local.registry.resolve(projects[1]!).teammates[0]!;
    assert.deepEqual(listedB.teammates.map((entry) => entry.tools), [["bash"]]);
    assert.deepEqual(runtimeB.tools, ["bash"]);
    assert.notEqual(
      runtimeB.workspaceBindingFingerprint,
      runtimeA.workspaceBindingFingerprint,
    );

    const listedC = await local.registry.listEnabledTeammates(projects[2]!);
    assert.deepEqual(listedC.teammates, []);
    assert.ok(listedC.diagnostics.some(
      (entry) =>
        entry.code === "TOOL_NOT_FOUND" &&
        entry.id === "worker" &&
        /missing_custom_tool/.test(entry.message),
    ));

    const listedD = await local.registry.listEnabledTeammates(projects[3]!);
    assert.deepEqual(listedD.teammates, []);
    assert.ok(listedD.diagnostics.some(
      (entry) =>
        entry.code === "TOOL_NOT_FOUND" &&
        entry.id === "worker" &&
        /missing_default_tool/.test(entry.message),
    ));
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("teammate catalog includes perSession MCP server IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-catalog-mcp-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      mkdir(join(projectRoot, ".pilotdeck"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG, "utf8"),
      writeFile(
        join(pilotHome, "teammates", "browser-worker.md"),
        definition("browser-worker", "mcpServers: [browser-use]"),
        "utf8",
      ),
      writeFile(
        join(projectRoot, ".pilotdeck", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "browser-use": {
              command: "echo",
              args: ["noop"],
              perSession: true,
            },
          },
        }),
        "utf8",
      ),
    ]);
    await enableTeammates(pilotHome, projectRoot, ["browser-worker"]);

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const catalog = await local.gateway.teammateCatalog!({ projectKey: projectRoot });
    assert.ok(
      catalog.mcpServers.includes("browser-use"),
      `Expected mcpServers to include "browser-use", got: ${JSON.stringify(catalog.mcpServers)}`,
    );
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("global teammate reload paths are classified independently of project scope", () => {
  const pilotHome = join(tmpdir(), "pilot-home");
  assert.equal(
    isGlobalTeammatePath(join(pilotHome, "teammates", "reviewer.md"), pilotHome),
    true,
  );
  assert.equal(
    isGlobalTeammatePath(
      join(tmpdir(), "workspace", ".pilotdeck", "teammates", "reviewer.md"),
      pilotHome,
    ),
    false,
  );
});

test("remote gateway forwards global teammate CRUD and team set RPCs", async () => {
  assert.equal(PILOTDECK_GATEWAY_PROTOCOL_VERSION, "2.0");
  const calls: Array<{ method: string; params: unknown }> = [];
  const remote = new RemoteGateway({
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return {};
    },
  } as never);

  await remote.teammatesList({});
  await remote.teammateRead({ id: "reviewer" });
  await remote.teammateCreate({
    document: { id: "reviewer", prompt: "Review the work." },
    relativePath: "nested/reviewer.md",
  });
  await remote.teammateWrite({
    id: "reviewer",
    document: { id: "reviewer", prompt: "Review carefully." },
  });
  await remote.teammateDelete({ id: "reviewer" });
  await remote.teammateCatalog({ projectKey: "/workspace" });
  await remote.teamSetList();
  await remote.teamSetRead({ id: "my-team" });
  await remote.teamSetCreate({
    teamSet: {
      id: "my-team",
      name: "My Team",
      leader: { mode: "inherit" },
      teammates: {},
    },
  });
  await remote.teamSetWrite({
    id: "my-team",
    teamSet: {
      id: "my-team",
      name: "My Team",
      leader: { mode: "inherit" },
      teammates: {},
    },
    expectedRevision: "abc123",
  });
  await remote.teamSetDelete({ id: "my-team" });
  await remote.teamSetWorkspaceAssignmentGet({ projectKey: "/workspace" });
  await remote.teamSetWorkspaceAssignmentSet({
    projectKey: "/workspace",
    teamSetId: "my-team",
    expectedRevision: "abc123",
  });

  assert.deepEqual(calls, [
    { method: "teammate_list", params: {} },
    { method: "teammate_read", params: { id: "reviewer" } },
    {
      method: "teammate_create",
      params: {
        document: { id: "reviewer", prompt: "Review the work." },
        relativePath: "nested/reviewer.md",
      },
    },
    {
      method: "teammate_write",
      params: {
        id: "reviewer",
        document: { id: "reviewer", prompt: "Review carefully." },
      },
    },
    { method: "teammate_delete", params: { id: "reviewer" } },
    { method: "teammate_catalog", params: { projectKey: "/workspace" } },
    { method: "team_set_list", params: {} },
    { method: "team_set_read", params: { id: "my-team" } },
    {
      method: "team_set_create",
      params: {
        teamSet: {
          id: "my-team",
          name: "My Team",
          leader: { mode: "inherit" },
          teammates: {},
        },
      },
    },
    {
      method: "team_set_write",
      params: {
        id: "my-team",
        teamSet: {
          id: "my-team",
          name: "My Team",
          leader: { mode: "inherit" },
          teammates: {},
        },
        expectedRevision: "abc123",
      },
    },
    { method: "team_set_delete", params: { id: "my-team" } },
    { method: "team_set_workspace_assignment_get", params: { projectKey: "/workspace" } },
    {
      method: "team_set_workspace_assignment_set",
      params: {
        projectKey: "/workspace",
        teamSetId: "my-team",
        expectedRevision: "abc123",
      },
    },
  ]);
});
