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
    assert.deepEqual(await store.list(), { schemaVersion: 1, workspaces: {} });

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
    await store.set(worktree, ["implementer"]);

    assert.deepEqual(await store.get(main), ["implementer"]);
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
        [`teammate-${index}`],
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
    await manager.enablementStore.set(workspaceB, ["reviewer"]);

    await manager.delete("reviewer");

    assert.deepEqual(await manager.enablementStore.get(workspaceA), ["implementer"]);
    assert.deepEqual(await manager.enablementStore.get(workspaceB), []);
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
