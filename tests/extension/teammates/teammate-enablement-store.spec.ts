import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  GlobalTeammateMutationLock,
  TeammateEnablementStore,
  TeammateEnablementStoreError,
  TeammateManager,
  canonicalizeTeammateWorkspace,
  getGlobalTeammateMutationLockPath,
  normalizeTeammateWorkspaceKey,
} from "../../../src/extension/teammates/index.js";
import {
  getPilotTeammateEnablementFilePath,
  getPilotTeammatesDir,
} from "../../../src/pilot/index.js";

const execFileAsync = promisify(execFile);

test("global teammate path helpers stay below PILOT_HOME", () => {
  const pilotHome = resolve("/tmp", "pilot-home");
  assert.equal(getPilotTeammatesDir(pilotHome), join(pilotHome, "teammates"));
  assert.equal(
    getPilotTeammateEnablementFilePath(pilotHome),
    join(pilotHome, "teammates", "workspace-enablement.json"),
  );
});

test("TeammateEnablementStore defaults to disabled and isolates workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-enablement-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
    ]);
    const store = new TeammateEnablementStore({ pilotHome });

    assert.deepEqual(await store.get(workspaceA), []);
    assert.deepEqual(await store.list(), { schemaVersion: 2, workspaces: {} });

    assert.deepEqual(
      await store.set(workspaceA, ["reviewer", "implementer", "reviewer"]),
      ["implementer", "reviewer"],
    );
    await store.set(workspaceB, ["researcher"]);

    assert.deepEqual(await store.get(workspaceA), ["implementer", "reviewer"]);
    assert.deepEqual(await store.get(workspaceB), ["researcher"]);
    assert.equal(Object.keys((await store.list()).workspaces).length, 2);
    await assert.rejects(
      () => store.set(workspaceA, ["../invalid"]),
      (error: unknown) =>
        error instanceof TeammateEnablementStoreError &&
        error.code === "invalid_input",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TeammateEnablementStore migrates V1 bindings and writes only V2", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-v1-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspace = join(root, "workspace");
    const filePath = getPilotTeammateEnablementFilePath(pilotHome);
    await Promise.all([
      mkdir(join(pilotHome, "teammates"), { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    const canonicalWorkspace = await canonicalizeTeammateWorkspace(workspace);
    await writeFile(
      filePath,
      `${JSON.stringify({
        schemaVersion: 1,
        workspaces: { [canonicalWorkspace]: ["reviewer", "implementer"] },
      })}\n`,
      "utf8",
    );
    const store = new TeammateEnablementStore({ pilotHome });

    const migrated = await store.getBindings(workspace);
    assert.deepEqual(migrated.bindings, {
      implementer: { enabled: true, toolProfile: { mode: "inherit" }, contextPolicy: "persistent" },
      reviewer: { enabled: true, toolProfile: { mode: "inherit" }, contextPolicy: "persistent" },
    });

    await store.set(workspace, ["reviewer"]);
    const written = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(written.schemaVersion, 2);
    assert.deepEqual(written.workspaces[canonicalWorkspace], {
      reviewer: { enabled: true, toolProfile: { mode: "inherit" }, contextPolicy: "persistent" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy enabled-ID updates preserve retained custom profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-custom-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const store = new TeammateEnablementStore({ pilotHome });
    const initial = await store.getBindings(workspace);
    const custom = {
      enabled: true,
      contextPolicy: "persistent" as const,
      toolProfile: {
        mode: "custom" as const,
        tools: ["read_file", "bash"],
        constraints: {
          allow: [{
            version: 2 as const,
            toolName: "bash",
            conditions: [{
              subject: "bash.command" as const,
              operator: "executableEquals" as const,
              value: "git",
            }],
          }],
          deny: [],
        },
      },
    };
    await store.setBinding(workspace, "reviewer", custom, initial.revision);

    await store.set(workspace, ["reviewer", "implementer"]);

    assert.deepEqual((await store.getBinding(workspace, "reviewer")).binding, {
      ...custom,
      toolProfile: {
        ...custom.toolProfile,
        tools: ["bash", "read_file"],
      },
    });
    assert.deepEqual(await store.get(workspace), ["implementer", "reviewer"]);

    await store.set(workspace, ["implementer"]);

    assert.deepEqual((await store.getBinding(workspace, "reviewer")).binding, {
      ...custom,
      enabled: false,
      toolProfile: {
        ...custom.toolProfile,
        tools: ["bash", "read_file"],
      },
    });
    assert.deepEqual(await store.get(workspace), ["implementer"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace bindings persist teammate context policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-context-policy-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const store = new TeammateEnablementStore({ pilotHome });
    const initial = await store.getBindings(workspace);

    await store.setBinding(
      workspace,
      "reviewer",
      {
        enabled: true,
        contextPolicy: "fresh_per_delegation",
        toolProfile: { mode: "inherit" },
      },
      initial.revision,
    );

    assert.deepEqual((await store.getBinding(workspace, "reviewer")).binding, {
      enabled: true,
      contextPolicy: "fresh_per_delegation",
      toolProfile: { mode: "inherit" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding writes reject stale revisions without overwriting concurrent changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-revision-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const first = new TeammateEnablementStore({ pilotHome });
    const second = new TeammateEnablementStore({ pilotHome });
    const snapshot = await first.getBindings(workspace);

    await first.setBinding(
      workspace,
      "reviewer",
      { enabled: true, toolProfile: { mode: "inherit" } },
      snapshot.revision,
    );
    await assert.rejects(
      () =>
        second.setBinding(
          workspace,
          "implementer",
          { enabled: true, toolProfile: { mode: "inherit" } },
          snapshot.revision,
        ),
      (error: unknown) =>
        error instanceof TeammateEnablementStoreError &&
        error.code === "revision_conflict",
    );
    assert.deepEqual(await first.get(workspace), ["reviewer"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom binding normalization rejects incomplete and unknown selector fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-strict-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const store = new TeammateEnablementStore({ pilotHome });
    const { revision } = await store.getBindings(workspace);

    await assert.rejects(
      () =>
        store.setBinding(
          workspace,
          "reviewer",
          {
            enabled: true,
            toolProfile: {
              mode: "custom",
              tools: ["bash"],
            },
          } as never,
          revision,
        ),
      (error: unknown) =>
        error instanceof TeammateEnablementStoreError &&
        error.code === "invalid_input",
    );
    await assert.rejects(
      () =>
        store.setBinding(
          workspace,
          "reviewer",
          {
            enabled: true,
            toolProfile: {
              mode: "custom",
              tools: ["bash"],
              constraints: {
                allow: [{ version: 2, toolName: "bash", unknown: true }],
                deny: [],
              },
            },
          } as never,
          revision,
        ),
      (error: unknown) =>
        error instanceof TeammateEnablementStoreError &&
        error.code === "invalid_input",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TeammateEnablementStore shares enablement across git worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-worktree-"));
  try {
    const main = join(root, "main");
    const worktree = join(root, "worktree");
    const pilotHome = join(root, "pilot-home");
    await execFileAsync("git", ["init", main]);
    await writeFile(join(main, "README.md"), "fixture\n", "utf8");
    await execFileAsync("git", ["-C", main, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      main,
      "-c",
      "user.name=PilotDeck Test",
      "-c",
      "user.email=pilotdeck@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await execFileAsync("git", [
      "-C",
      main,
      "worktree",
      "add",
      "-b",
      "feature",
      worktree,
    ]);

    const store = new TeammateEnablementStore({ pilotHome });
    const initial = await store.getBindings(worktree);
    await store.setBinding(
      worktree,
      "implementer",
      {
        enabled: true,
        toolProfile: {
          mode: "custom",
          tools: ["read_file"],
          constraints: { allow: [], deny: [] },
        },
      },
      initial.revision,
    );

    assert.deepEqual(await store.get(main), ["implementer"]);
    assert.equal(
      (await store.getBinding(main, "implementer")).binding?.toolProfile.mode,
      "custom",
    );
    assert.deepEqual(Object.keys((await store.list()).workspaces), [
      await canonicalizeTeammateWorkspace(main),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TeammateEnablementStore serializes atomic updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-atomic-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspaces = ["a", "b", "c"].map((name) => join(root, name));
    await Promise.all(workspaces.map((workspace) => mkdir(workspace, { recursive: true })));
    const store = new TeammateEnablementStore({ pilotHome });

    await Promise.all([
      store.set(workspaces[0]!, ["reviewer"]),
      store.set(workspaces[1]!, ["implementer"]),
      store.set(workspaces[2]!, ["researcher"]),
    ]);

    assert.equal(Object.keys((await store.list()).workspaces).length, 3);
    const teammateRoot = getPilotTeammatesDir(pilotHome);
    assert.deepEqual(
      (await readdir(teammateRoot)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    assert.deepEqual(
      JSON.parse(await readFile(getPilotTeammateEnablementFilePath(pilotHome), "utf8")),
      await store.list(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TeammateEnablementStore preserves concurrent updates across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-cross-process-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspaces = Array.from({ length: 12 }, (_, index) =>
      join(root, `workspace-${index}`));
    await Promise.all(workspaces.map((workspace) => mkdir(workspace, { recursive: true })));

    await Promise.all(
      workspaces.map((workspace, index) =>
        new TeammateEnablementStore({ pilotHome }).set(workspace, [`teammate-${index}`])),
    );

    const document = await new TeammateEnablementStore({ pilotHome }).list();
    assert.equal(Object.keys(document.workspaces).length, workspaces.length);
    for (let index = 0; index < workspaces.length; index += 1) {
      assert.deepEqual(
        document.workspaces[await canonicalizeTeammateWorkspace(workspaces[index]!)],
        {
          [`teammate-${index}`]: {
            enabled: true,
            contextPolicy: "persistent",
            toolProfile: { mode: "inherit" },
          },
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global teammate mutation lock recovers dead owners and times out finitely", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-stale-lock-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const lockPath = getGlobalTeammateMutationLockPath(pilotHome);
    await mkdir(join(pilotHome, "teammates"), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ token: "stale", pid: 2_147_483_647, createdAt: 0 })}\n`,
      "utf8",
    );
    await utimes(lockPath, new Date(0), new Date(0));

    const recovered = new GlobalTeammateMutationLock(lockPath, {
      timeoutMs: 500,
      retryDelayMs: 5,
    });
    assert.equal(await recovered.runExclusive(async () => "recovered"), "recovered");

    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolveGate) => {
      releaseHolder = resolveGate;
    });
    const holder = recovered.runExclusive(() => holderGate);
    while (!(await fileExists(lockPath))) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    const waiter = new GlobalTeammateMutationLock(lockPath, {
      timeoutMs: 40,
      retryDelayMs: 5,
    });
    await assert.rejects(
      () => waiter.runExclusive(async () => undefined),
      /Timed out waiting for global teammate mutation lock/,
    );
    releaseHolder();
    await holder;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TeammateEnablementStore rejects damaged JSON and schema without enabling", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-corrupt-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspace = join(root, "workspace");
    const filePath = getPilotTeammateEnablementFilePath(pilotHome);
    await mkdir(join(pilotHome, "teammates"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    const store = new TeammateEnablementStore({ pilotHome });

    await writeFile(filePath, "{not-json", "utf8");
    await assert.rejects(
      () => store.get(workspace),
      (error: unknown) =>
        error instanceof TeammateEnablementStoreError &&
        error.code === "invalid_json",
    );

    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        workspaces: { [resolve(workspace)]: ["valid", 42] },
      }),
      "utf8",
    );
    await assert.rejects(
      () => store.set(workspace, ["implementer"]),
      (error: unknown) =>
        error instanceof TeammateEnablementStoreError &&
        error.code === "invalid_schema",
    );
    assert.match(await readFile(filePath, "utf8"), /42/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting a global teammate prunes every workspace enablement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-prune-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
    ]);
    const manager = new TeammateManager({ pilotHome });
    await manager.create({
      document: {
        id: "reviewer",
        name: "Reviewer",
        prompt: "Review the assigned change.",
      },
    });
    await manager.enablementStore.set(workspaceA, ["implementer", "reviewer"]);
    const workspaceBRevision = (await manager.enablementStore.getBindings(workspaceB)).revision;
    await manager.enablementStore.setBinding(
      workspaceB,
      "reviewer",
      {
        enabled: false,
        toolProfile: {
          mode: "custom",
          tools: [],
          constraints: { allow: [], deny: [] },
        },
      },
      workspaceBRevision,
    );

    await manager.delete("reviewer");

    assert.deepEqual(await manager.enablementStore.get(workspaceA), ["implementer"]);
    assert.deepEqual(await manager.enablementStore.get(workspaceB), []);
    assert.equal(
      (await manager.enablementStore.getBinding(workspaceB, "reviewer")).binding,
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delete restores the definition when enablement pruning fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-delete-rollback-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const manager = new TeammateManager({ pilotHome });
    await manager.create({
      document: { id: "reviewer", name: "Reviewer", prompt: "Review work." },
    });
    await writeFile(manager.enablementStore.filePath, "{broken", "utf8");

    await assert.rejects(
      () => manager.delete("reviewer"),
      (error: unknown) =>
        error instanceof TeammateEnablementStoreError &&
        error.code === "invalid_json",
    );
    assert.equal((await manager.get("reviewer"))?.id, "reviewer");
    assert.deepEqual(
      (await readdir(join(pilotHome, "teammates")))
        .filter((name) => name.endsWith(".deleted")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delete and enablement set cannot leave a stale enabled teammate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-delete-race-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const deletingManager = new TeammateManager({ pilotHome });
    const settingManager = new TeammateManager({ pilotHome });
    await deletingManager.create({
      document: { id: "reviewer", name: "Reviewer", prompt: "Review work." },
    });
    await settingManager.setEnablement(workspace, ["reviewer"]);

    const [deleted, set] = await Promise.allSettled([
      deletingManager.delete("reviewer"),
      settingManager.setEnablement(workspace, ["reviewer"]),
    ]);

    assert.equal(deleted.status, "fulfilled");
    if (set.status === "rejected") {
      assert.match(String(set.reason), /Unknown or invalid teammate IDs/);
    }
    assert.equal(await deletingManager.get("reviewer"), null);
    assert.deepEqual(await settingManager.getEnablement(workspace), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace canonicalization resolves symlinks and normalizes Unicode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammate-canonical-"));
  try {
    const composed = join(root, "caf\u00e9");
    const linked = join(root, "linked");
    await mkdir(composed, { recursive: true });
    await symlink(composed, linked, "dir");

    assert.equal(
      await canonicalizeTeammateWorkspace(linked),
      await canonicalizeTeammateWorkspace(composed),
    );
    assert.equal(
      normalizeTeammateWorkspaceKey(join(root, "cafe\u0301")),
      normalizeTeammateWorkspaceKey(composed),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows teammate workspace keys are case-insensitive", () => {
  assert.equal(
    normalizeTeammateWorkspaceKey("/Users/Example/Repo", "win32"),
    normalizeTeammateWorkspaceKey("/users/example/repo", "win32"),
  );
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
