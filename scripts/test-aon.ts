#!/usr/bin/env npx tsx
/**
 * Always-On v2 end-to-end test helper.
 *
 * Usage:
 *   npx tsx scripts/test-aon.ts fire    --workspace <dir> [--model <provider/model>] [--language zh-CN|en]
 *   npx tsx scripts/test-aon.ts apply   --workspace <dir> [--cycle-id <id>] [--plan-ids <id,id>] [--model <provider/model>]
 *   npx tsx scripts/test-aon.ts archive --workspace <dir> [--cycle-id <id>] [--plan-ids <id,id>]
 *   npx tsx scripts/test-aon.ts list    --workspace <dir>
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  AlwaysOnEventStore,
  defaultAlwaysOnConfig,
  DiscoveryPlanService,
  DiscoveryPlanStore,
  DiscoveryReportStore,
  DiscoveryStateStore,
  PreferenceEventStore,
  readPreferences,
  resolveAlwaysOnPaths,
  SessionConfigOverrides,
  WorkCycleStore,
  type AlwaysOnConfig,
  type AlwaysOnPaths,
  type DiscoveryPlanRecord,
  type PreferenceLlmOptions,
  type WorkCycleRecord,
} from "../src/always-on/index.js";
import {
  AlwaysOnPipeline,
  type AlwaysOnPipelineDependencies,
} from "../src/always-on/orchestration/AlwaysOnPipeline.js";
import { AlwaysOnRunContextRegistry } from "../src/always-on/phases/shared/RunContextRegistry.js";
import { createAlwaysOnDiscoveryPlanTool } from "../src/always-on/tool/AlwaysOnDiscoveryPlanTool.js";
import { createAlwaysOnReportTool } from "../src/always-on/tool/AlwaysOnReportTool.js";
import { WorkspaceProviderRegistry } from "../src/always-on/phases/workspace/WorkspaceProviderRegistry.js";
import { GitWorktreeProvider } from "../src/always-on/phases/workspace/GitWorktreeProvider.js";
import { SnapshotCopyProvider } from "../src/always-on/phases/workspace/SnapshotCopyProvider.js";
import { createAlwaysOnChatHistoryTool } from "../src/always-on/tool/AlwaysOnChatHistoryTool.js";
import type { CyclePlanState } from "../src/always-on/infra/storage/types.js";
import { createLocalGateway } from "../src/cli/createLocalGateway.js";
import type { Gateway, GatewayEvent } from "../src/gateway/index.js";
import { getPilotConfigFilePath, loadPilotConfig, resolvePilotHome } from "../src/pilot/index.js";
import { disposeWorkspace } from "../src/always-on/phases/apply/workspaceLifecycle.js";
import {
  getStatusPorcelain,
  revertCommits,
} from "../src/always-on/infra/git/index.js";

const DEFAULT_MODEL = "llmcenter-in/claude-opus-4-6";
const DEFAULT_LANGUAGE = "zh-CN";
const PROJECT_NAME = "test-aon";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: "string" },
    model: { type: "string", default: DEFAULT_MODEL },
    language: { type: "string", default: DEFAULT_LANGUAGE },
    "cycle-id": { type: "string" },
    "plan-ids": { type: "string" },
  },
});

const command = positionals[0];
const workspaceDir = values.workspace ? resolve(values.workspace) : undefined;
const modelSpec = values.model ?? DEFAULT_MODEL;
const language = normalizeLanguage(values.language);
const cycleIdArg = values["cycle-id"];
const planIdsArg = parsePlanIds(values["plan-ids"]);

function usage(): never {
  console.log(`Usage:
  npx tsx scripts/test-aon.ts fire    --workspace <dir> [--model <provider/model>] [--language zh-CN|en]
  npx tsx scripts/test-aon.ts apply   --workspace <dir> [--cycle-id <id>] [--plan-ids <id,id>] [--model <provider/model>]
  npx tsx scripts/test-aon.ts archive --workspace <dir> [--cycle-id <id>] [--plan-ids <id,id>]
  npx tsx scripts/test-aon.ts list    --workspace <dir>

Defaults:
  --model ${DEFAULT_MODEL}
  --language zh-CN`);
  process.exit(1);
}

type BootstrapResult = {
  gateway: Gateway;
  dispose: () => void;
  tempPilotHome: string;
} & ServiceContext & {
  runContexts: AlwaysOnRunContextRegistry;
  sessionOverrides: SessionConfigOverrides;
  workspaceRegistry: WorkspaceProviderRegistry;
  buildFireDeps(): AlwaysOnPipelineDependencies;
};

type ServiceContext = {
  paths: AlwaysOnPaths;
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  stateStore: DiscoveryStateStore;
  reportStore: DiscoveryReportStore;
  eventStore: AlwaysOnEventStore;
  preferenceEventStore: PreferenceEventStore;
  service: DiscoveryPlanService;
};

async function bootstrap(workspace: string, model: string): Promise<BootstrapResult> {
  const realPilotHome = resolvePilotHome(process.env);
  const tempPilotHome = await createTempPilotHome(realPilotHome, workspace, model);
  const serviceCtx = buildServiceContext(workspace, realPilotHome);
  const { paths } = serviceCtx;

  const runContexts = new AlwaysOnRunContextRegistry();
  const sessionOverrides = new SessionConfigOverrides();
  const extraTools = [
    createAlwaysOnDiscoveryPlanTool({ runContexts }),
    createAlwaysOnReportTool({ runContexts }),
    createAlwaysOnChatHistoryTool({ runContexts }),
  ];

  console.log(`gateway pilotHome: ${tempPilotHome}`);
  const { gateway, dispose } = createLocalGateway({
    projectRoot: workspace,
    pilotHome: tempPilotHome,
    env: { ...process.env, PILOT_HOME: tempPilotHome },
    extraTools,
    sessionOverrides,
    skipDefaultProject: false,
    autoElicitation: true,
  });

  const workspaceRegistry = new WorkspaceProviderRegistry();
  workspaceRegistry.add(
    new GitWorktreeProvider({
      baseDir: paths.worktreesDir,
      onWorktreeCreated: (_runId, cwd) => console.log(`worktree created: ${cwd}`),
      onWorktreeRemoved: (cwd) => console.log(`worktree removed: ${cwd}`),
    }),
  );
  workspaceRegistry.add(
    new SnapshotCopyProvider({
      baseDir: paths.snapshotsDir,
      maxBytes: defaultAlwaysOnConfig().workspace.snapshotMaxBytes,
    }),
  );

  const preferenceLlm = resolvePreferenceLlm(model, workspace);
  const config: AlwaysOnConfig = {
    ...defaultAlwaysOnConfig(),
    enabled: true,
    language,
    projects: { [workspace]: { enabled: true } },
  };

  return {
    gateway,
    dispose,
    tempPilotHome,
    ...serviceCtx,
    runContexts,
    sessionOverrides,
    workspaceRegistry,
    buildFireDeps: () => ({
      config,
      paths,
      projectKey: workspace,
      gateway,
      runContexts,
      workspaceRegistry,
      sessionOverrides,
      stateStore: serviceCtx.stateStore,
      planStore: serviceCtx.planStore,
      cycleStore: serviceCtx.cycleStore,
      reportStore: serviceCtx.reportStore,
      eventStore: serviceCtx.eventStore,
      uuid: () => randomUUID(),
      now: () => new Date(),
      logger: {
        info: (...args: unknown[]) => console.log(formatLog("fire", String(args[0] ?? ""), args[1])),
        warn: (...args: unknown[]) => console.warn(formatLog("fire", String(args[0] ?? ""), args[1])),
      },
      onTurnEvent: (_sessionKey, _channelKey, event) => printTurnEvent(event),
      preferenceEventStore: serviceCtx.preferenceEventStore,
      preferenceLlm,
    }),
  };
}

function buildServiceContext(workspace: string, pilotHome = resolvePilotHome(process.env)): ServiceContext {
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey: workspace });
  const planStore = new DiscoveryPlanStore(paths);
  const cycleStore = new WorkCycleStore(paths);
  const stateStore = new DiscoveryStateStore(paths);
  const reportStore = new DiscoveryReportStore(paths);
  const eventStore = new AlwaysOnEventStore(paths);
  const preferenceEventStore = new PreferenceEventStore(paths.preferenceEventsFile);
  const service = buildPlanService({
    paths,
    projectRoot: workspace,
    planStore,
    cycleStore,
    stateStore,
    reportStore,
    preferenceEventStore,
  });
  return {
    paths,
    planStore,
    cycleStore,
    stateStore,
    reportStore,
    eventStore,
    preferenceEventStore,
    service,
  };
}

function buildPlanService(input: {
  paths: AlwaysOnPaths;
  projectRoot: string;
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  stateStore: DiscoveryStateStore;
  reportStore: DiscoveryReportStore;
  preferenceEventStore: PreferenceEventStore;
}): DiscoveryPlanService {
  return new DiscoveryPlanService({
    createStores: () => ({
      planStore: input.planStore,
      cycleStore: input.cycleStore,
      stateStore: input.stateStore,
      reportStore: input.reportStore,
    }),
    paths: {
      extractProjectDirectory: async () => input.projectRoot,
    },
    sessions: {
      getSessions: async () => ({ sessions: [] }),
    },
    activity: {
      isSessionActive: () => false,
    },
    planLifecycle: {
      disposeCycleWorkspace: ({ strategy, cwd, projectRoot, metadata }) => disposeWorkspace(strategy, cwd, projectRoot, "git", metadata),
      getCycleWorkspaceStatus: ({ workspaceCwd }) => getStatusPorcelain(workspaceCwd),
      archivePlanCommits: async ({ workspaceCwd, commitShas }) => {
        const result = await revertCommits(workspaceCwd, commitShas);
        return { archived: result.reverted, error: result.error };
      },
    },
    state: {
      clearActiveWorkCycleId: async () => {
        await input.stateStore.clearActiveWorkCycleId(new Date());
      },
    },
    preferenceEvents: {
      forProject: () => input.preferenceEventStore,
    },
    logger: {
      warn: (message, data) => console.warn(formatLog("service", message, data)),
    },
  });
}

async function createTempPilotHome(
  realPilotHome: string,
  workspace: string,
  model: string,
): Promise<string> {
  assertModelExists(model, workspace);
  const configPath = getPilotConfigFilePath(realPilotHome);
  if (!existsSync(configPath)) {
    throw new Error(`pilotdeck.yaml not found: ${configPath}`);
  }

  const tempPilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-test-aon-"));
  const raw = await readFile(configPath, "utf8");
  const parsed = parseYaml(raw);
  const root = isRecord(parsed) ? parsed : {};
  patchModelRefs(root, model);
  await mkdir(dirname(getPilotConfigFilePath(tempPilotHome)), { recursive: true });
  await writeFile(
    getPilotConfigFilePath(tempPilotHome),
    stringifyYaml(root, { lineWidth: 0 }),
    "utf8",
  );
  return tempPilotHome;
}

function patchModelRefs(root: Record<string, unknown>, model: string): void {
  const agent = ensureRecord(root, "agent");
  agent.model = model;

  const router = ensureRecord(root, "router");
  const scenarios = ensureRecord(router, "scenarios");
  scenarios.default = model;

  const fallback = ensureRecord(router, "fallback");
  fallback.default = [model];

  const tokenSaver = asRecord(router.tokenSaver);
  if (tokenSaver) {
    tokenSaver.judge = model;
    const tiers = asRecord(tokenSaver.tiers);
    if (tiers) {
      for (const tier of Object.values(tiers)) {
        if (isRecord(tier)) tier.model = model;
      }
    }
  }

  const autoOrchestrate = asRecord(router.autoOrchestrate);
  if (autoOrchestrate) {
    if (autoOrchestrate.mainAgentModel !== undefined) autoOrchestrate.mainAgentModel = model;
    if (autoOrchestrate.subagentModel !== undefined) autoOrchestrate.subagentModel = model;
  }

  const stats = asRecord(router.stats);
  if (stats && stats.baselineModel !== undefined) stats.baselineModel = model;
}

function assertModelExists(model: string, workspace: string): void {
  const [providerId, ...modelParts] = model.split("/");
  const modelId = modelParts.join("/");
  if (!providerId || !modelId) {
    throw new Error(`--model must use provider/model format, got "${model}"`);
  }

  const snapshot = loadPilotConfig({ projectRoot: workspace, env: process.env });
  const provider = snapshot.config.model.providers[providerId];
  if (!provider) {
    const providers = Object.keys(snapshot.config.model.providers).join(", ") || "(none)";
    throw new Error(`provider "${providerId}" not found. Available providers: ${providers}`);
  }
  if (!provider.models[modelId]) {
    const models = Object.keys(provider.models).join(", ") || "(none)";
    throw new Error(`model "${modelId}" not found for provider "${providerId}". Available models: ${models}`);
  }
}

function resolvePreferenceLlm(model: string, workspace: string): PreferenceLlmOptions {
  const [providerId, ...modelParts] = model.split("/");
  const modelId = modelParts.join("/");
  const snapshot = loadPilotConfig({ projectRoot: workspace, env: process.env });
  const provider = snapshot.config.model.providers[providerId]!;
  return {
    baseUrl: provider.url,
    model: modelId,
    apiKey: provider.apiKey,
    protocol: provider.protocol,
    headers: provider.headers as Record<string, string> | undefined,
    timeoutMs: provider.timeoutMs ?? 120_000,
  };
}

async function cmdFire(): Promise<void> {
  const workspace = requireWorkspace();
  console.log(`workspace: ${workspace}`);
  console.log(`model:     ${modelSpec}`);
  console.log(`language:  ${language}`);

  const ctx = await bootstrap(workspace, modelSpec);
  const fire = new AlwaysOnPipeline(ctx.buildFireDeps());
  const runId = randomUUID();
  const startedAt = new Date();

  try {
    console.log(`\nfire started: ${runId}\n`);
    const result = await fire.run({ runId, startedAt });
    console.log("\n\n-- fire result --");
    console.log(`outcome: ${result.outcome}`);
    console.log(`runId:   ${result.runId}`);
    if (result.outcome === "no_plan") {
      return;
    }
    console.log(`planId:  ${result.planId}`);
    if (result.workspace) console.log(`workspace: ${result.workspace.cwd}`);
    if (result.reportFilePath) console.log(`report: ${result.reportFilePath}`);
    if (result.error) console.log(`error: ${result.error.code}: ${result.error.message}`);
    await printPlanAndCycleForPlan(ctx, result.planId);
  } finally {
    await cleanupBootstrap(ctx);
  }
}

async function cmdApply(): Promise<void> {
  const workspace = requireWorkspace();
  const ctx = await bootstrap(workspace, modelSpec);
  const fire = new AlwaysOnPipeline(ctx.buildFireDeps());
  try {
    const selection = await resolveCycleAndPlanSelection(ctx, cycleIdArg, planIdsArg);
    console.log("-- apply selection --");
    printCycleSummary(selection.cycle, selection.plans);
    printSelectedPlanStates(selection.cycle, selection.planIds);

    const queued = await ctx.service.queueCycleApply(PROJECT_NAME, selection.cycle.id, selection.planIds);
    const runId = randomUUID();
    console.log(`\napply started: ${runId}`);
    const result = await fire.runApplyPhase({
      runId,
      cycle: queued.cycle,
      plans: selection.plans
        .filter((plan) => queued.planIds.includes(plan.id))
        .map((plan) => ({ id: plan.id, title: plan.title })),
      planIds: queued.planIds,
      projectName: basename(workspace),
      projectRoot: workspace,
    });

    if (result.error) {
      await ctx.service.updateCycleExecution(PROJECT_NAME, selection.cycle.id, {
        status: "failed",
        planIds: queued.planIds,
      });
      console.log(`apply failed: ${result.error.code}: ${result.error.message}`);
      return;
    }

    const final = await ctx.service.updateCycleExecution(PROJECT_NAME, selection.cycle.id, {
      status: "completed",
      executionSessionId: result.sessionKey,
      planIds: queued.planIds,
    });
    console.log(`apply sessionKey: ${result.sessionKey}`);
    console.log("-- final cycle --");
    printCycleSummary(final.cycle as WorkCycleRecord, await readPlans(ctx));
  } finally {
    await cleanupBootstrap(ctx);
  }
}

async function cmdArchive(): Promise<void> {
  const workspace = requireWorkspace();
  const ctx = buildServiceContext(workspace);
  const selection = await resolveCycleAndPlanSelection(ctx, cycleIdArg, planIdsArg);
  const commitCount = selection.planIds.reduce(
    (sum, planId) => sum + (selection.cycle.plans[planId]?.commitShas.length ?? 0),
    0,
  );
  console.log("-- archive selection --");
  printCycleSummary(selection.cycle, selection.plans);
  printSelectedPlanStates(selection.cycle, selection.planIds);
  console.log(`revert commits: ${commitCount}`);

  const result = await ctx.service.archiveCycle(PROJECT_NAME, selection.cycle.id, selection.planIds);
  console.log(`archived planIds: ${result.planIds.join(", ")}`);
  const updatedCycle = await ctx.cycleStore.getRecord(selection.cycle.id);
  if (updatedCycle) {
    console.log("-- final cycle --");
    printCycleSummary(updatedCycle, await readPlans(ctx));
  } else {
    console.log("final cycle: not found");
  }
  const state = await ctx.stateStore.read(new Date());
  console.log(`activeWorkCycleId: ${state.activeWorkCycleId ?? "(none)"}`);
}

async function cmdList(): Promise<void> {
  const workspace = requireWorkspace();
  const realPilotHome = resolvePilotHome(process.env);
  const paths = resolveAlwaysOnPaths({ pilotHome: realPilotHome, projectKey: workspace });
  const planStore = new DiscoveryPlanStore(paths);
  const cycleStore = new WorkCycleStore(paths);
  const preferenceEventStore = new PreferenceEventStore(paths.preferenceEventsFile);

  const plans = await readPlans({ planStore });
  const cycles = (await cycleStore.readIndex()).cycles;
  console.log(`workspace: ${workspace}`);
  console.log(`plans: ${plans.length}`);
  for (const plan of plans) printPlanSummary(plan);
  console.log(`cycles: ${cycles.length}`);
  for (const cycle of cycles) printCycleSummary(cycle, plans);
  const events = await preferenceEventStore.readAll();
  console.log(`preferenceEvents: ${events.length}`);
  const preferences = await readPreferences(paths.preferencesFile);
  if (preferences.trim()) {
    console.log("-- preferences --");
    console.log(preferences.trim());
  }
}

async function resolveCycleAndPlanSelection(
  ctx: Pick<BootstrapResult, "cycleStore" | "planStore">,
  cycleId: string | undefined,
  explicitPlanIds: string[] | undefined,
): Promise<{ cycle: WorkCycleRecord; plans: DiscoveryPlanRecord[]; planIds: string[] }> {
  const cycleIndex = await ctx.cycleStore.readIndex();
  const candidates = cycleId
    ? cycleIndex.cycles.filter((cycle) => cycle.id === cycleId)
    : cycleIndex.cycles.filter((cycle) => cycle.status === "active");

  if (candidates.length !== 1) {
    const label = cycleId ? `cycle "${cycleId}"` : "unique active cycle";
    console.error(`Unable to resolve ${label}. Candidates:`);
    for (const cycle of cycleIndex.cycles) {
      console.error(`  - ${cycle.id} [${cycle.status}] plans=${Object.keys(cycle.plans).join(",")}`);
    }
    process.exit(1);
  }

  const cycle = candidates[0]!;
  const plans = await readPlans(ctx);
  const cyclePlanIds = new Set(Object.keys(cycle.plans));
  const activePlanIds = plans
    .filter((plan) => {
      const status = cycle.plans[plan.id]?.status;
      return cyclePlanIds.has(plan.id) && status !== "applied" && status !== "archived";
    })
    .map((plan) => plan.id);
  const planIds = explicitPlanIds ?? activePlanIds;
  const invalid = planIds.filter((planId) => !cyclePlanIds.has(planId));
  if (invalid.length > 0) {
    throw new Error(`planIds not in cycle ${cycle.id}: ${invalid.join(", ")}`);
  }
  if (planIds.length === 0) {
    throw new Error(`No active plans selected for cycle ${cycle.id}`);
  }

  return { cycle, plans, planIds };
}

async function printPlanAndCycleForPlan(
  ctx: Pick<BootstrapResult, "planStore" | "cycleStore">,
  planId: string,
): Promise<void> {
  const plan = await ctx.planStore.getRecord(planId);
  if (plan) printPlanSummary(plan);
  const cycle = plan?.workCycleId ? await ctx.cycleStore.getRecord(plan.workCycleId) : undefined;
  if (cycle) printCycleSummary(cycle, await readPlans(ctx));
}

async function readPlans(ctx: Pick<BootstrapResult, "planStore">): Promise<DiscoveryPlanRecord[]> {
  return (await ctx.planStore.readIndex()).plans;
}

function printPlanSummary(plan: DiscoveryPlanRecord): void {
  console.log(`- plan ${plan.id}`);
  console.log(`  title: ${plan.title}`);
  console.log(`  workCycleId: ${plan.workCycleId ?? "(none)"}`);
  console.log(`  planFile: ${plan.planFilePath}`);
  console.log(`  reportFile: ${plan.reportFilePath ?? "(none)"}`);
}

function printCycleSummary(cycle: WorkCycleRecord, plans: DiscoveryPlanRecord[]): void {
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  console.log(`- cycle ${cycle.id} [${cycle.status}]`);
  console.log(`  baseCommit: ${cycle.baseCommit || cycle.workspace.metadata.baseCommit || "(none)"}`);
  console.log(`  workspace: ${cycle.workspace.strategy} ${cycle.workspace.cwd}`);
  for (const [planId, state] of Object.entries(cycle.plans)) {
    const plan = planById.get(planId);
    printCyclePlanState(planId, state, plan);
  }
}

function printSelectedPlanStates(cycle: WorkCycleRecord, planIds: string[]): void {
  console.log(`selected planIds: ${planIds.join(", ")}`);
  for (const planId of planIds) {
    const state = cycle.plans[planId];
    if (state) printCyclePlanState(planId, state);
  }
}

function printCyclePlanState(
  planId: string,
  state: CyclePlanState,
  plan?: DiscoveryPlanRecord,
): void {
  console.log(`  - ${planId} [cycle=${state.status}] ${plan?.title ?? ""}`.trimEnd());
  console.log(`    commits: ${state.commitShas.length}${state.commitShas.length ? ` ${state.commitShas.join(", ")}` : ""}`);
  console.log(`    beforeHead: ${state.beforeHead ?? "(none)"}`);
  console.log(`    afterHead: ${state.afterHead ?? "(none)"}`);
  console.log(`    dependsOnPlanIds: ${state.dependsOnPlanIds.length ? state.dependsOnPlanIds.join(", ") : "(none)"}`);
  console.log(`    dependencyAnalysisStatus: ${state.dependencyAnalysisStatus}`);
  if (state.dependencyReasons.length > 0) console.log(`    dependencyReasons: ${state.dependencyReasons.join(" | ")}`);
  console.log(`    lastRunId: ${state.lastRunId ?? "(none)"}`);
  console.log(`    attempts: ${state.attempts?.length ?? 0}`);
}

function parsePlanIds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const planIds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return planIds.length > 0 ? [...new Set(planIds)] : undefined;
}

function normalizeLanguage(value: string | undefined): "en" | "zh-CN" {
  if (value === "en" || value === "zh-CN") return value;
  throw new Error(`--language must be en or zh-CN, got "${value}"`);
}

function requireWorkspace(): string {
  if (!workspaceDir) usage();
  if (!existsSync(workspaceDir)) throw new Error(`workspace does not exist: ${workspaceDir}`);
  return workspaceDir;
}

async function cleanupBootstrap(ctx: BootstrapResult): Promise<void> {
  ctx.dispose();
  await rm(ctx.tempPilotHome, { recursive: true, force: true }).catch(() => undefined);
}

function printTurnEvent(event: GatewayEvent): void {
  if (event.type === "assistant_text_delta") {
    process.stdout.write(event.text);
  } else if (event.type === "error") {
    console.error(`\n[turn error] ${event.code}: ${event.message}`);
  }
}

function formatLog(scope: string, message: string, data?: unknown): string {
  if (!data) return `[${scope}] ${message}`;
  if (data instanceof Error) return `[${scope}] ${message} ${data.message}`;
  return `[${scope}] ${message} ${JSON.stringify(data)}`;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) return existing;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

if (!command || !["fire", "apply", "archive", "list"].includes(command)) {
  usage();
}

try {
  if (command === "fire") await cmdFire();
  if (command === "apply") await cmdApply();
  if (command === "archive") await cmdArchive();
  if (command === "list") await cmdList();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
