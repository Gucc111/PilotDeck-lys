import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  DiscoveryPlanService,
  type DiscoveryPlanServiceDeps,
} from "../../src/always-on/web/DiscoveryPlanService.js";
import { PreferenceEventStore } from "../../src/always-on/infra/storage/log/PreferenceEventStore.js";
import { DiscoveryPlanStore } from "../../src/always-on/infra/storage/json/DiscoveryPlanStore.js";
import { WorkCycleStore } from "../../src/always-on/infra/storage/json/WorkCycleStore.js";
import { migrateLegacyPlanStatuses } from "../../src/always-on/infra/storage/json/PlanStatusMigration.js";
import { DiscoveryStateStore } from "../../src/always-on/infra/storage/json/DiscoveryStateStore.js";
import { DiscoveryReportStore } from "../../src/always-on/infra/storage/file/DiscoveryReportStore.js";
import type { AlwaysOnPaths } from "../../src/always-on/infra/storage/AlwaysOnPaths.js";
import type { PreferenceEvent, WorkspaceHandle } from "../../src/always-on/infra/storage/types.js";

type PlanSeed = {
  id: string;
  status: string;
};

type ExecutionSeed = {
  planId: string;
  status?: string;
  dependsOnPlanIds?: string[];
  dependencyAnalysisStatus?: string;
};

type Fixture = {
  root: string;
  projectDir: string;
  service: DiscoveryPlanService;
  disposed: Array<{ cwd: string; metadata?: Record<string, string> }>;
  cleared: string[];
  warnings: string[];
  readPlans(): Promise<Array<Record<string, unknown>>>;
  readCycles(): Promise<Array<Record<string, unknown>>>;
  readPreferenceEvents(): Promise<PreferenceEvent[]>;
  cleanup(): Promise<void>;
};

