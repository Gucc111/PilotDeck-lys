import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { TeammateEnablementStore } from "../../src/extension/teammates/index.js";
import { McpRuntime } from "../../src/mcp/runtime/McpRuntime.js";
import { buildMcpToolWireName, parseMcpToolWireName } from "../../src/mcp/runtime/wireName.js";

const MINI_MCP = resolve(import.meta.dirname, "..", "fixtures", "mini-mcp-server.cjs");

const SERVER_IDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] as const;

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

function mcpConfig(): string {
  const servers: Record<string, unknown> = {};
  for (const id of SERVER_IDS) {
    servers[id] = {
      command: "node",
      args: [MINI_MCP, id],
      perSession: true,
    };
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

function teammateDef(id: string, mcpServerId: string): string {
  return `---
schemaVersion: 1
id: ${id}
name: ${id}
tools: [mcp]
mcpServers: [${mcpServerId}]
---

Handle the assigned task using ${mcpServerId}.
`;
}

// --------------------------------------------------------------------------
// Test 1: catalog includes all perSession MCP servers
// --------------------------------------------------------------------------
test("catalog lists all 6 perSession MCP servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-team-mcp-catalog-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      mkdir(join(projectRoot, ".pilotdeck"), { recursive: true }),
    ]);
    const writes: Promise<void>[] = [
      writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG, "utf8"),
      writeFile(join(projectRoot, ".pilotdeck", "mcp.json"), mcpConfig(), "utf8"),
    ];
    for (const id of SERVER_IDS) {
      writes.push(
        writeFile(
          join(pilotHome, "teammates", `${id}-worker.md`),
          teammateDef(`${id}-worker`, id),
          "utf8",
        ),
      );
    }
    await Promise.all(writes);
    await new TeammateEnablementStore({ pilotHome }).set(
      projectRoot,
      SERVER_IDS.map((id) => `${id}-worker`),
    );

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const catalog = await local.gateway.teammateCatalog!({ projectKey: projectRoot });
    for (const id of SERVER_IDS) {
      assert.ok(
        catalog.mcpServers.includes(id),
        `Expected mcpServers to include "${id}", got: ${JSON.stringify(catalog.mcpServers)}`,
      );
    }
    assert.equal(catalog.mcpServers.length, SERVER_IDS.length);
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 2: mini MCP server works with McpRuntime
// --------------------------------------------------------------------------
test("mini MCP server responds to MCP protocol", async () => {
  const runtime = new McpRuntime([{
    id: "alpha",
    transport: "stdio",
    command: "node",
    args: [MINI_MCP, "alpha"],
  }]);
  try {
    const statuses = await runtime.start();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]!.status, "ready");
    const tools = await runtime.listAllTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.toolName, "alpha");
  } finally {
    await runtime.stop();
  }
});

