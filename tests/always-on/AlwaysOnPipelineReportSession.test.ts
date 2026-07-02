import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Gateway, GatewaySubmitTurnInput } from "../../src/gateway/index.js";
import { AlwaysOnPipeline } from "../../src/always-on/orchestration/AlwaysOnPipeline.js";
import { DiscoveryReportStore } from "../../src/always-on/infra/storage/file/DiscoveryReportStore.js";
import { initializeTemporaryGitRepository } from "../../src/always-on/infra/git/index.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/infra/storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../../src/always-on/infra/storage/json/DiscoveryPlanStore.js";
import { DiscoveryStateStore } from "../../src/always-on/infra/storage/json/DiscoveryStateStore.js";
import { WorkCycleStore } from "../../src/always-on/infra/storage/json/WorkCycleStore.js";
import type { DiscoveryPlanRecord, WorkspaceHandle } from "../../src/always-on/infra/storage/types.js";
import { WorkspaceProviderRegistry } from "../../src/always-on/phases/workspace/WorkspaceProviderRegistry.js";
import { AlwaysOnRunContextRegistry, deriveExecutionSessionKey, SessionConfigOverrides } from "../../src/always-on/phases/shared/index.js";

describe("AlwaysOnPipeline report session reuse", () => {
  it("submits report as a second turn on the execution session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-report-session-"));
    try {
      const projectRoot = join(root, "project");
      const pilotHome = join(root, "pilot-home");
      await mkdir(projectRoot, { recursive: true });

      const paths = resolveAlwaysOnPaths({ pilotHome, projectKey: projectRoot });
      const workspaceCwd = join(paths.worktreesDir, "run-1");
      await mkdir(workspaceCwd, { recursive: true });
      await writeFile(join(workspaceCwd, "base.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(workspaceCwd, "base");

      const planStore = new DiscoveryPlanStore(paths);
      const stateStore = new DiscoveryStateStore(paths);
      const cycleStore = new WorkCycleStore(paths);
      const reportStore = new DiscoveryReportStore(paths);
      const plan: DiscoveryPlanRecord = {
        id: "plan-1",
        title: "Plan 1",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "ready",
        summary: "summary",
        rationale: "rationale",
        dedupeKey: "plan-1",
        sourceRunId: "source-run",
        planFilePath: "plans/plan-1.md",
      };
      await planStore.writePlanMarkdown(plan.id, "# Plan 1\n\n## Execution Steps\n- Do work.\n");
      await planStore.upsert(plan);

      const workspaceRegistry = new WorkspaceProviderRegistry();
      workspaceRegistry.add({
        id: "snapshot-copy",
        priority: 1,
        isApplicable: async () => true,
        prepare: async (input): Promise<WorkspaceHandle> => ({
          runId: input.runId,
          projectKey: input.projectRoot,
          strategy: "snapshot-copy",
          cwd: workspaceCwd,
          metadata: { baseCommit },
        }),
        publish: async () => ({}),
        dispose: async () => undefined,
      });

      const submittedTurns: GatewaySubmitTurnInput[] = [];
      const closedSessions: string[] = [];
      const gateway: Gateway = {
        submitTurn: async function* (input: GatewaySubmitTurnInput) {
          submittedTurns.push(input);
        },
        abortTurn: async () => undefined,
        listSessions: async () => ({ sessions: [] }),
        resumeSession: async (input: { sessionKey: string }) => input,
        newSession: async () => ({ sessionKey: "" }),
        closeSession: async (input: { sessionKey: string }) => {
          closedSessions.push(input.sessionKey);
        },
        describeServer: async () => ({ mode: "in_process" }),
        cronCreate: async () => ({ id: "", enabled: false }),
      } as unknown as Gateway;

      let uuidCounter = 0;
      const pipeline = new AlwaysOnPipeline({
        config: { language: "en" } as any,
        paths,
        projectKey: projectRoot,
        gateway,
        runContexts: new AlwaysOnRunContextRegistry(),
        workspaceRegistry,
        sessionOverrides: new SessionConfigOverrides(),
        stateStore,
        planStore,
        cycleStore,
        reportStore,
        eventStore: { appendEvent: async () => undefined } as any,
        uuid: () => `uuid-${++uuidCounter}`,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });

      const result = await pipeline.rerunPlan({
        planId: plan.id,
        runId: "run-1",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      const expectedSessionKey = deriveExecutionSessionKey(projectRoot, "run-1");
      assert.equal(result.outcome, "executed");
      assert.equal(submittedTurns.length, 2);
      assert.equal(submittedTurns[0]?.channelKey, "always-on/execute");
      assert.equal(submittedTurns[1]?.channelKey, "always-on/report");
      assert.equal(submittedTurns[0]?.sessionKey, expectedSessionKey);
      assert.equal(submittedTurns[1]?.sessionKey, expectedSessionKey);
      assert.deepEqual(closedSessions, [expectedSessionKey]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
