import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  DiscoveryPlanService,
  type DiscoveryPlanServiceDeps,
} from "../../src/always-on/web/DiscoveryPlanService.js";
import { PreferenceEventStore } from "../../src/always-on/storage/PreferenceEventStore.js";
import type { PreferenceEvent } from "../../src/always-on/protocol/types.js";

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
  disposed: string[];
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
    dedupeKey: plan.id,
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
          metadata: { baseCommit: "a".repeat(40) },
        },
        planIds: plans.map((plan) => plan.id),
        executions,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdByRunId: "run-1",
      }],
    }, null, 2),
    "utf8",
  );

  const disposed: string[] = [];
  const cleared: string[] = [];
  const warnings: string[] = [];
  const preferenceEventsFile = join(projectDir, "memory", "preference-events.jsonl");
  class FailingPreferenceEventStore extends PreferenceEventStore {
    override async appendEvent(): Promise<void> {
      throw new Error("preference write failed");
    }
  }
  const deps: DiscoveryPlanServiceDeps = {
    pilotHome,
    resolveProjectId: () => "project-id",
    paths: { extractProjectDirectory: async () => projectRoot },
    sessions: { getSessions: async () => ({ sessions: [] }) },
    activity: { isSessionActive: () => false },
    workspace: {
      applyWorktreeChanges: async () => ({ applied: true }),
      disposeWorkspace: async (_strategy, cwd) => {
        disposed.push(cwd);
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
      assert.equal(result.legacyWorkspaceApply, false);
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
      assert.deepEqual(fixture.disposed, []);
      assert.equal((await fixture.readCycles())[0]?.status, "active");

      await fixture.service.archiveCycle("project", "cycle-1", ["a"]);
      assert.equal(fixture.disposed.length, 1);
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

  it("supports whole-cycle legacy apply but rejects legacy partial apply", async () => {
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
      const queued = await fixture.service.queueCycleApply("project", "cycle-1");
      assert.equal(queued.legacyWorkspaceApply, true);
      assert.deepEqual(queued.planIds, ["a", "b"]);
      await fixture.service.updateCycleExecution("project", "cycle-1", {
        status: "failed",
        planIds: queued.planIds,
      });
      assert.equal((await fixture.readCycles())[0]?.status, "active");
      assert.deepEqual(fixture.disposed, []);
      assert.deepEqual(await fixture.readPreferenceEvents(), []);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed for cycles mixing present and missing execution metadata", async () => {
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
      await rejectsWithCode(
        fixture.service.archiveCycle("project", "cycle-1", ["a"]),
        "INVALID_SELECTION",
      );
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
        planIds: queued.planIds,
      });

      assert.deepEqual(finalized.planIds, ["a"]);
      const statuses = new Map((await fixture.readPlans()).map((plan) => [plan.id, plan.status]));
      assert.equal(statuses.get("a"), "applied");
      assert.equal(statuses.get("b"), "archived");
      assert.equal((await fixture.readCycles())[0]?.status, "applied");
      assert.equal(fixture.disposed.length, 1);
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
      assert.equal((await fixture.readPlans())[0]?.status, "archived");
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
        planIds: queued.planIds,
      });
      assert.equal(result.cycle.status, "applied");
      assert.equal((await fixture.readPlans())[0]?.status, "applied");
      assert.equal(fixture.warnings.length, 1);

      await fixture.service.updateCycleExecution("project", "cycle-1", {
        status: "completed",
        planIds: queued.planIds,
      });
      assert.equal(fixture.warnings.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });
});
