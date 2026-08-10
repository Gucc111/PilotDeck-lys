import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  LeaderWorkspaceOverrideStore,
  LeaderOverrideStoreError,
} from "../../../src/extension/leader/index.js";
import {
  getPilotLeaderWorkspaceOverridesFilePath,
} from "../../../src/pilot/paths.js";

test("override path helper resolves correctly", () => {
  const pilotHome = resolve("/tmp", "pilot-home");
  assert.equal(
    getPilotLeaderWorkspaceOverridesFilePath(pilotHome),
    join(pilotHome, "teammates", "leader-workspace-overrides.json"),
  );
});

test("getOverride returns empty when file absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-override-empty-"));
  try {
    const workspace = join(root, "my-project");
    await mkdir(workspace, { recursive: true });
    const store = new LeaderWorkspaceOverrideStore({ pilotHome: root });
    const snapshot = await store.getOverride(workspace);
    assert.equal(snapshot.override, undefined);
    assert.ok(typeof snapshot.revision === "string");
    assert.ok(snapshot.revision.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setOverride stores and retrieves override", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-override-set-"));
  try {
    const workspace = join(root, "project-a");
    await mkdir(workspace, { recursive: true });
    const store = new LeaderWorkspaceOverrideStore({ pilotHome: root });

    const initial = await store.getOverride(workspace);
    const result = await store.setOverride(workspace, {
      model: "anthropic/claude-sonnet-4",
      maxOutputTokens: 8192,
    }, initial.revision);

    assert.ok(result.override);
    assert.equal(result.override.model, "anthropic/claude-sonnet-4");
    assert.equal(result.override.maxOutputTokens, 8192);

    const fetched = await store.getOverride(workspace);
    assert.ok(fetched.override);
    assert.equal(fetched.override.model, "anthropic/claude-sonnet-4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleteOverride removes override", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-override-del-"));
  try {
    const workspace = join(root, "project-b");
    await mkdir(workspace, { recursive: true });
    const store = new LeaderWorkspaceOverrideStore({ pilotHome: root });

    const initial = await store.getOverride(workspace);
    const after = await store.setOverride(workspace, {
      model: "openai/gpt-4.1",
    }, initial.revision);

    const deleted = await store.deleteOverride(workspace, after.revision);
    assert.equal(deleted.override, undefined);

    const refetched = await store.getOverride(workspace);
    assert.equal(refetched.override, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setOverride rejects stale revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-override-rev-"));
  try {
    const workspace = join(root, "project-c");
    await mkdir(workspace, { recursive: true });
    const store = new LeaderWorkspaceOverrideStore({ pilotHome: root });

    const initial = await store.getOverride(workspace);
    await store.setOverride(workspace, { model: "m1" }, initial.revision);

    await assert.rejects(
      () => store.setOverride(workspace, { model: "m2" }, initial.revision),
      (error: unknown) =>
        error instanceof LeaderOverrideStoreError && error.code === "revision_conflict",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace isolation: different workspaces have independent overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-override-iso-"));
  try {
    const wsA = join(root, "workspace-a");
    const wsB = join(root, "workspace-b");
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });
    const store = new LeaderWorkspaceOverrideStore({ pilotHome: root });

    const initA = await store.getOverride(wsA);
    await store.setOverride(wsA, { model: "model-a" }, initA.revision);

    const initB = await store.getOverride(wsB);
    await store.setOverride(wsB, { model: "model-b" }, initB.revision);

    const fetchA = await store.getOverride(wsA);
    const fetchB = await store.getOverride(wsB);
    assert.equal(fetchA.override?.model, "model-a");
    assert.equal(fetchB.override?.model, "model-b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setOverride with toolProfile custom stores tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-override-tp-"));
  try {
    const workspace = join(root, "project-tp");
    await mkdir(workspace, { recursive: true });
    const store = new LeaderWorkspaceOverrideStore({ pilotHome: root });

    const initial = await store.getOverride(workspace);
    await store.setOverride(workspace, {
      toolProfile: { mode: "custom", tools: ["bash", "web_search"] },
    }, initial.revision);

    const fetched = await store.getOverride(workspace);
    assert.ok(fetched.override?.toolProfile);
    assert.equal(fetched.override.toolProfile.mode, "custom");
    if (fetched.override.toolProfile.mode === "custom") {
      assert.ok(fetched.override.toolProfile.tools.includes("bash"));
      assert.ok(fetched.override.toolProfile.tools.includes("web_search"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("constructor rejects empty pilotHome", () => {
  assert.throws(
    () => new LeaderWorkspaceOverrideStore({ pilotHome: "" }),
    (error: unknown) => error instanceof LeaderOverrideStoreError && error.code === "invalid_input",
  );
});
