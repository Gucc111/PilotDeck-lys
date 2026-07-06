/**
 * Thin adapter — delegates all discovery-plan business logic to
 * `src/always-on/web/DiscoveryPlanService.ts`.
 *
 * This file only wires the service's dependency injection and
 * re-exports the public API surface consumed by routes and slash
 * commands.
 */

import { isSessionActiveViaGateway as isClaudeSDKSessionActive, getPilotDeckGateway } from './pilotdeck-bridge.js';
import {
  extractProjectDirectory,
  getProjectCronJobsOverview,
  getSessions,
} from './projects.js';
import { resolvePilotHome } from './utils/pilotPaths.js';

import { DiscoveryPlanService } from '../../src/always-on/web/DiscoveryPlanService.js';
import { buildDiscoveryContext } from '../../src/always-on/web/DiscoveryPlanContext.js';
import {
  disposeWorkspace as disposeWorkspaceImpl,
} from '../../src/always-on/phases/apply/workspaceLifecycle.js';
import {
  getStatusPorcelain,
  revertCommits,
} from '../../src/always-on/infra/git/index.js';
import { resolveAlwaysOnPaths } from '../../src/always-on/infra/storage/AlwaysOnPaths.js';
import { DiscoveryPlanStore } from '../../src/always-on/infra/storage/json/DiscoveryPlanStore.js';
import { WorkCycleStore } from '../../src/always-on/infra/storage/json/WorkCycleStore.js';
import { DiscoveryStateStore } from '../../src/always-on/infra/storage/json/DiscoveryStateStore.js';
import { DiscoveryReportStore } from '../../src/always-on/infra/storage/file/DiscoveryReportStore.js';
import { PreferenceEventStore } from '../../src/always-on/infra/storage/log/PreferenceEventStore.js';

// ---------------------------------------------------------------------------
// Wire dependencies for the service
// ---------------------------------------------------------------------------

function getService() {
  const pilotHome = resolvePilotHome();
  return new DiscoveryPlanService({
    createStores: (projectRoot) => {
      const paths = resolveAlwaysOnPaths({ pilotHome, projectKey: projectRoot });
      return {
        planStore: new DiscoveryPlanStore(paths),
        cycleStore: new WorkCycleStore(paths),
        stateStore: new DiscoveryStateStore(paths),
        reportStore: new DiscoveryReportStore(paths),
      };
    },
    paths: { extractProjectDirectory },
    sessions: { getSessions },
    activity: { isSessionActive: isClaudeSDKSessionActive },
    planLifecycle: {
      disposeCycleWorkspace: ({ strategy, cwd, projectRoot, metadata }) => disposeWorkspaceImpl(strategy, cwd, projectRoot, 'git', metadata),
      getCycleWorkspaceStatus: ({ workspaceCwd }) => getStatusPorcelain(workspaceCwd),
      archivePlanCommits: async ({ workspaceCwd, commitShas }) => {
        const result = await revertCommits(workspaceCwd, commitShas);
        return { archived: result.reverted, error: result.error };
      },
    },
    state: {
      clearActiveWorkCycleId: async (projectRoot) => {
        const paths = resolveAlwaysOnPaths({
          pilotHome,
          projectKey: projectRoot,
        });
        const store = new DiscoveryStateStore(paths);
        await store.clearActiveWorkCycleId(new Date());
      },
    },
    preferenceEvents: {
      forProject: (projectRoot) => {
        const paths = resolveAlwaysOnPaths({
          pilotHome,
          projectKey: projectRoot,
        });
        return new PreferenceEventStore(paths.preferenceEventsFile);
      },
    },
    logger: {
      warn: (message, data) => {
        console.warn(`${message}${data ? ` ${JSON.stringify(data)}` : ''}`);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getProjectDiscoveryContext(projectName) {
  const projectRoot = await extractProjectDirectory(projectName);
  return buildDiscoveryContext({
    projectName,
    projectRoot,
    getProjectCronJobsOverview,
    getSessions,
    extractProjectDirectory,
  });
}

export async function getProjectDiscoveryPlansOverview(projectName) {
  return getService().getPlansOverview(projectName);
}

export async function rerunDiscoveryPlan(projectName, planId) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getPilotDeckGateway();
  const result = await gw.alwaysOnRerunPlan({
    projectKey: projectRoot,
    planId,
    projectName,
  });
  if (result.error) {
    const err = new Error(result.error.message);
    err.code = result.error.code;
    throw err;
  }
  return { runId: result.runId };
}

export async function getProjectDiscoveryPlanReport(projectName, planId) {
  return getService().readReport(projectName, planId);
}

export async function getProjectWorkCycles(projectName) {
  return getService().getCyclesOverview(projectName);
}

export async function archiveWorkCycle(projectName, cycleId, planIds) {
  return getService().archiveCycle(projectName, cycleId, planIds);
}

export async function checkApplyReadiness(projectName, cycleId, planIds) {
  return getService().checkApplyReadiness(projectName, cycleId, planIds);
}

export async function applyWorkCycle(projectName, cycleId, planIds, options = {}) {
  const result = await getService().queueCycleApply(projectName, cycleId, planIds, {
    allowDivergedProject: !!options.allowDivergedProject,
  });

  const gw = await getPilotDeckGateway();

  let applyResult;
  try {
    const applyInput = {
      projectKey: result.projectRoot,
      workCycleId: cycleId,
      projectName,
      allowDivergedProject: !!options.allowDivergedProject,
    };
    if (!result.legacyWorkspaceApply) {
      applyInput.planIds = result.planIds;
    }
    applyResult = await gw.alwaysOnApply(applyInput);
  } catch (err) {
    await getService().updateCycleExecution(projectName, cycleId, {
      status: 'failed',
      planIds: result.planIds,
    });
    return {
      cycle: result.cycle,
      planIds: result.planIds,
      error: { code: 'apply_error', message: (err && err.message) || 'Apply failed' },
    };
  }

  if (applyResult.error) {
    await getService().updateCycleExecution(projectName, cycleId, {
      status: 'failed',
      planIds: result.planIds,
    });
    return { cycle: result.cycle, planIds: result.planIds, error: applyResult.error };
  }

  const finalResult = await getService().updateCycleExecution(projectName, cycleId, {
    status: 'completed',
    executionSessionId: applyResult.sessionKey,
    planIds: result.planIds,
  });
  return {
    cycle: finalResult.cycle,
    planIds: result.planIds,
    sessionKey: applyResult.sessionKey,
  };
}
