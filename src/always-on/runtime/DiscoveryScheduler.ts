import { existsSync } from "node:fs";
import type { AlwaysOnConfig } from "../config/index.js";
import { AlwaysOnError } from "../protocol/errors.js";
import type { GateBlockReason } from "../protocol/types.js";
import type { AlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { DiscoveryStateStore } from "../storage/json/DiscoveryStateStore.js";
import { WorkCycleStore } from "../storage/json/WorkCycleStore.js";
import { AlwaysOnEventStore } from "../storage/log/AlwaysOnEventStore.js";
import type { ChannelLeaseRegistry } from "./ChannelLeaseRegistry.js";
import {
  acquireDiscoveryLock,
  DiscoveryFire,
  releaseDiscoveryLock,
} from "./DiscoveryFire.js";
import { evaluateAlwaysOnDiscoveryGates } from "./DiscoveryGates.js";
import { SignalWatcher } from "./SignalWatcher.js";

export type DiscoverySchedulerLogger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

export type DiscoverySchedulerDependencies = {
  config: AlwaysOnConfig;
  projectKey: string;
  paths: AlwaysOnPaths;
  stateStore: DiscoveryStateStore;
  cycleStore: WorkCycleStore;
  leases: ChannelLeaseRegistry;
  fire: DiscoveryFire;
  uuid: () => string;
  now: () => Date;
  logger: DiscoverySchedulerLogger;
  isSessionInFlight: () => boolean;
  eventStore?: AlwaysOnEventStore;
  disableAlwaysOnProject?: (input: {
    projectKey: string;
    stage: "internal";
    runId: string;
    error: { code: string; message: string };
  }) => Promise<void>;
};

export class DiscoveryScheduler {
  private timer: NodeJS.Timeout | undefined;
  private watcher: SignalWatcher | undefined;
  private running = false;
  private stopped = false;
  private tickInProgress: Promise<void> | undefined;

  constructor(private readonly deps: DiscoverySchedulerDependencies) {}

  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.running) return;
    this.running = true;
    await this.maybeRestoreDormancy();
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.watcher?.stop();
    this.watcher = undefined;
    if (this.tickInProgress) {
      await this.tickInProgress.catch(() => undefined);
    }
  }

  /** Public for tests; runs a single tick synchronously. */
  async runTickOnce(): Promise<{ outcome: "fired" | "blocked"; reason?: GateBlockReason }> {
    if (this.stopped) return { outcome: "blocked", reason: "disabled" };
    return this.tick();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    const intervalMs = Math.max(1_000, this.deps.config.trigger.tickIntervalMinutes * 60_000);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tickInProgress = this.tick().catch((error: unknown) => {
        this.deps.logger.warn("always-on tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }) as Promise<void>;
      void this.tickInProgress.then(() => {
        this.tickInProgress = undefined;
        this.scheduleNextTick();
      });
    }, intervalMs);
  }

  private async tick(): Promise<{ outcome: "fired" | "blocked"; reason?: GateBlockReason }> {
    const now = this.deps.now();
    const state = await this.deps.stateStore.read(now);
    const fresh = this.deps.leases.listFresh({
      projectKey: this.deps.projectKey,
      staleSeconds: this.deps.config.trigger.heartbeatStaleSeconds,
      now,
    });
    const lockHeld = existsSync(this.deps.paths.discoveryLockFile);
    const evaluation = evaluateAlwaysOnDiscoveryGates({
      projectKey: this.deps.projectKey,
      config: this.deps.config,
      state,
      leases: fresh,
      now,
      projectExists: existsSync(this.deps.projectKey),
      lockHeld,
      sessionInFlight: this.deps.isSessionInFlight(),
    });

    if (!evaluation.ok) {
      this.deps.logger.info("always-on gate blocked", { reason: evaluation.reason });
      if (evaluation.reason === "dormant_no_signal") {
        this.ensureDormancyWatcher();
      }
      return { outcome: "blocked", reason: evaluation.reason };
    }

    if (state.activeWorkCycleId) {
      const activeCycle = await this.deps.cycleStore.getRecord(state.activeWorkCycleId);
      if (
        activeCycle &&
        activeCycle.status === "active" &&
        Object.values(activeCycle.plans).filter((plan) => plan.status !== "applied" && plan.status !== "archived").length >=
          this.deps.config.workspace.maxPlansPerCycle
      ) {
        this.deps.logger.info("always-on gate blocked", { reason: "cycle_full" });
        return { outcome: "blocked", reason: "cycle_full" as GateBlockReason };
      }
    }

    const runId = this.deps.uuid();
    const startedAt = this.deps.now();

    const acquired = await acquireDiscoveryLock(this.deps.paths, {
      pid: process.pid,
      runId,
      startedAt: startedAt.toISOString(),
    });
    if (!acquired) {
      this.deps.logger.info("always-on lock_busy", { runId });
      return { outcome: "blocked", reason: "lock_busy" };
    }

    try {
      await this.deps.stateStore.markFireStarted(runId, startedAt);
      await this.deps.stateStore.clearDormant(startedAt);
      this.disposeWatcher();
      const result = await this.deps.fire.run({ runId, startedAt });
      this.deps.logger.info("always-on fire complete", {
        runId,
        outcome: result.outcome,
      });
      if (result.outcome === "no_plan") {
        this.ensureDormancyWatcher();
      }
      return { outcome: "fired" };
    } catch (error) {
      this.deps.logger.warn("always-on fire crashed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      const code = error instanceof AlwaysOnError ? error.code : "internal";
      const message = error instanceof Error ? error.message : String(error);
      await this.disableAfterCrash(runId, { code, message });
      throw new AlwaysOnError(
        code === "internal" ? "internal" : code,
        message,
      );
    } finally {
      await releaseDiscoveryLock(this.deps.paths);
    }
  }

  private async disableAfterCrash(runId: string, error: { code: string; message: string }): Promise<void> {
    const message = "Always-On 已因失败自动关闭，请手动重新开启。";
    try {
      await this.deps.disableAlwaysOnProject?.({
        projectKey: this.deps.projectKey,
        stage: "internal",
        runId,
        error,
      });
    } catch {
      // Best effort; still emit the user-facing event below.
    }
    await this.deps.eventStore?.appendEvent({
      schemaVersion: 1,
      eventId: this.deps.uuid(),
      runId,
      projectKey: this.deps.projectKey,
      phase: "always_on_disabled",
      timestamp: this.deps.now().toISOString(),
      outcome: "failed",
      error,
      message,
      disabledReason: { stage: "internal", code: error.code, message },
    }).catch(() => undefined);
  }

  private ensureDormancyWatcher(): void {
    if (this.watcher) return;
    this.watcher = new SignalWatcher({
      projectRoot: this.deps.projectKey,
      ignoreGlobs: this.deps.config.dormancy.ignoreGlobs,
      debounceMs: this.deps.config.dormancy.debounceMs,
      baselineAt: this.deps.now(),
      now: this.deps.now,
      onSignal: () => {
        void this.handleSignal();
      },
      onError: (error) => {
        this.deps.logger.warn("always-on signal watcher error", { error: error.message });
        this.disposeWatcher();
      },
    });
    this.watcher.start();
  }

  private async handleSignal(): Promise<void> {
    if (this.stopped) return;
    await this.deps.stateStore.clearDormant(this.deps.now());
    this.disposeWatcher();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.scheduleNextTick();
  }

  private disposeWatcher(): void {
    this.watcher?.stop();
    this.watcher = undefined;
  }

  private async maybeRestoreDormancy(): Promise<void> {
    const state = await this.deps.stateStore.read(this.deps.now());
    if (state.dormant) {
      this.ensureDormancyWatcher();
    }
  }
}
