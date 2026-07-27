import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLocalGateway,
  isGlobalTeammatePath,
} from "../../src/cli/createLocalGateway.js";
import {
  TeammateEnablementStore,
  canonicalizeTeammateWorkspace,
} from "../../src/extension/teammates/index.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { getPilotTeammateEnablementFilePath } from "../../src/pilot/index.js";

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

test("runtime resolves only globally defined teammates enabled and valid for the workspace", async () => {
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
    const enablement = new TeammateEnablementStore({ pilotHome });
    await enablement.set(projectA, ["enabled-broken", "enabled-invalid", "stale", "valid"]);
    await enablement.set(projectB, ["disabled-invalid"]);

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
    assert.deepEqual(local.registry.resolve(projectA).teammates[0]?.tools, []);
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
    assert.ok(local.gateway.teammateEnablementGet);
    const canonicalProjectA = await canonicalizeTeammateWorkspace(projectA);
    assert.deepEqual(await local.gateway.teammateEnablementGet({ projectKey: projectA }), {
      canonicalProjectKey: canonicalProjectA,
      enabledTeammateIds: ["enabled-broken", "enabled-invalid", "stale", "valid"],
      filePath: getPilotTeammateEnablementFilePath(pilotHome),
    });
    assert.ok(local.gateway.teammateEnablementSet);
    assert.deepEqual(
      await local.gateway.teammateEnablementSet({
        projectKey: projectA,
        enabledTeammateIds: ["valid", "valid"],
      }),
      {
        canonicalProjectKey: canonicalProjectA,
        enabledTeammateIds: ["valid"],
        filePath: getPilotTeammateEnablementFilePath(pilotHome),
      },
    );
    await assert.rejects(
      local.gateway.teammateEnablementSet({
        projectKey: projectA,
        enabledTeammateIds: ["missing"],
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_input" &&
        /missing/.test((error as Error).message),
    );
    assert.ok(local.gateway.teamState);
    assert.deepEqual(
      (await local.gateway.teamState({
        projectKey: projectA,
        leaderSessionId: "leader",
      })).teammates.map((entry) => entry.id),
      ["valid"],
    );

    await writeFile(getPilotTeammateEnablementFilePath(pilotHome), "{broken", "utf8");
    const damaged = await local.registry.listEnabledTeammates(projectA);
    assert.deepEqual(damaged.teammates, []);
    assert.ok(
      damaged.diagnostics.some((entry) => entry.code === "TEAMMATE_ENABLEMENT_INVALID"),
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

test("remote gateway forwards global teammate CRUD and workspace enablement RPCs", async () => {
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
  await remote.teammateEnablementGet({ projectKey: "/workspace" });
  await remote.teammateEnablementSet({
    projectKey: "/workspace",
    enabledTeammateIds: ["reviewer"],
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
    { method: "teammate_enablement_get", params: { projectKey: "/workspace" } },
    {
      method: "teammate_enablement_set",
      params: {
        projectKey: "/workspace",
        enabledTeammateIds: ["reviewer"],
      },
    },
  ]);
});