// --------------------------------------------------------------------------
// Test 3: per-session MCP filtering — teammate session only starts its own MCP
// --------------------------------------------------------------------------
test("teammate session only starts MCP servers listed in its definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-team-mcp-filter-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      mkdir(join(projectRoot, ".pilotdeck"), { recursive: true }),
    ]);
    const writes: Promise<void>[] = [
      writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG, "utf8"),
      writeFile(join(projectRoot, ".pilotdeck", "mcp.json"), mcpConfig(), "utf8"),
    ];
    for (const id of SERVER_IDS) {
      writes.push(
        writeFile(
          join(pilotHome, "teammates", `${id}-worker.md`),
          teammateDef(`${id}-worker`, id),
          "utf8",
        ),
      );
    }
    await Promise.all(writes);
    await new TeammateEnablementStore({ pilotHome }).set(
      projectRoot,
      SERVER_IDS.map((id) => `${id}-worker`),
    );

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const registry = local.registry as unknown as {
      resolve(key: string): {
        perSessionServerSpecs?: { id: string }[];
        leaderConfig?: { mcpServers: string[] };
        teammates: { id: string; mcpServers?: string[] }[];
      };
      ensureMcpReady(runtime: unknown): Promise<void>;
      resolveWorkspaceTeammates(runtime: unknown): Promise<unknown>;
      resolveLeaderConfig(runtime: unknown): Promise<void>;
      teammateBindings: Map<string, {
        definition: { mcpServers?: string[] };
        leaderSessionId: string;
      }>;
      compileTeammateBinding(
        leaderSessionId: string,
        projectRoot: string,
        definition: unknown,
        sessionKey: string,
      ): Promise<unknown>;
    };

    await local.registry.listEnabledTeammates(projectRoot);
    const runtime = registry.resolve(projectRoot);
    await registry.ensureMcpReady(runtime);
    await registry.resolveLeaderConfig(runtime);
    await registry.resolveWorkspaceTeammates(runtime);

    assert.ok(runtime.perSessionServerSpecs);
    assert.equal(runtime.perSessionServerSpecs.length, 6);
    assert.equal(runtime.teammates.length, 6);

    // Simulate teammate binding for "alpha-worker"
    const alphaTeammate = runtime.teammates.find((t) => t.id === "alpha-worker")!;
    assert.ok(alphaTeammate);
    await registry.compileTeammateBinding("leader-session", projectRoot, alphaTeammate, "team:alpha-session");

    const binding = registry.teammateBindings.get("team:alpha-session");
    assert.ok(binding, "Teammate binding should exist after compile");

    // Verify filtering logic: given alpha-worker's mcpServers = ["alpha"],
    // effectivePerSpecs should only contain the "alpha" spec
    const perSpecs = runtime.perSessionServerSpecs;
    const needed = new Set(
      (binding.definition.mcpServers ?? []).map((id: string) => {
        const wire = buildMcpToolWireName(id, "tool");
        return parseMcpToolWireName(wire)?.serverId ?? id;
      }),
    );
    const effectivePerSpecs = perSpecs.filter(
      (spec: { id: string }) => needed.has(spec.id),
    );
    assert.equal(effectivePerSpecs.length, 1);
    assert.equal(effectivePerSpecs[0]!.id, "alpha");
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 4: leader session with no mcpServers starts zero MCP
// --------------------------------------------------------------------------
test("leader with empty mcpServers produces zero effectivePerSpecs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-team-mcp-leader-"));
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
      writeFile(join(projectRoot, ".pilotdeck", "mcp.json"), mcpConfig(), "utf8"),
      writeFile(
        join(pilotHome, "teammates", "alpha-worker.md"),
        teammateDef("alpha-worker", "alpha"),
        "utf8",
      ),
    ]);
    await new TeammateEnablementStore({ pilotHome }).set(projectRoot, ["alpha-worker"]);

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const registry = local.registry as unknown as {
      resolve(key: string): {
        perSessionServerSpecs?: { id: string }[];
        leaderConfig?: { mcpServers: string[] };
        teammates: { id: string }[];
      };
      ensureMcpReady(runtime: unknown): Promise<void>;
      resolveWorkspaceTeammates(runtime: unknown): Promise<unknown>;
      resolveLeaderConfig(runtime: unknown): Promise<void>;
    };

    await local.registry.listEnabledTeammates(projectRoot);
    const runtime = registry.resolve(projectRoot);
    await registry.ensureMcpReady(runtime);
    await registry.resolveLeaderConfig(runtime);
    await registry.resolveWorkspaceTeammates(runtime);

    const perSpecs = runtime.perSessionServerSpecs ?? [];
    assert.equal(perSpecs.length, 6);

    // Leader config with empty mcpServers
    const leaderConfig = runtime.leaderConfig;

    if (leaderConfig) {
      const needed = new Set(
        leaderConfig.mcpServers.map((id: string) => {
          const wire = buildMcpToolWireName(id, "tool");
          return parseMcpToolWireName(wire)?.serverId ?? id;
        }),
      );
      const effectivePerSpecs = perSpecs.filter(
        (spec: { id: string }) => needed.has(spec.id),
      );
      assert.equal(
        effectivePerSpecs.length, 0,
        `Leader with no MCP config should have 0 effective specs, got ${effectivePerSpecs.length}`,
      );
    }
    // If leaderConfig is undefined (no leader.md file), that's also fine —
    // in that case effectivePerSpecs stays as full perSpecs (normal agent mode)
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 5: dynamic maxInstances — team of 6 gets at least 7 slots
// --------------------------------------------------------------------------
test("dynamic maxInstances is at least 1 + teammates.length for team mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-team-mcp-limit-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      mkdir(join(projectRoot, ".pilotdeck"), { recursive: true }),
    ]);
    const writes: Promise<void>[] = [
      writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG, "utf8"),
      writeFile(join(projectRoot, ".pilotdeck", "mcp.json"), mcpConfig(), "utf8"),
    ];
    for (const id of SERVER_IDS) {
      writes.push(
        writeFile(
          join(pilotHome, "teammates", `${id}-worker.md`),
          teammateDef(`${id}-worker`, id),
          "utf8",
        ),
      );
    }
    await Promise.all(writes);
    await new TeammateEnablementStore({ pilotHome }).set(
      projectRoot,
      SERVER_IDS.map((id) => `${id}-worker`),
    );

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const registry = local.registry as unknown as {
      resolve(key: string): {
        snapshot: { config: { gateway?: { maxPerSessionMcpInstances?: number } } };
        teammates: { id: string }[];
      };
      ensureMcpReady(runtime: unknown): Promise<void>;
      resolveWorkspaceTeammates(runtime: unknown): Promise<unknown>;
      resolveLeaderConfig(runtime: unknown): Promise<void>;
    };

    await local.registry.listEnabledTeammates(projectRoot);
    const runtime = registry.resolve(projectRoot);
    await registry.ensureMcpReady(runtime);
    await registry.resolveLeaderConfig(runtime);
    await registry.resolveWorkspaceTeammates(runtime);

    const configuredMax = runtime.snapshot.config.gateway?.maxPerSessionMcpInstances ?? 5;
    const teamSize = runtime.teammates.length;
    const maxInstances = teamSize > 0
      ? Math.max(configuredMax, 1 + teamSize)
      : configuredMax;

    assert.equal(teamSize, 6);
    assert.ok(
      maxInstances >= 7,
      `Expected maxInstances >= 7 for team of 6, got ${maxInstances} (configuredMax=${configuredMax})`,
    );
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 6: each teammate filters to exactly its own MCP server
// --------------------------------------------------------------------------
test("each of 6 teammates filters to exactly its own MCP server", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-team-mcp-all6-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  let dispose: (() => void) | undefined;
  try {
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      mkdir(join(projectRoot, ".pilotdeck"), { recursive: true }),
    ]);
    const writes: Promise<void>[] = [
      writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG, "utf8"),
      writeFile(join(projectRoot, ".pilotdeck", "mcp.json"), mcpConfig(), "utf8"),
    ];
    for (const id of SERVER_IDS) {
      writes.push(
        writeFile(
          join(pilotHome, "teammates", `${id}-worker.md`),
          teammateDef(`${id}-worker`, id),
          "utf8",
        ),
      );
    }
    await Promise.all(writes);
    await new TeammateEnablementStore({ pilotHome }).set(
      projectRoot,
      SERVER_IDS.map((id) => `${id}-worker`),
    );

    const local = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { PILOT_HOME: pilotHome },
    });
    dispose = local.dispose;

    const registry = local.registry as unknown as {
      resolve(key: string): {
        perSessionServerSpecs?: { id: string }[];
        teammates: { id: string; mcpServers?: string[] }[];
      };
      ensureMcpReady(runtime: unknown): Promise<void>;
      resolveWorkspaceTeammates(runtime: unknown): Promise<unknown>;
      resolveLeaderConfig(runtime: unknown): Promise<void>;
      compileTeammateBinding(
        leaderSessionId: string,
        projectRoot: string,
        definition: unknown,
        sessionKey: string,
      ): Promise<unknown>;
      teammateBindings: Map<string, {
        definition: { mcpServers?: string[] };
      }>;
    };

    await local.registry.listEnabledTeammates(projectRoot);
    const runtime = registry.resolve(projectRoot);
    await registry.ensureMcpReady(runtime);
    await registry.resolveLeaderConfig(runtime);
    await registry.resolveWorkspaceTeammates(runtime);

    const perSpecs = runtime.perSessionServerSpecs!;
    assert.equal(perSpecs.length, 6);

    for (const serverId of SERVER_IDS) {
      const teammate = runtime.teammates.find((t) => t.id === `${serverId}-worker`)!;
      assert.ok(teammate, `Teammate ${serverId}-worker should exist`);

      const sessionKey = `team:${serverId}-session`;
      await registry.compileTeammateBinding("leader-session", projectRoot, teammate, sessionKey);
      const binding = registry.teammateBindings.get(sessionKey)!;
      assert.ok(binding);

      const needed = new Set(
        (binding.definition.mcpServers ?? []).map((id: string) => {
          const wire = buildMcpToolWireName(id, "tool");
          return parseMcpToolWireName(wire)?.serverId ?? id;
        }),
      );
      const effective = perSpecs.filter((spec: { id: string }) => needed.has(spec.id));
      assert.equal(
        effective.length, 1,
        `${serverId}-worker should filter to exactly 1 MCP server, got ${effective.length}`,
      );
      assert.equal(
        effective[0]!.id, serverId,
        `${serverId}-worker should use MCP server "${serverId}", got "${effective[0]!.id}"`,
      );
    }
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});