async function createFixture(input: {
  plans: PlanSeed[];
  executions?: ExecutionSeed[];
  preferenceWriteFails?: boolean;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-plan-service-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  const projectDir = join(pilotHome, "always-on", "projects", "project-id");
  const workspace = join(root, "workspace");
  await mkdir(join(projectDir, "plans"), { recursive: true });
  await mkdir(join(projectDir, "cycles"), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const plans = input.plans.map((plan) => ({
    id: plan.id,
    title: plan.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: plan.status,
    summary: `${plan.id} summary`,
    rationale: "",
    sourceRunId: `run-${plan.id}`,
    planFilePath: `plans/${plan.id}.md`,
    workCycleId: "cycle-1",
  }));
  await writeFile(
    join(projectDir, "plans", "index.json"),
    JSON.stringify({ schemaVersion: 1, plans }, null, 2),
    "utf8",
  );

  const executions = (input.executions ?? []).map((execution, index) => ({
    executionId: `execution-${index}`,
    runId: `run-${execution.planId}`,
    planId: execution.planId,
    status: execution.status ?? "completed",
    startedAt: `2026-01-01T00:00:0${index}.000Z`,
    finishedAt: `2026-01-01T00:00:1${index}.000Z`,
    baseCommit: "a".repeat(40),
    beforeHead: "b".repeat(40),
    afterHead: "c".repeat(40),
    commitShas: ["d".repeat(39) + String(index)],
    dependsOnPlanIds: execution.dependsOnPlanIds ?? [],
    dependencyReasons: [],
    dependencyAnalysisStatus: execution.dependencyAnalysisStatus ?? "clean",
  }));
  await writeFile(
    join(projectDir, "cycles", "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      cycles: [{
        id: "cycle-1",
        projectKey: projectRoot,
        status: "active",
        workspace: {
          strategy: "snapshot-copy",
          cwd: workspace,
          metadata: {
            baseCommit: "a".repeat(40),
            branchName: "always-on/test-run",
          },
        },
        planIds: plans.map((plan) => plan.id),
        executions,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdByRunId: "run-1",
      }],
    }, null, 2),
    "utf8",
  );

  const disposed: Array<{ cwd: string; metadata?: Record<string, string> }> = [];
  const cleared: string[] = [];
  const warnings: string[] = [];
  const preferenceEventsFile = join(projectDir, "memory", "preference-events.jsonl");
  class FailingPreferenceEventStore extends PreferenceEventStore {
    override async appendEvent(): Promise<void> {
      throw new Error("preference write failed");
    }
  }
  const deps: DiscoveryPlanServiceDeps = {
    createStores: () => {
      const paths: AlwaysOnPaths = {
        pilotHome,
        projectKey: projectRoot,
        projectId: "project-id",
        rootDir: join(pilotHome, "always-on"),
        projectDir,
        stateFile: join(projectDir, "state.json"),
        plansDir: join(projectDir, "plans"),
        planIndexFile: join(projectDir, "plans", "index.json"),
        cyclesDir: join(projectDir, "cycles"),
        cycleIndexFile: join(projectDir, "cycles", "index.json"),
        reportsDir: join(projectDir, "reports"),
        eventsFile: join(projectDir, "events.jsonl"),
        locksDir: join(projectDir, "locks"),
        discoveryLockFile: join(projectDir, "locks", "discovery.lock"),
        worktreesDir: join(pilotHome, "always-on", "worktrees", "project-id"),
        snapshotsDir: join(pilotHome, "always-on", "snapshots", "project-id"),
        memoryDir: join(projectDir, "memory"),
        preferenceEventsFile: join(projectDir, "memory", "preference-events.jsonl"),
        preferencesFile: join(projectDir, "memory", "preferences.md"),
      };
      return {
        planStore: new DiscoveryPlanStore(paths),
        cycleStore: new WorkCycleStore(paths),
        stateStore: new DiscoveryStateStore(paths),
        reportStore: new DiscoveryReportStore(paths),
      };
    },
    paths: { extractProjectDirectory: async () => projectRoot },
    sessions: { getSessions: async () => ({ sessions: [] }) },
    activity: { isSessionActive: () => false },
    planLifecycle: {
      getCycleWorkspaceStatus: async () => "",
      archivePlanCommits: async () => ({ archived: true }),
      disposeCycleWorkspace: async ({ cwd, metadata }) => {
        disposed.push({ cwd, metadata });
      },
    },
    state: {
      clearActiveWorkCycleId: async (rootPath) => {
        cleared.push(rootPath);
      },
    },
    preferenceEvents: {
      forProject: () => input.preferenceWriteFails
        ? new FailingPreferenceEventStore(preferenceEventsFile)
        : new PreferenceEventStore(preferenceEventsFile),
    },
    logger: {
      warn: (message) => {
        warnings.push(message);
      },
    },
  };

  return {
    root,
    projectDir,
    service: new DiscoveryPlanService(deps),
    disposed,
    cleared,
    warnings,
    async readPlans() {
      const parsed = JSON.parse(await readFile(join(projectDir, "plans", "index.json"), "utf8"));
      return parsed.plans;
    },
    async readCycles() {
      const parsed = JSON.parse(await readFile(join(projectDir, "cycles", "index.json"), "utf8"));
      return parsed.cycles;
    },
    async readPreferenceEvents() {
      return new PreferenceEventStore(preferenceEventsFile).readAll();
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => (
    error instanceof Error &&
    (error as Error & { code?: string }).code === code
  ));
}

