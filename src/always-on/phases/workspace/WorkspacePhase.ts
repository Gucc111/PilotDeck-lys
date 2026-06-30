import { existsSync } from "node:fs";
import { AlwaysOnError } from "../../protocol/errors.js";
import type { WorkspaceHandle } from "../../protocol/types.js";
import type { WorkspacePhaseDeps, WorkspacePhaseInput, WorkspacePhaseOutput } from "./types.js";

export class WorkspacePhase {
  constructor(private readonly deps: WorkspacePhaseDeps) {}

  async execute(input: WorkspacePhaseInput): Promise<WorkspacePhaseOutput> {
    this.deps.events.emit(input.runId, "workspace_started", { planId: input.planId });
    const { handle, cycle } = await this.prepare(input);
    this.assertWorkspaceCwdSafe(handle);
    if (input.startedAt) {
      handle.metadata.startedAt = input.startedAt.toISOString();
    }
    this.deps.events.emit(input.runId, "workspace_ready", { planId: input.planId });
    return { handle, cycle };
  }

  private async prepare(input: WorkspacePhaseInput): Promise<WorkspacePhaseOutput> {
    const fileExists = this.deps.fileExists ?? existsSync;
    if (input.state.activeWorkCycleId) {
      const activeCycle = await this.deps.cycleStore.getRecord(input.state.activeWorkCycleId);
      if (activeCycle && activeCycle.status === "active" && fileExists(activeCycle.workspace.cwd)) {
        return {
          handle: {
            runId: activeCycle.createdByRunId,
            projectKey: this.deps.projectKey,
            strategy: activeCycle.workspace.strategy,
            cwd: activeCycle.workspace.cwd,
            metadata: { ...activeCycle.workspace.metadata },
          },
          cycle: activeCycle,
        };
      }
    }

    const { handle } = await this.deps.workspaceRegistry.prepare({
      projectRoot: this.deps.projectKey,
      runId: input.runId,
      planTitle: input.planTitle,
    });

    const cycleId = this.deps.uuid();
    const cycle = await this.deps.cycleStore.create(handle, input.runId, cycleId, this.deps.now());
    await this.deps.stateStore.setActiveWorkCycleId(cycle.id, this.deps.now());

    return { handle, cycle };
  }

  private assertWorkspaceCwdSafe(workspace: WorkspaceHandle): void {
    if (workspace.cwd === this.deps.projectKey) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        "workspace cwd must not equal projectRoot — refusing to run Always-On turns in the project root.",
      );
    }
    const inWorktree = workspace.cwd.startsWith(this.deps.paths.worktreesDir);
    const inSnapshot = workspace.cwd.startsWith(this.deps.paths.snapshotsDir);
    if (!inWorktree && !inSnapshot) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        `workspace cwd ${workspace.cwd} is outside the configured Always-On workspace bases.`,
      );
    }
  }
}
