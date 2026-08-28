import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TeamSetStore,
  TeamSetStoreError,
} from "../../../src/extension/team-sets/index.js";

function minimalTeamSet(id: string, overrides: Record<string, unknown> = {}) {
  const { name, ...rest } = overrides;
  return {
    id,
    name: typeof name === "string" ? name : id,
    leader: { mode: "inherit" as const },
    teammates: {},
    ...rest,
  };
}

async function freshStore(): Promise<{ store: TeamSetStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teamset-"));
  const pilotHome = join(root, "pilot-home");
  await mkdir(pilotHome, { recursive: true });
  return { store: new TeamSetStore({ pilotHome }), root };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("TeamSetStore rejects empty pilotHome", () => {
  assert.throws(
    () => new TeamSetStore({ pilotHome: "" }),
    (error: unknown) => (error as TeamSetStoreError).code === "invalid_input",
  );
});

// ---------------------------------------------------------------------------
// CRUD lifecycle
// ---------------------------------------------------------------------------

test("create, read, list, update, delete lifecycle", async () => {
  const { store, root } = await freshStore();
  try {
    // list empty
    assert.deepEqual(await store.list(), []);

    // create
    const created = await store.create(minimalTeamSet("alpha", { name: "Alpha Team" }));
    assert.equal(created.teamSet.id, "alpha");
    assert.equal(created.teamSet.name, "Alpha Team");
    assert.equal(created.teamSet.schemaVersion, 1);
    assert.match(created.revision, /^[a-f0-9]{64}$/);

    // list after create
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, "alpha");
    assert.equal(listed[0]!.name, "Alpha Team");
    assert.equal(listed[0]!.leaderMode, "inherit");
    assert.equal(listed[0]!.teammateCount, 0);

    // read
    const read = await store.read("alpha");
    assert.deepEqual(read.teamSet, created.teamSet);
    assert.equal(read.revision, created.revision);

    // update
    const updated = await store.write(
      "alpha",
      minimalTeamSet("alpha", {
        name: "Alpha v2",
        description: "Updated",
        teammates: {
          worker: { toolProfile: { mode: "inherit" } },
        },
      }),
      created.revision,
    );
    assert.equal(updated.teamSet.name, "Alpha v2");
    assert.equal(updated.teamSet.description, "Updated");
    assert.equal(Object.keys(updated.teamSet.teammates).length, 1);
    assert.notEqual(updated.revision, created.revision);

    // list after update
    const listedAfter = await store.list();
    assert.equal(listedAfter[0]!.teammateCount, 1);

    // delete
    const deleted = await store.delete("alpha");
    assert.deepEqual(deleted, { ok: true, id: "alpha" });
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Duplicate ID
// ---------------------------------------------------------------------------

test("create rejects duplicate ID", async () => {
  const { store, root } = await freshStore();
  try {
    await store.create(minimalTeamSet("dup"));
    await assert.rejects(
      store.create(minimalTeamSet("dup")),
      (error: unknown) => (error as TeamSetStoreError).code === "duplicate_id",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

test("read and delete reject missing ID", async () => {
  const { store, root } = await freshStore();
  try {
    await assert.rejects(
      store.read("missing"),
      (error: unknown) => (error as TeamSetStoreError).code === "not_found",
    );
    await assert.rejects(
      store.delete("missing"),
      (error: unknown) => (error as TeamSetStoreError).code === "not_found",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Revision conflict
// ---------------------------------------------------------------------------

test("write rejects stale revision", async () => {
  const { store, root } = await freshStore();
  try {
    const created = await store.create(minimalTeamSet("rev-test"));
    await store.write("rev-test", minimalTeamSet("rev-test", { name: "v2" }), created.revision);
    await assert.rejects(
      store.write("rev-test", minimalTeamSet("rev-test", { name: "v3" }), created.revision),
      (error: unknown) => (error as TeamSetStoreError).code === "revision_conflict",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Invalid ID
// ---------------------------------------------------------------------------

test("create rejects invalid IDs", async () => {
  const { store, root } = await freshStore();
  try {
    for (const id of ["", "../escape", "has space", ".hidden"]) {
      await assert.rejects(
        store.create(minimalTeamSet(id)),
        (error: unknown) => (error as TeamSetStoreError).code === "invalid_input",
        `expected rejection for id=${JSON.stringify(id)}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Workspace assignment CRUD
// ---------------------------------------------------------------------------

test("workspace assignment get/set lifecycle", async () => {
  const { store, root } = await freshStore();
  const workspace = join(root, "project");
  await mkdir(workspace, { recursive: true });
  try {
    await store.create(minimalTeamSet("team-1"));

    // initially no assignment
    const initial = await store.getAssignment(workspace);
    assert.equal(initial.teamSetId, null);
    assert.match(initial.revision, /^[a-f0-9]{64}$/);

    // assign
    const assigned = await store.setAssignment(workspace, "team-1", initial.revision);
    assert.equal(assigned.teamSetId, "team-1");
    assert.notEqual(assigned.revision, initial.revision);

    // read back
    const readBack = await store.getAssignment(workspace);
    assert.equal(readBack.teamSetId, "team-1");

    // unassign
    const unassigned = await store.setAssignment(workspace, null, assigned.revision);
    assert.equal(unassigned.teamSetId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace assignment rejects missing team set", async () => {
  const { store, root } = await freshStore();
  const workspace = join(root, "project");
  await mkdir(workspace, { recursive: true });
  try {
    const initial = await store.getAssignment(workspace);
    await assert.rejects(
      store.setAssignment(workspace, "nonexistent", initial.revision),
      (error: unknown) => (error as TeamSetStoreError).code === "not_found",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace assignment rejects stale revision", async () => {
  const { store, root } = await freshStore();
  const workspace = join(root, "project");
  await mkdir(workspace, { recursive: true });
  try {
    await store.create(minimalTeamSet("team-1"));
    const initial = await store.getAssignment(workspace);
    await store.setAssignment(workspace, "team-1", initial.revision);
    await assert.rejects(
      store.setAssignment(workspace, null, initial.revision),
      (error: unknown) => (error as TeamSetStoreError).code === "revision_conflict",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Delete cascades: removes workspace assignments referencing the team set
// ---------------------------------------------------------------------------

test("deleting a team set clears its workspace assignments", async () => {
  const { store, root } = await freshStore();
  const workspace = join(root, "project");
  await mkdir(workspace, { recursive: true });
  try {
    await store.create(minimalTeamSet("doomed"));
    const initial = await store.getAssignment(workspace);
    await store.setAssignment(workspace, "doomed", initial.revision);
    assert.equal((await store.getAssignment(workspace)).teamSetId, "doomed");

    await store.delete("doomed");
    assert.equal((await store.getAssignment(workspace)).teamSetId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test("read rejects malformed JSON on disk", async () => {
  const { store, root } = await freshStore();
  try {
    await mkdir(store.teamSetsDir, { recursive: true });
    await writeFile(join(store.teamSetsDir, "bad.json"), "{invalid", "utf8");
    await assert.rejects(
      store.read("bad"),
      (error: unknown) => (error as TeamSetStoreError).code === "invalid_json",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read rejects wrong schemaVersion on disk", async () => {
  const { store, root } = await freshStore();
  try {
    await mkdir(store.teamSetsDir, { recursive: true });
    await writeFile(
      join(store.teamSetsDir, "wrong-version.json"),
      JSON.stringify({ schemaVersion: 999, id: "wrong-version", name: "x", leader: { mode: "inherit" }, teammates: {} }),
      "utf8",
    );
    await assert.rejects(
      store.read("wrong-version"),
      (error: unknown) => (error as TeamSetStoreError).code === "invalid_schema",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Leader config modes
// ---------------------------------------------------------------------------

test("create validates leader config modes", async () => {
  const { store, root } = await freshStore();
  try {
    // inherit mode
    const inherit = await store.create(minimalTeamSet("inherit-leader"));
    assert.equal(inherit.teamSet.leader.mode, "inherit");

    // override mode
    const override = await store.create({
      id: "override-leader",
      name: "Override",
      leader: {
        mode: "override",
        model: "fixture/override",
        prompt: "Custom prompt",
      },
      teammates: {},
    });
    assert.equal(override.teamSet.leader.mode, "override");
    const overrideLeader = override.teamSet.leader as { mode: "override"; model?: string; prompt?: string };
    assert.equal(overrideLeader.model, "fixture/override");
    assert.equal(overrideLeader.prompt, "Custom prompt");

    // standalone mode
    const standalone = await store.create({
      id: "standalone-leader",
      name: "Standalone",
      leader: {
        mode: "standalone",
        tools: ["bash"],
        plugins: [],
        skills: [],
        mcpServers: [],
        prompt: "Standalone prompt",
      },
      teammates: {},
    });
    assert.equal(standalone.teamSet.leader.mode, "standalone");
    const standaloneLeader = standalone.teamSet.leader as { mode: "standalone"; prompt: string };
    assert.equal(standaloneLeader.prompt, "Standalone prompt");

    // invalid mode
    await assert.rejects(
      store.create({
        id: "bad-leader",
        name: "Bad",
        leader: { mode: "invalid" } as never,
        teammates: {},
      }),
      (error: unknown) => (error as TeamSetStoreError).code === "invalid_input",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Teammate config validation
// ---------------------------------------------------------------------------

test("create validates teammate config", async () => {
  const { store, root } = await freshStore();
  try {
    // valid teammate with overrides
    const created = await store.create({
      id: "with-overrides",
      name: "With Overrides",
      leader: { mode: "inherit" },
      teammates: {
        reviewer: {
          toolProfile: { mode: "inherit" },
          contextPolicy: "fresh_per_delegation",
          modelOverride: "fixture/alt",
          promptOverride: "Be thorough.",
          maxContextTokensOverride: 50000,
          maxOutputTokensOverride: 4096,
        },
      },
    });
    const config = created.teamSet.teammates.reviewer!;
    assert.equal(config.contextPolicy, "fresh_per_delegation");
    assert.equal(config.modelOverride, "fixture/alt");
    assert.equal(config.promptOverride, "Be thorough.");
    assert.equal(config.maxContextTokensOverride, 50000);
    assert.equal(config.maxOutputTokensOverride, 4096);

    // missing toolProfile
    await assert.rejects(
      store.create({
        id: "missing-profile",
        name: "Bad",
        leader: { mode: "inherit" },
        teammates: { worker: {} as never },
      }),
      (error: unknown) => (error as TeamSetStoreError).code === "invalid_input",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Atomic writes produce valid JSON
// ---------------------------------------------------------------------------

test("created file is valid JSON with pretty formatting", async () => {
  const { store, root } = await freshStore();
  try {
    await store.create(minimalTeamSet("pretty"));
    const content = await readFile(join(store.teamSetsDir, "pretty.json"), "utf8");
    assert.ok(content.endsWith("\n"));
    const parsed = JSON.parse(content);
    assert.equal(parsed.id, "pretty");
    assert.ok(content.includes("\n  "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// list skips malformed files
// ---------------------------------------------------------------------------

test("list skips malformed JSON files", async () => {
  const { store, root } = await freshStore();
  try {
    await store.create(minimalTeamSet("good"));
    await writeFile(join(store.teamSetsDir, "bad.json"), "not json", "utf8");
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, "good");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// list returns sorted results
// ---------------------------------------------------------------------------

test("list returns team sets sorted by ID", async () => {
  const { store, root } = await freshStore();
  try {
    await store.create(minimalTeamSet("charlie"));
    await store.create(minimalTeamSet("alpha"));
    await store.create(minimalTeamSet("bravo"));
    const listed = await store.list();
    assert.deepEqual(listed.map((s) => s.id), ["alpha", "bravo", "charlie"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