describe("DiscoveryPlanService plan selection", () => {
  it("migrates legacy plan index statuses into cycle state and strips plan status fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-plan-status-migration-"));
    const pilotHome = join(root, "pilot-home");
    const projectRoot = join(root, "project");
    const projectDir = join(pilotHome, "always-on", "projects", "project-id");
    const paths: AlwaysOnPaths = {
      pilotHome,
      projectKey: projectRoot,
      projectId: "project-id",
      rootDir: join(pilotHome, "always-on"),
      projectDir,
      stateFile: join(projectDir, "state.json"),
      plansDir: join(projectDir, "plans"),
      planIndexFile: join(projectDir, "plans", "index.json"),
      cyclesDir: join(projectDir, "cycles"),
      cycleIndexFile: join(projectDir, "cycles", "index.json"),
      reportsDir: join(projectDir, "reports"),
      eventsFile: join(projectDir, "events.jsonl"),
      locksDir: join(projectDir, "locks"),
      discoveryLockFile: join(projectDir, "locks", "discovery.lock"),
      worktreesDir: join(pilotHome, "always-on", "worktrees", "project-id"),
      snapshotsDir: join(pilotHome, "always-on", "snapshots", "project-id"),
      memoryDir: join(projectDir, "memory"),
      preferenceEventsFile: join(projectDir, "memory", "preference-events.jsonl"),
      preferencesFile: join(projectDir, "memory", "preferences.md"),
    };
    try {
      await mkdir(paths.plansDir, { recursive: true });
      await mkdir(paths.cyclesDir, { recursive: true });
      await writeFile(paths.planIndexFile, JSON.stringify({
        schemaVersion: 1,
        plans: [
          { id: "ready", title: "Ready", createdAt: "2026-01-01T00:00:00.000Z", status: "ready", summary: "", rationale: "", sourceRunId: "run-1", planFilePath: "plans/ready.md" },
          { id: "linked", title: "Linked", createdAt: "2026-01-01T00:00:00.000Z", status: "completed_no_report", summary: "", rationale: "", sourceRunId: "run-2", planFilePath: "plans/linked.md", workCycleId: "cycle-1" },
          { id: "orphan", title: "Orphan", createdAt: "2026-01-01T00:00:00.000Z", status: "failed", summary: "", rationale: "", sourceRunId: "run-3", planFilePath: "plans/orphan.md" },
        ],
      }, null, 2), "utf8");
      await writeFile(paths.cycleIndexFile, JSON.stringify({
        schemaVersion: 2,
        cycles: [{
          id: "cycle-1",
          projectKey: projectRoot,
          status: "active",
          baseCommit: "",
          workspace: { strategy: "snapshot-copy", cwd: join(root, "workspace"), metadata: {} },
          plans: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          createdByRunId: "run-2",
        }],
      }, null, 2), "utf8");

      const planStore = new DiscoveryPlanStore(paths);
      const cycleStore = new WorkCycleStore(paths);
      await migrateLegacyPlanStatuses({ planStore, cycleStore });

      const planIndex = JSON.parse(await readFile(paths.planIndexFile, "utf8"));
      assert.equal(planIndex.plans.some((plan: Record<string, unknown>) => "status" in plan), false);
      const cycleIndex = await cycleStore.readIndex();
      assert.equal(cycleIndex.cycles.find((cycle) => cycle.id === "cycle-1")?.plans.linked?.status, "completed_no_report");
      assert.equal(cycleIndex.cycles.some((cycle) => cycle.plans.ready), false);
      const orphanCycle = cycleIndex.cycles.find((cycle) => cycle.plans.orphan);
      assert.equal(orphanCycle?.plans.orphan?.status, "failed");
      assert.equal((await planStore.getRecord("orphan"))?.workCycleId, orphanCycle?.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires dependency-closed apply and accepts completed_no_report", async () => {
    const fixture = await createFixture({
      plans: [
        { id: "a", status: "completed" },
        { id: "b", status: "completed_no_report" },
      ],
      executions: [
        { planId: "a" },
        { planId: "b", dependsOnPlanIds: ["a"] },
      ],
    });
    try {
      await rejectsWithCode(
        fixture.service.queueCycleApply("project", "cycle-1", ["b"]),
        "INVALID_SELECTION",
      );
      const result = await fixture.service.queueCycleApply("project", "cycle-1", ["a", "b"]);
      assert.deepEqual(result.planIds, ["a", "b"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("locks a work cycle while an apply is queued", async () => {
    const fixture = await createFixture({
      plans: [{ id: "a", status: "completed" }],
      executions: [{ planId: "a" }],
    });
    try {
      const queued = await fixture.service.queueCycleApply("project", "cycle-1", ["a"]);
      assert.equal(queued.cycle.status, "applying");
      assert.equal(typeof queued.executionToken, "string");
      assert.deepEqual(queued.cycle.applyLock, {
        token: queued.executionToken,
        planIds: ["a"],
        startedAt: queued.cycle.applyLock?.startedAt,
      });

      const [storedCycle] = await fixture.readCycles();
      assert.equal(storedCycle?.status, "applying");
      assert.equal((storedCycle?.applyLock as Record<string, unknown> | undefined)?.token, queued.executionToken);
      assert.deepEqual((storedCycle?.applyLock as Record<string, unknown> | undefined)?.planIds, ["a"]);

      await rejectsWithCode(
        fixture.service.queueCycleApply("project", "cycle-1", ["a"]),
        "APPLY_IN_PROGRESS",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects stale apply finalize tokens without changing cycle or plan state", async () => {
    const fixture = await createFixture({
      plans: [{ id: "a", status: "completed" }],
      executions: [{ planId: "a" }],
    });
    try {
      const queued = await fixture.service.queueCycleApply("project", "cycle-1", ["a"]);
      await rejectsWithCode(
        fixture.service.updateCycleExecution("project", "cycle-1", {
          status: "completed",
          executionToken: "wrong-token",
          planIds: queued.planIds,
        }),
        "APPLY_TOKEN_MISMATCH",
      );

      const [cycle] = await fixture.readCycles();
      assert.equal(cycle?.status, "applying");
      assert.equal((cycle?.applyLock as Record<string, unknown> | undefined)?.token, queued.executionToken);
      assert.equal((cycle?.plans as Record<string, { status: string }> | undefined)?.a?.status, "completed");
      assert.equal(Object.prototype.hasOwnProperty.call((await fixture.readPlans())[0] ?? {}, "status"), false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("clears the apply lock and restores active status after apply failure", async () => {
    const fixture = await createFixture({
      plans: [{ id: "a", status: "completed" }],
      executions: [{ planId: "a" }],
    });
    try {
      const queued = await fixture.service.queueCycleApply("project", "cycle-1", ["a"]);
      const result = await fixture.service.updateCycleExecution("project", "cycle-1", {
        status: "failed",
        executionToken: queued.executionToken,
        planIds: queued.planIds,
      });

      assert.equal(result.cycle.status, "active");
      assert.equal(result.cycle.applyLock, undefined);
      const [cycle] = await fixture.readCycles();
      assert.equal(cycle?.status, "active");
      assert.equal(cycle?.applyLock, undefined);
      assert.equal((cycle?.plans as Record<string, { status: string }> | undefined)?.a?.status, "completed");
      assert.equal(Object.prototype.hasOwnProperty.call((await fixture.readPlans())[0] ?? {}, "status"), false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps partial archive workspaces and blocks removing a required dependency", async () => {
    const fixture = await createFixture({
      plans: [
        { id: "a", status: "completed" },
        { id: "b", status: "completed" },
      ],
      executions: [
        { planId: "a" },
        { planId: "b", dependsOnPlanIds: ["a"] },
      ],
    });
    try {
      await rejectsWithCode(
        fixture.service.archiveCycle("project", "cycle-1", ["a"]),
        "INVALID_SELECTION",
      );

      const partial = await fixture.service.archiveCycle("project", "cycle-1", ["b"]);
      assert.deepEqual(partial.planIds, ["b"]);
      assert.deepEqual(
        (await fixture.readPreferenceEvents()).map((event) => (
          event.plans.map((plan) => `${plan.id}:${plan.outcome}`)
        )),
        [["b:archived"]],
      );
      assert.equal(fixture.disposed.length, 0);
      assert.equal((await fixture.readCycles())[0]?.status, "active");

      await fixture.service.archiveCycle("project", "cycle-1", ["a"]);
      assert.equal(fixture.disposed.length, 1);
      assert.equal(fixture.disposed[0]?.metadata?.branchName, "always-on/test-run");
      assert.equal(fixture.cleared.length, 1);
      assert.equal((await fixture.readCycles())[0]?.status, "archived");
      assert.deepEqual(
        (await fixture.readPreferenceEvents()).map((event) => event.plans.map((plan) => plan.id)),
        [["b"], ["a"]],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("allows only whole-cycle archive when dependency analysis failed", async () => {
    const fixture = await createFixture({
      plans: [
        { id: "a", status: "completed" },
        { id: "b", status: "completed" },
      ],
      executions: [
        { planId: "a", dependencyAnalysisStatus: "failed" },
        { planId: "b" },
      ],
    });
    try {
      await rejectsWithCode(
        fixture.service.archiveCycle("project", "cycle-1", ["a"]),
        "INVALID_SELECTION",
      );
      const result = await fixture.service.archiveCycle("project", "cycle-1");
      assert.deepEqual(result.planIds, ["a", "b"]);
      assert.equal(fixture.disposed.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects applying completed plans without recorded commits", async () => {
    const fixture = await createFixture({
      plans: [
        { id: "a", status: "completed" },
        { id: "b", status: "completed_no_report" },
      ],
    });
    try {
      await rejectsWithCode(
        fixture.service.queueCycleApply("project", "cycle-1", ["a"]),
        "INVALID_SELECTION",
      );
      await rejectsWithCode(
        fixture.service.queueCycleApply("project", "cycle-1"),
        "INVALID_SELECTION",
      );
      assert.equal((await fixture.readCycles())[0]?.status, "active");
      assert.equal(fixture.disposed.length, 0);
      assert.deepEqual(await fixture.readPreferenceEvents(), []);
    } finally {
      await fixture.cleanup();
    }
  });

  it("migrates v1 execution metadata and rejects plans without commits", async () => {
    const fixture = await createFixture({
      plans: [
        { id: "a", status: "completed" },
        { id: "b", status: "completed" },
      ],
      executions: [{ planId: "a" }],
    });
    try {
      await rejectsWithCode(
        fixture.service.queueCycleApply("project", "cycle-1"),
        "INVALID_SELECTION",
      );
      const queued = await fixture.service.queueCycleApply("project", "cycle-1", ["a"]);
      assert.deepEqual(queued.planIds, ["a"]);
      await fixture.service.updateCycleExecution("project", "cycle-1", {
        status: "failed",
        executionToken: queued.executionToken,
        planIds: queued.planIds,
      });
      const archived = await fixture.service.archiveCycle("project", "cycle-1", ["a"]);
      assert.deepEqual(archived.planIds, ["a"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("marks selected plans applied and unselected plans archived after apply", async () => {
    const fixture = await createFixture({
      plans: [
        { id: "a", status: "completed" },
        { id: "b", status: "completed" },
      ],
      executions: [
        { planId: "a" },
        { planId: "b" },
      ],
    });
    try {
      const queued = await fixture.service.queueCycleApply("project", "cycle-1", ["a"]);
      const finalized = await fixture.service.updateCycleExecution("project", "cycle-1", {
        status: "completed",
        executionToken: queued.executionToken,
        planIds: queued.planIds,
      });

      assert.deepEqual(finalized.planIds, ["a"]);
      const cyclePlans = ((await fixture.readCycles())[0]?.plans ?? {}) as Record<string, { status: string }>;
      const statuses = new Map(Object.entries(cyclePlans).map(([planId, state]) => [planId, state.status]));
      assert.equal(statuses.get("a"), "applied");
      assert.equal(statuses.get("b"), "archived");
      assert.equal((await fixture.readPlans()).some((plan) => Object.prototype.hasOwnProperty.call(plan, "status")), false);
      assert.equal((await fixture.readCycles())[0]?.status, "applied");
      assert.equal(fixture.disposed.length, 1);
      assert.equal(fixture.disposed[0]?.metadata?.branchName, "always-on/test-run");
      assert.equal(fixture.cleared.length, 1);
      const overview = await fixture.service.getPlansOverview("project");
      assert.equal(overview.plans.find((plan) => plan.id === "a")?.status, "applied");
      const events = await fixture.readPreferenceEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0]?.action, "apply");
      assert.deepEqual(
        events[0]?.plans.map((plan) => `${plan.id}:${plan.outcome}`),
        ["a:applied", "b:archived"],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("records all selected plans as applied for whole-cycle apply", async () => {
    const fixture = await createFixture({
      plans: [
        { id: "a", status: "completed" },
        { id: "b", status: "completed_no_report" },
      ],
      executions: [{ planId: "a" }, { planId: "b" }],
    });
    try {
      const queued = await fixture.service.queueCycleApply("project", "cycle-1");
      await fixture.service.updateCycleExecution("project", "cycle-1", {
        status: "completed",
        executionToken: queued.executionToken,
        planIds: queued.planIds,
      });
      const [event] = await fixture.readPreferenceEvents();
      assert.deepEqual(
        event?.plans.map((plan) => `${plan.id}:${plan.outcome}`),
        ["a:applied", "b:applied"],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps archive successful when preference persistence fails", async () => {
    const fixture = await createFixture({
      plans: [{ id: "a", status: "completed" }],
      executions: [{ planId: "a" }],
      preferenceWriteFails: true,
    });
    try {
      const result = await fixture.service.archiveCycle("project", "cycle-1", ["a"]);
      assert.deepEqual(result.planIds, ["a"]);
      assert.equal((((await fixture.readCycles())[0]?.plans ?? {}) as Record<string, { status: string }>).a?.status, "archived");
      assert.equal(Object.prototype.hasOwnProperty.call((await fixture.readPlans())[0] ?? {}, "status"), false);
      assert.equal(fixture.warnings.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps apply successful when preference persistence fails and does not duplicate finalize events", async () => {
    const fixture = await createFixture({
      plans: [{ id: "a", status: "completed" }],
      executions: [{ planId: "a" }],
      preferenceWriteFails: true,
    });
    try {
      const queued = await fixture.service.queueCycleApply("project", "cycle-1", ["a"]);
      const result = await fixture.service.updateCycleExecution("project", "cycle-1", {
        status: "completed",
        executionToken: queued.executionToken,
        planIds: queued.planIds,
      });
      assert.equal(result.cycle.status, "applied");
      assert.equal((((await fixture.readCycles())[0]?.plans ?? {}) as Record<string, { status: string }>).a?.status, "applied");
      assert.equal(Object.prototype.hasOwnProperty.call((await fixture.readPlans())[0] ?? {}, "status"), false);
      assert.equal(fixture.warnings.length, 1);

      await fixture.service.updateCycleExecution("project", "cycle-1", {
        status: "completed",
        executionToken: queued.executionToken,
        planIds: queued.planIds,
      });
      assert.equal(fixture.warnings.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("WorkCycleStore apply lock", () => {
  it("allows one active cycle apply and rejects duplicate beginApply calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-cycle-lock-"));
    try {
      const projectRoot = join(root, "project");
      const projectDir = join(root, "always-on", "projects", "project-id");
      const paths: AlwaysOnPaths = {
        pilotHome: root,
        projectKey: projectRoot,
        projectId: "project-id",
        rootDir: join(root, "always-on"),
        projectDir,
        stateFile: join(projectDir, "state.json"),
        plansDir: join(projectDir, "plans"),
        planIndexFile: join(projectDir, "plans", "index.json"),
        cyclesDir: join(projectDir, "cycles"),
        cycleIndexFile: join(projectDir, "cycles", "index.json"),
        reportsDir: join(projectDir, "reports"),
        eventsFile: join(projectDir, "events.jsonl"),
        locksDir: join(projectDir, "locks"),
        discoveryLockFile: join(projectDir, "locks", "discovery.lock"),
        worktreesDir: join(root, "worktrees"),
        snapshotsDir: join(root, "snapshots"),
        memoryDir: join(projectDir, "memory"),
        preferenceEventsFile: join(projectDir, "memory", "preference-events.jsonl"),
        preferencesFile: join(projectDir, "memory", "preferences.md"),
      };
      const store = new WorkCycleStore(paths);
      const handle: WorkspaceHandle = {
        runId: "run-1",
        projectKey: paths.projectKey,
        strategy: "snapshot-copy",
        cwd: join(root, "workspace"),
        metadata: { baseCommit: "base" },
      };
      await store.create(handle, "run-1", "cycle-1", new Date("2026-01-01T00:00:00.000Z"));

      const locked = await store.beginApply("cycle-1", {
        token: "token-1",
        planIds: ["plan-a"],
        now: new Date("2026-01-01T00:01:00.000Z"),
      });

      assert.equal(locked.status, "applying");
      assert.deepEqual(locked.applyLock, {
        token: "token-1",
        planIds: ["plan-a"],
        startedAt: "2026-01-01T00:01:00.000Z",
      });

      await rejectsWithCode(
        store.beginApply("cycle-1", {
          token: "token-2",
          planIds: ["plan-a"],
          now: new Date("2026-01-01T00:02:00.000Z"),
        }),
        "APPLY_IN_PROGRESS",
      );

      await store.updateStatus("cycle-1", "active", new Date("2026-01-01T00:03:00.000Z"));
      const restored = await store.getRecord("cycle-1");
      assert.equal(restored?.status, "active");
      assert.equal(restored?.applyLock, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
