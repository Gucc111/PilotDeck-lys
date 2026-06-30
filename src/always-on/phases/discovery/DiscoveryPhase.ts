import { existsSync } from "node:fs";
import type { GatewayChannelKey } from "../../../gateway/index.js";
import { getPilotProjectChatDir } from "../../../pilot/paths.js";
import type { DiscoveryRunContext } from "../../runtime/AlwaysOnRunContextRegistry.js";
import { deriveDiscoverySessionKey, pickFirstError } from "../shared/index.js";
import { buildChatDigest } from "./context/index.js";
import { preparePreferenceMemory } from "./memory/index.js";
import { buildDiscoveryPrompt } from "./prompts.js";
import type { DiscoveryPhaseDeps, DiscoveryPhaseInput, DiscoveryPhaseOutput } from "./types.js";

const DISCOVERY_CHANNEL: GatewayChannelKey = "always-on/discovery";

export class DiscoveryPhase {
  constructor(private readonly deps: DiscoveryPhaseDeps) {}

  async execute(input: DiscoveryPhaseInput): Promise<DiscoveryPhaseOutput> {
    const { runId, startedAt, state } = input;
    this.deps.events.emit(runId, "discovery_started");
    const sessionKey = deriveDiscoverySessionKey(this.deps.projectKey, runId);
    const fileExists = this.deps.fileExists ?? existsSync;

    const activeCycle = state.activeWorkCycleId
      ? await this.deps.cycleStore.getRecord(state.activeWorkCycleId)
      : undefined;
    const existingWorkspace = activeCycle && activeCycle.status === "active" && fileExists(activeCycle.workspace.cwd)
      ? { cwd: activeCycle.workspace.cwd, strategy: activeCycle.workspace.strategy, metadata: activeCycle.workspace.metadata }
      : state.currentWorkspace && fileExists(state.currentWorkspace.cwd)
        ? state.currentWorkspace
        : undefined;

    const discoveryCtx: DiscoveryRunContext = {
      kind: "discovery",
      sessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      startedAt,
      planStore: this.deps.planStore,
      planCallCount: 0,
    };
    this.deps.runContexts.register(discoveryCtx);
    this.deps.sessionOverrides.set(sessionKey, {
      cwd: existingWorkspace?.cwd ?? this.deps.projectKey,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...this.deps.excludeTools],
    });

    const chatDigest = await buildChatDigest({
      projectRoot: this.deps.projectKey,
      pilotHome: this.deps.paths.pilotHome,
      maxSessions: 10,
      maxPromptsPerSession: 8,
      maxPromptLength: 500,
    });
    discoveryCtx.chatSessionAliases = chatDigest.aliasMap;

    const planIndex = await this.deps.planStore.readIndex();
    const existingPlans = planIndex.plans.map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      dedupeKey: p.dedupeKey,
      status: p.status,
    }));

    const preferences = await preparePreferenceMemory({
      extractionThreshold: this.deps.config.memory.extractionThreshold,
      consolidationThreshold: this.deps.config.memory.consolidationThreshold,
      preferencesFile: this.deps.paths.preferencesFile,
      eventStore: this.deps.preferenceEventStore,
      llm: this.deps.preferenceLlm,
      language: this.deps.config.language,
      logger: this.deps.logger,
    });

    try {
      const events = await this.deps.turnRunner.run({
        sessionKey,
        channelKey: DISCOVERY_CHANNEL,
        runId: `${runId}.discovery`,
        message: buildDiscoveryPrompt({
          projectRoot: this.deps.projectKey,
          runId,
          createdAt: startedAt.toISOString(),
          chatDir: getPilotProjectChatDir(this.deps.projectKey, this.deps.paths.pilotHome),
          workspace: existingWorkspace
            ? { cwd: existingWorkspace.cwd, strategy: existingWorkspace.strategy }
            : undefined,
          chatDigest,
          existingPlans,
          preferences,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
      const discoveryError = pickFirstError(events);
      if (discoveryError && !discoveryCtx.plan) {
        return {
          kind: "failed",
          error: {
            code: discoveryError.code ?? "discovery_failed",
            message: discoveryError.message,
          },
        };
      }

      if (!discoveryCtx.plan) {
        this.deps.events.emit(runId, "no_plan", { outcome: "no_plan" });
        const finishedAt = this.deps.now();
        await this.deps.stateStore.markFireCompleted({
          outcome: "no_plan",
          runId,
          now: finishedAt,
        });
        await this.deps.stateStore.setDormant(finishedAt);
        return {
          kind: "no_plan",
          result: {
            outcome: "no_plan",
            runId,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
          },
        };
      }

      this.deps.events.emit(runId, "plan_produced", {
        title: discoveryCtx.plan.record.title,
        planId: discoveryCtx.plan.record.id,
      });
      return { kind: "plan", plan: discoveryCtx.plan };
    } finally {
      this.deps.runContexts.unregister(sessionKey);
      this.deps.sessionOverrides.delete(sessionKey);
      await this.deps.turnRunner.closeSession(sessionKey);
    }
  }
}
