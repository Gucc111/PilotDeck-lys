import { useCallback, useEffect, useId, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Archive,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type {
  ApplyProjectReadiness,
  DiscoveryPlanOverview,
  DiscoveryPlanStatus,
  Project,
  ProjectDiscoveryPlansResponse,
  WorkCycleOverview,
} from '../../types/app';
import { api } from '../../utils/api';
import { cn } from '../../lib/utils.js';

const POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type PlanDisplayStatus =
  | 'created'
  | 'preparingWorkspace'
  | 'executing'
  | 'completedWaiting'
  | 'completedNoReport'
  | 'failed'
  | 'applied'
  | 'archived';

function mapPlanStatus(status: DiscoveryPlanStatus): PlanDisplayStatus {
  switch (status) {
    case 'ready':
      return 'created';
    case 'queued':
      return 'preparingWorkspace';
    case 'running':
      return 'executing';
    case 'completed':
      return 'completedWaiting';
    case 'completed_no_report':
      return 'completedNoReport';
    case 'failed':
      return 'failed';
    case 'applied':
      return 'applied';
    case 'archived':
      return 'archived';
    default:
      return 'created';
  }
}

const PLAN_STATUS_STYLE: Record<PlanDisplayStatus, string> = {
  created: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  preparingWorkspace: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  executing: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  completedWaiting: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  completedNoReport: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  applied: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  archived: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
};

const PLAN_STATUS_LABEL: Record<PlanDisplayStatus, { key: string; defaultValue: string }> = {
  created: { key: 'plansCron.status.created', defaultValue: 'Created' },
  preparingWorkspace: { key: 'plansCron.status.preparingWorkspace', defaultValue: 'Preparing Workspace' },
  executing: { key: 'plansCron.status.executing', defaultValue: 'Executing' },
  completedWaiting: { key: 'plansCron.status.completedWaiting', defaultValue: 'Completed' },
  completedNoReport: { key: 'plansCron.status.completedNoReport', defaultValue: 'Report Unavailable' },
  failed: { key: 'plansCron.status.failed', defaultValue: 'Failed' },
  applied: { key: 'plansCron.status.applied', defaultValue: 'Applied' },
  archived: { key: 'plansCron.status.archived', defaultValue: 'Archived' },
};

// ---------------------------------------------------------------------------
// Plan row type
// ---------------------------------------------------------------------------

type PlanItem = {
  data: DiscoveryPlanOverview;
  projectName: string;
  projectDisplayName: string;
  projectKey: string;
};

type ProjectGroup = {
  displayName: string;
  items: PlanItem[];
  activeCycle?: WorkCycleOverview;
};

type CyclePlanState = NonNullable<WorkCycleOverview['plans']>[string];

type SelectionCheck = {
  enabled: boolean;
  reason: string;
};

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function formatAbsoluteTime(iso: string | number): string {
  const parsed = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Column widths (shared between header and body for alignment)
// ---------------------------------------------------------------------------

const COL = {
  select: 'w-[32px] shrink-0',
  title: 'min-w-0 flex-1 max-w-[380px]',
  createdAt: 'w-[150px] shrink-0',
  status: 'w-[160px] shrink-0',
  actions: 'w-[140px] shrink-0',
} as const;

const GRAPH_NODE_WIDTH = 220;
const GRAPH_NODE_HEIGHT = 44;

const RESOLVED_PLAN_STATUSES = new Set<DiscoveryPlanStatus>(['applied', 'archived']);

function selectionKey(projectName: string, cycleId: string): string {
  return `${projectName}::${cycleId}`;
}

function isResolvedStatus(status?: string): boolean {
  return status === 'applied' || status === 'archived';
}

function getCyclePlanIds(cycle?: WorkCycleOverview): string[] {
  if (!cycle) return [];
  const fromPlans = cycle.plans ? Object.keys(cycle.plans) : [];
  return fromPlans.length > 0 ? fromPlans : cycle.planIds;
}

function getCyclePlanState(cycle: WorkCycleOverview | undefined, planId: string): CyclePlanState | undefined {
  return cycle?.plans?.[planId];
}

function getPlanStatus(plan: DiscoveryPlanOverview, cycle?: WorkCycleOverview): DiscoveryPlanStatus {
  return getCyclePlanState(cycle, plan.id)?.status ?? plan.status;
}

function getPlanCommitShas(plan: DiscoveryPlanOverview, cycle?: WorkCycleOverview): string[] {
  return getCyclePlanState(cycle, plan.id)?.commitShas ?? plan.executionCommitShas ?? [];
}

function getPlanDependencies(plan: DiscoveryPlanOverview, cycle?: WorkCycleOverview): string[] {
  return getCyclePlanState(cycle, plan.id)?.dependsOnPlanIds ?? plan.dependsOnPlanIds ?? [];
}

function hasDependencyAnalysisFailure(cycle: WorkCycleOverview | undefined, plans: DiscoveryPlanOverview[]): boolean {
  const states = Object.values(cycle?.plans ?? {});
  if (states.length > 0) {
    return states.some((state) => state.dependencyAnalysisStatus === 'failed');
  }
  return plans.some((plan) => plan.dependencyAnalysisStatus === 'failed');
}

function isCompletedForApply(plan: DiscoveryPlanOverview, cycle?: WorkCycleOverview): boolean {
  const status = getPlanStatus(plan, cycle);
  return status === 'completed' || status === 'completed_no_report';
}

function getCurrentCyclePlans(
  plans: DiscoveryPlanOverview[],
  cycle?: WorkCycleOverview,
): DiscoveryPlanOverview[] {
  if (!cycle) return [];
  const cyclePlanIds = new Set(getCyclePlanIds(cycle));
  return plans.filter((plan) => {
    if (!cyclePlanIds.has(plan.id)) return false;
    if (plan.workCycleId && plan.workCycleId !== cycle.id) return false;
    if (RESOLVED_PLAN_STATUSES.has(plan.status) || isResolvedStatus(getCyclePlanState(cycle, plan.id)?.status)) {
      return false;
    }
    return true;
  });
}

function evaluateApplySelection(
  cycle: WorkCycleOverview | undefined,
  plans: DiscoveryPlanOverview[],
  selectedPlanIds: Set<string>,
): SelectionCheck {
  if (!cycle) return { enabled: false, reason: 'No active work cycle.' };
  if (cycle.status !== 'active') return { enabled: false, reason: 'Work cycle is not active.' };
  if (selectedPlanIds.size === 0) return { enabled: false, reason: 'Select at least one plan.' };
  const selectedPlans = plans.filter((plan) => selectedPlanIds.has(plan.id));
  if (selectedPlans.length !== selectedPlanIds.size) {
    return { enabled: false, reason: 'Selection contains a plan outside the current cycle.' };
  }
  if (hasDependencyAnalysisFailure(cycle, plans)) {
    return { enabled: false, reason: 'Dependency analysis failed for this cycle.' };
  }
  for (const plan of selectedPlans) {
    if (!isCompletedForApply(plan, cycle)) {
      return { enabled: false, reason: 'Selected plans must be completed.' };
    }
    if (getPlanCommitShas(plan, cycle).length === 0) {
      return { enabled: false, reason: 'Selected plans must have commits.' };
    }
    const missing = getPlanDependencies(plan, cycle).filter((dependencyId) => !selectedPlanIds.has(dependencyId));
    if (missing.length > 0) {
      return { enabled: false, reason: 'Selected plans are missing dependencies.' };
    }
  }
  return { enabled: true, reason: '' };
}

function evaluateArchiveSelection(
  cycle: WorkCycleOverview | undefined,
  plans: DiscoveryPlanOverview[],
  selectedPlanIds: Set<string>,
): SelectionCheck {
  if (!cycle) return { enabled: false, reason: 'No active work cycle.' };
  if (cycle.status !== 'active') return { enabled: false, reason: 'Work cycle is not active.' };
  if (selectedPlanIds.size === 0) return { enabled: false, reason: 'Select at least one plan.' };
  const selectedPlans = plans.filter((plan) => selectedPlanIds.has(plan.id));
  if (selectedPlans.length !== selectedPlanIds.size) {
    return { enabled: false, reason: 'Selection contains a plan outside the current cycle.' };
  }

  const allSelected = plans.length > 0 && plans.every((plan) => selectedPlanIds.has(plan.id));
  if (hasDependencyAnalysisFailure(cycle, plans)) {
    return allSelected
      ? { enabled: true, reason: '' }
      : { enabled: false, reason: 'Archive all remaining plans when dependency analysis failed.' };
  }

  for (const plan of plans) {
    if (selectedPlanIds.has(plan.id)) continue;
    const removedDependencies = getPlanDependencies(plan, cycle).filter((dependencyId) => selectedPlanIds.has(dependencyId));
    if (removedDependencies.length > 0) {
      return { enabled: false, reason: 'Remaining plans depend on the selected archive plans.' };
    }
  }
  return { enabled: true, reason: '' };
}

type GraphNode = {
  plan: DiscoveryPlanOverview;
  x: number;
  y: number;
  depth: number;
};

type GraphEdge = {
  from: string;
  to: string;
};

function buildGraphLayout(
  plans: DiscoveryPlanOverview[],
  cycle?: WorkCycleOverview,
): { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number } {
  const planIds = new Set(plans.map((plan) => plan.id));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const dependencyMap = new Map<string, string[]>();
  for (const plan of plans) {
    dependencyMap.set(
      plan.id,
      getPlanDependencies(plan, cycle).filter((dependencyId) => planIds.has(dependencyId)),
    );
  }

  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();
  const depthFor = (planId: string): number => {
    if (depthCache.has(planId)) return depthCache.get(planId)!;
    if (visiting.has(planId)) return 0;
    visiting.add(planId);
    const dependencies = dependencyMap.get(planId) ?? [];
    const depth = dependencies.length === 0
      ? 0
      : Math.max(...dependencies.map((dependencyId) => depthFor(dependencyId))) + 1;
    visiting.delete(planId);
    depthCache.set(planId, depth);
    return depth;
  };

  for (const plan of plans) depthFor(plan.id);

  const layers = new Map<number, DiscoveryPlanOverview[]>();
  for (const plan of plans) {
    const depth = depthCache.get(plan.id) ?? 0;
    const layer = layers.get(depth) ?? [];
    layer.push(plan);
    layers.set(depth, layer);
  }

  const nodes: GraphNode[] = [];
  const layerGapX = 280;
  const nodeGapY = 66;
  for (const [depth, layerPlans] of [...layers.entries()].sort(([left], [right]) => left - right)) {
    layerPlans
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .forEach((plan, index) => {
        nodes.push({
          plan,
          depth,
          x: 28 + depth * layerGapX,
          y: 34 + index * nodeGapY,
        });
      });
  }

  const maxDepth = Math.max(0, ...nodes.map((node) => node.depth));
  const maxLayerSize = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const edges: GraphEdge[] = [];
  for (const [planId, dependencies] of dependencyMap.entries()) {
    if (!planById.has(planId)) continue;
    for (const dependencyId of dependencies) {
      if (planById.has(dependencyId)) edges.push({ from: dependencyId, to: planId });
    }
  }

  return {
    nodes,
    edges,
    width: Math.max(640, 56 + maxDepth * layerGapX + GRAPH_NODE_WIDTH),
    height: Math.max(170, 76 + maxLayerSize * nodeGapY),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type PlansAndCronJobsProps = {
  onApplyWorkCycle?: (
    projectName: string,
    cycleId: string,
    planIds?: string[],
    options?: { allowDivergedProject?: boolean },
  ) => Promise<void>;
  onOpenPlanDetail?: (planId: string, projectName: string, projectDisplayName: string, sourceRunId: string, projectKey: string) => void;
};

type ApplyReadinessPrompt = {
  cycleId: string;
  readiness: ApplyProjectReadiness;
};

export default function PlansAndCronJobs({ onApplyWorkCycle, onOpenPlanDetail }: PlansAndCronJobsProps) {
  const { t } = useTranslation('alwaysOn');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [plansByProject, setPlansByProject] = useState<Map<string, DiscoveryPlanOverview[]>>(new Map());
  const [cyclesByProject, setCyclesByProject] = useState<Map<string, WorkCycleOverview[]>>(new Map());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [cycleBusy, setCycleBusy] = useState<string | null>(null);
  const [confirmingArchiveCycle, setConfirmingArchiveCycle] = useState<string | null>(null);
  const [applyReadinessPrompt, setApplyReadinessPrompt] = useState<ApplyReadinessPrompt | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [selectedPlanIdsByCycle, setSelectedPlanIdsByCycle] = useState<Map<string, Set<string>>>(new Map());

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const projectsRes = await api.projects();
      if (!projectsRes.ok) throw new Error(`Projects: HTTP ${projectsRes.status}`);
      const projectsList: Project[] = await projectsRes.json();
      setProjects(projectsList);

      const mixedResults = await Promise.all(
        projectsList.flatMap((p) => [
          api.projectDiscoveryPlans(p.name),
          api.projectWorkCycles(p.name),
        ]),
      );

      const newPlansByProject = new Map<string, DiscoveryPlanOverview[]>();
      const newCyclesByProject = new Map<string, WorkCycleOverview[]>();
      for (let i = 0; i < projectsList.length; i++) {
        const planRes = mixedResults[i * 2];
        const cycleRes = mixedResults[i * 2 + 1];
        if (planRes && planRes.ok) {
          const payload = (await planRes.json()) as ProjectDiscoveryPlansResponse;
          if (Array.isArray(payload.plans) && payload.plans.length > 0) {
            newPlansByProject.set(projectsList[i]!.name, payload.plans);
          }
        }
        if (cycleRes && cycleRes.ok) {
          const payload = (await cycleRes.json()) as { cycles?: WorkCycleOverview[] };
          if (Array.isArray(payload.cycles) && payload.cycles.length > 0) {
            newCyclesByProject.set(projectsList[i]!.name, payload.cycles);
          }
        }
      }
      setPlansByProject(newPlansByProject);
      setCyclesByProject(newCyclesByProject);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const grouped = useMemo(() => {
    const projectMap = new Map<string, Project>();
    for (const p of projects) projectMap.set(p.name, p);

    const result = new Map<string, ProjectGroup>();

    for (const [projectName, plans] of plansByProject) {
      const project = projectMap.get(projectName);
      const displayName = project?.displayName || projectName;
      const cycles = cyclesByProject.get(projectName) ?? [];
      const activeCycle = cycles.find((c) => c.status === 'active' || c.status === 'applying');
      const currentPlans = getCurrentCyclePlans(plans, activeCycle);
      if (currentPlans.length === 0) continue;
      if (!result.has(projectName)) {
        result.set(projectName, { displayName, items: [], activeCycle });
      } else {
        result.get(projectName)!.activeCycle = activeCycle;
      }
      for (const plan of currentPlans) {
        result.get(projectName)!.items.push({
          data: plan,
          projectName,
          projectDisplayName: displayName,
          projectKey: project?.fullPath || '',
        });
      }
    }

    for (const group of result.values()) {
      group.items.sort((a, b) => {
        const timeA = Date.parse(a.data.createdAt) || 0;
        const timeB = Date.parse(b.data.createdAt) || 0;
        return timeB - timeA;
      });
    }

    return result;
  }, [projects, plansByProject, cyclesByProject]);

  const totalItems = useMemo(() => {
    let count = 0;
    for (const group of grouped.values()) count += group.items.length;
    return count;
  }, [grouped]);

  useEffect(() => {
    const validIdsBySelectionKey = new Map<string, Set<string>>();
    for (const [projectName, group] of grouped.entries()) {
      if (!group.activeCycle) continue;
      const planIds = group.items
        .map((item) => item.data.id);
      if (planIds.length > 0) {
        validIdsBySelectionKey.set(selectionKey(projectName, group.activeCycle.id), new Set(planIds));
      }
    }

    setSelectedPlanIdsByCycle((prev) => {
      let changed = false;
      const next = new Map<string, Set<string>>();
      for (const [key, selectedIds] of prev.entries()) {
        const validIds = validIdsBySelectionKey.get(key);
        if (!validIds) {
          changed = true;
          continue;
        }
        const filtered = new Set([...selectedIds].filter((planId) => validIds.has(planId)));
        if (filtered.size !== selectedIds.size) changed = true;
        if (filtered.size > 0) next.set(key, filtered);
      }
      return changed ? next : prev;
    });
  }, [grouped]);

  useEffect(() => {
    setConfirmingArchiveCycle(null);
  }, [selectedPlanIdsByCycle]);

  const toggleProject = (key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updateCycleSelection = useCallback((
    key: string,
    updater: (current: Set<string>) => Set<string>,
  ) => {
    setConfirmingArchiveCycle(null);
    setSelectedPlanIdsByCycle((prev) => {
      const current = new Set(prev.get(key) ?? []);
      const selected = updater(current);
      const next = new Map(prev);
      if (selected.size === 0) next.delete(key);
      else next.set(key, selected);
      return next;
    });
  }, []);

  return (
    <div className="w-full space-y-5 px-8 py-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {t('plansCron.title', { defaultValue: 'Plans' })}
          </h2>
          <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
            {t('plansCron.subtitle', { defaultValue: 'Always-On plans across projects.' })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xxs text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
          <span>{t('actions.refresh', { defaultValue: 'Refresh' })}</span>
        </button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 text-xxs text-red-500">
          <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading && totalItems === 0 ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-neutral-500 dark:text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          <span>{t('plansCron.loading', { defaultValue: 'Loading plans…' })}</span>
        </div>
      ) : totalItems === 0 && !loading ? (
        <div className="py-8 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
          <FileText className="mx-auto mb-2 h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.25} />
          {t('plansCron.empty', { defaultValue: 'No plans found.' })}
        </div>
      ) : (
        <div className="space-y-4">
          {[...grouped.entries()].map(([projectKey, { displayName, items, activeCycle }]) => {
            const isCollapsed = collapsedProjects.has(projectKey);
            const label = displayName;

            return (
              <div
                key={projectKey}
                className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
              >
                {/* Project group header */}
                <button
                  type="button"
                  onClick={() => toggleProject(projectKey)}
                  className="flex w-full items-center gap-2 px-5 py-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                  )}
                  <span className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                    {label}
                  </span>
                  <span className="ml-auto text-xxs tabular-nums text-neutral-400 dark:text-neutral-500">
                    {items.length}
                  </span>
                </button>

                {!isCollapsed && (() => {
                  const planRecords = items.map((item) => item.data);
                  const activeSelectionKey = activeCycle ? selectionKey(projectKey, activeCycle.id) : '';
                  const selectedPlanIds = activeSelectionKey
                    ? selectedPlanIdsByCycle.get(activeSelectionKey) ?? new Set<string>()
                    : new Set<string>();
                  const selectedPlanIdList = planRecords
                    .filter((plan) => selectedPlanIds.has(plan.id))
                    .map((plan) => plan.id);
                  const selectedCount = selectedPlanIdList.length;
                  const allPlansSelected = planRecords.length > 0 && selectedCount === planRecords.length;
                  const partiallySelected = selectedCount > 0 && !allPlansSelected;
                  const applyCheck = evaluateApplySelection(activeCycle, planRecords, selectedPlanIds);
                  const archiveCheck = evaluateArchiveSelection(activeCycle, planRecords, selectedPlanIds);
                  const isApplying = activeCycle?.status === 'applying';
                  const busy = !!activeCycle && cycleBusy === activeCycle.id;
                  const applyDisabled = busy || !applyCheck.enabled;
                  const archiveDisabled = busy || !archiveCheck.enabled;
                  const applyLabel = t('plansCron.actions.applySelected', { defaultValue: 'Apply Selected' });
                  const archiveLabel = t('plansCron.actions.archiveCycle', { defaultValue: 'Archive' });
                  const applyDisabledReason = busy ? t('plansCron.cycleStatus.applying', { defaultValue: 'Applying…' }) : applyCheck.reason;
                  const archiveDisabledReason = busy ? t('plansCron.cycleStatus.applying', { defaultValue: 'Applying…' }) : archiveCheck.reason;

                  const toggleAllPlans = () => {
                    if (!activeSelectionKey) return;
                    setApplyReadinessPrompt(null);
                    updateCycleSelection(activeSelectionKey, (current) => {
                      const allSelected = planRecords.length > 0 && planRecords.every((plan) => current.has(plan.id));
                      return allSelected ? new Set<string>() : new Set(planRecords.map((plan) => plan.id));
                    });
                  };

                  const togglePlan = (planId: string) => {
                    if (!activeSelectionKey) return;
                    setApplyReadinessPrompt(null);
                    updateCycleSelection(activeSelectionKey, (current) => {
                      if (current.has(planId)) current.delete(planId);
                      else current.add(planId);
                      return current;
                    });
                  };

                  const performApply = async (allowDivergedProject: boolean) => {
                    if (onApplyWorkCycle) {
                      await onApplyWorkCycle(projectKey, activeCycle!.id, selectedPlanIdList, { allowDivergedProject });
                    } else {
                      const res = await api.applyWorkCycle(projectKey, activeCycle!.id, selectedPlanIdList, { allowDivergedProject });
                      if (!res.ok) {
                        const body = await res.json().catch(() => ({})) as { error?: string };
                        throw new Error(body?.error || `HTTP ${res.status}`);
                      }
                    }
                  };

                  const handleApply = async (options: { allowDivergedProject?: boolean } = {}) => {
                    if (!activeCycle || applyDisabled) return;
                    setCycleBusy(activeCycle.id);
                    try {
                      if (!options.allowDivergedProject) {
                        const readinessRes = await api.checkApplyReadiness(projectKey, activeCycle.id, selectedPlanIdList);
                        if (!readinessRes.ok) {
                          const body = await readinessRes.json().catch(() => ({})) as { error?: string };
                          throw new Error(body?.error || `HTTP ${readinessRes.status}`);
                        }
                        const readiness = await readinessRes.json() as ApplyProjectReadiness;
                        if (readiness.status === 'dirty' || readiness.status === 'diverged' || readiness.status === 'changed' || readiness.status === 'unknown') {
                          setApplyReadinessPrompt({ cycleId: activeCycle.id, readiness });
                          return;
                        }
                      }
                      await performApply(!!options.allowDivergedProject);
                      setApplyReadinessPrompt(null);
                      await refresh();
                    } catch {
                      // Visible via refresh.
                    } finally {
                      setCycleBusy(null);
                    }
                  };

                  const handleArchive = async () => {
                    if (!activeCycle || archiveDisabled) return;
                    setCycleBusy(activeCycle.id);
                    try {
                      const res = await api.archiveWorkCycle(projectKey, activeCycle.id, selectedPlanIdList);
                      if (!res.ok) {
                        const body = await res.json().catch(() => ({})) as { error?: string };
                        throw new Error(body?.error || `HTTP ${res.status}`);
                      }
                      await refresh();
                    } catch {
                      // Visible via refresh.
                    } finally {
                      setCycleBusy(null);
                      setConfirmingArchiveCycle(null);
                    }
                  };

                  const confirmingArchive = !!activeCycle && confirmingArchiveCycle === activeCycle.id;
                  const applyPrompt = !!activeCycle && applyReadinessPrompt?.cycleId === activeCycle.id
                    ? applyReadinessPrompt
                    : null;
                  const applyPromptMessage = applyPrompt
                    ? applyPrompt.readiness.status === 'dirty'
                      ? t('plansCron.applyReadiness.dirty', { defaultValue: 'The project has uncommitted changes. Please handle them before applying.' })
                      : applyPrompt.readiness.status === 'changed'
                        ? t('plansCron.applyReadiness.changed', { defaultValue: 'The project has file changes since the isolated workspace was created.' })
                        : applyPrompt.readiness.status === 'unknown'
                          ? t('plansCron.applyReadiness.unknown', { defaultValue: 'PilotDeck could not verify whether the project still matches the isolated workspace.' })
                          : t('plansCron.applyReadiness.diverged', { defaultValue: 'The project state differs from the isolated workspace base.' })
                    : '';

                  return (
                    <>
                      <SubSection
                        sectionKey={`${projectKey}::plans`}
                        label={`${t('plansCron.type.plan', { defaultValue: 'Plan' })} (${items.length})`}
                        collapsedSections={collapsedSections}
                        toggleSection={toggleSection}
                        actions={
                          <div className="flex items-center gap-1.5">
                            {applyPrompt && (
                              <div className="flex max-w-[360px] items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                                <span className="line-clamp-2">{applyPromptMessage}</span>
                                {applyPrompt.readiness.status !== 'dirty' && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleApply({ allowDivergedProject: true })}
                                    className="ml-1 inline-flex h-6 shrink-0 items-center rounded bg-amber-600 px-2 text-[11px] font-medium text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-500 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
                                  >
                                    {t('plansCron.applyReadiness.continue', { defaultValue: 'Continue' })}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setApplyReadinessPrompt(null)}
                                  className="inline-flex h-6 shrink-0 items-center rounded border border-amber-200 px-2 text-[11px] text-amber-700 transition hover:bg-amber-100 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-900/60"
                                >
                                  {applyPrompt.readiness.status === 'dirty'
                                    ? t('plansCron.applyReadiness.dismiss', { defaultValue: 'Dismiss' })
                                    : t('plansCron.applyReadiness.cancel', { defaultValue: 'Cancel' })}
                                </button>
                              </div>
                            )}
                            {isApplying && (
                              <span className="inline-flex items-center gap-1 text-xxs text-sky-600 dark:text-sky-400">
                                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                                {t('plansCron.cycleStatus.applying', { defaultValue: 'Applying…' })}
                              </span>
                            )}
                            {!isApplying && (
                              <button
                                type="button"
                                disabled={applyDisabled}
                                onClick={() => void handleApply()}
                                title={applyDisabledReason || applyLabel}
                                aria-label={applyDisabledReason ? `${applyLabel}: ${applyDisabledReason}` : applyLabel}
                                className={cn(
                                  'inline-flex h-7 items-center rounded-md px-2.5 text-[11px] font-medium transition disabled:cursor-not-allowed',
                                  applyDisabled
                                    ? 'bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500'
                                    : 'bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600',
                                )}
                              >
                                {busy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                                ) : (
                                  applyLabel
                                )}
                              </button>
                            )}
                            {!confirmingArchive && (
                              <button
                                type="button"
                                disabled={archiveDisabled}
                                onClick={() => {
                                  if (!activeCycle || archiveDisabled) return;
                                  setConfirmingArchiveCycle(activeCycle.id);
                                }}
                                className={cn(
                                  'inline-flex h-7 items-center rounded-md border px-2 transition disabled:cursor-not-allowed',
                                  archiveDisabled
                                    ? 'border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-600'
                                    : 'border-neutral-200 text-neutral-500 hover:border-red-300 hover:text-red-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-red-700 dark:hover:text-red-400',
                                )}
                                title={archiveDisabledReason || archiveLabel}
                                aria-label={archiveDisabledReason ? `${archiveLabel}: ${archiveDisabledReason}` : archiveLabel}
                              >
                                <Archive className="h-3.5 w-3.5" strokeWidth={1.75} />
                              </button>
                            )}
                            {confirmingArchive && (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={archiveDisabled}
                                  onClick={() => void handleArchive()}
                                  title={archiveDisabledReason || archiveLabel}
                                  className="inline-flex h-7 items-center rounded-md bg-red-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-500 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
                                >
                                  {busy ? (
                                    <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                                  ) : (
                                    archiveLabel
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmingArchiveCycle(null)}
                                  className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-[11px] text-neutral-500 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
                                >
                                  ✕
                                </button>
                              </div>
                            )}
                          </div>
                        }
                      >
                        <div className="grid grid-cols-1">
                          <div className="min-w-0" data-plan-list="true">
                            <ColumnHeaders
                              t={t}
                              selectable
                              showActions={false}
                              allSelected={allPlansSelected}
                              partiallySelected={partiallySelected}
                              onToggleAll={toggleAllPlans}
                            />
                            <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
                              {items.map((item) => (
                                <ItemRow
                                  key={`plan-${item.data.id}`}
                                  item={item}
                                  t={t}
                                  onRefresh={refresh}
                                  onOpenPlanDetail={onOpenPlanDetail}
                                  selected={selectedPlanIds.has(item.data.id)}
                                  showActions={false}
                                  onToggleSelected={() => togglePlan(item.data.id)}
                                />
                              ))}
                            </div>
                          </div>
                          <DependencyGraph
                            plans={planRecords}
                            cycle={activeCycle}
                            selectedPlanIds={selectedPlanIds}
                            label={t('plansCron.columns.dependencyGraph', { defaultValue: 'Dependency Graph' })}
                            onTogglePlan={togglePlan}
                          />
                        </div>
                      </SubSection>
                    </>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible sub-section within a project card
// ---------------------------------------------------------------------------

function SubSection({
  sectionKey,
  label,
  collapsedSections,
  toggleSection,
  actions,
  children,
}: {
  sectionKey: string;
  label: string;
  collapsedSections: Set<string>;
  toggleSection: (key: string) => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isCollapsed = collapsedSections.has(sectionKey);
  return (
    <>
      <div className="flex items-center gap-2 border-t border-neutral-200 bg-neutral-50/80 px-5 py-2 dark:border-neutral-800 dark:bg-neutral-900/30">
        <button
          type="button"
          onClick={() => toggleSection(sectionKey)}
          className="flex items-center gap-1.5 text-xxs font-semibold uppercase tracking-wider text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          {isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          )}
          {label}
        </button>
        {!isCollapsed && actions && <div className="ml-auto">{actions}</div>}
      </div>
      {!isCollapsed && children}
    </>
  );
}

// ---------------------------------------------------------------------------
// Column headers
// ---------------------------------------------------------------------------

function ColumnHeaders({
  t,
  selectable = false,
  showActions = true,
  allSelected = false,
  partiallySelected = false,
  onToggleAll,
}: {
  t: (key: string, opts?: Record<string, string>) => string;
  selectable?: boolean;
  showActions?: boolean;
  allSelected?: boolean;
  partiallySelected?: boolean;
  onToggleAll?: () => void;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-neutral-200 bg-neutral-50 px-5 py-2 dark:border-neutral-800 dark:bg-neutral-900/50">
      {selectable && (
        <div className={COL.select}>
          <input
            type="checkbox"
            checked={allSelected}
            aria-checked={partiallySelected ? 'mixed' : allSelected}
            aria-label={t('plansCron.selection.selectAll', { defaultValue: 'Select all plans' })}
            onChange={onToggleAll}
            className="h-3.5 w-3.5 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
      )}
      <div className={COL.title}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('plansCron.columns.title', { defaultValue: 'Title' })}
        </span>
      </div>
      <div className={COL.createdAt}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('plansCron.columns.createdAt', { defaultValue: 'Created' })}
        </span>
      </div>
      <div className={COL.status}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('plansCron.columns.status', { defaultValue: 'Status' })}
        </span>
      </div>
      {showActions && (
        <div className={COL.actions}>
          <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {t('plansCron.columns.actions', { defaultValue: 'Actions' })}
          </span>
        </div>
      )}
    </div>
  );
}

function DependencyGraph({
  plans,
  cycle,
  selectedPlanIds,
  label,
  onTogglePlan,
}: {
  plans: DiscoveryPlanOverview[];
  cycle?: WorkCycleOverview;
  selectedPlanIds: Set<string>;
  label: string;
  onTogglePlan: (planId: string) => void;
}) {
  const markerId = useId().replace(/:/g, '');
  const layout = useMemo(() => buildGraphLayout(plans, cycle), [plans, cycle]);
  const nodeById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.plan.id, node])),
    [layout.nodes],
  );
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const viewportHeight = Math.max(170, Math.min(300, layout.height + 24));

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    });
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  };

  const handlePointerEnd = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (drag?.pointerId === event.pointerId) setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="border-t border-neutral-200 bg-neutral-50/40 dark:border-neutral-800 dark:bg-neutral-900/20" data-dependency-graph="true">
      <div className="border-b border-neutral-200 px-3 py-2 text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        {label}
      </div>
      <svg
        role="img"
        aria-label={label}
        className={cn(
          'block w-full select-none touch-none bg-white dark:bg-neutral-950',
          drag ? 'cursor-grabbing' : 'cursor-grab',
        )}
        style={{ height: viewportHeight }}
        viewBox={`0 0 ${layout.width} ${viewportHeight}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <defs>
          <marker
            id={markerId}
            markerHeight="8"
            markerWidth="8"
            orient="auto"
            refX="7"
            refY="4"
          >
            <path d="M0,0 L8,4 L0,8 Z" className="fill-neutral-400 dark:fill-neutral-600" />
          </marker>
        </defs>
        <rect width={layout.width} height={viewportHeight} className="fill-transparent" />
        <g transform={`translate(${pan.x} ${pan.y})`}>
          {layout.edges.map((edge) => {
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to) return null;
            const startX = from.x + GRAPH_NODE_WIDTH;
            const startY = from.y + GRAPH_NODE_HEIGHT / 2;
            const endX = to.x;
            const endY = to.y + GRAPH_NODE_HEIGHT / 2;
            const curve = Math.max(42, (endX - startX) / 2);
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={`M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX - 8} ${endY}`}
                className="fill-none stroke-neutral-300 dark:stroke-neutral-700"
                markerEnd={`url(#${markerId})`}
                strokeWidth="1.4"
              />
            );
          })}
          {layout.nodes.map((node) => {
            const selected = selectedPlanIds.has(node.plan.id);
            const title = node.plan.title || node.plan.id;
            return (
              <g
                key={node.plan.id}
                role="button"
                tabIndex={0}
                aria-label={`Select graph plan: ${title}`}
                data-plan-node={node.plan.id}
                data-selected={selected ? 'true' : 'false'}
                className="cursor-pointer outline-none"
                transform={`translate(${node.x} ${node.y})`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onTogglePlan(node.plan.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onTogglePlan(node.plan.id);
                }}
              >
                <rect
                  width={GRAPH_NODE_WIDTH}
                  height={GRAPH_NODE_HEIGHT}
                  rx="6"
                  className={cn(
                    'stroke transition-colors',
                    selected
                      ? 'fill-blue-50 stroke-blue-500 dark:fill-blue-950/70 dark:stroke-blue-400'
                      : 'fill-white stroke-neutral-200 dark:fill-neutral-900 dark:stroke-neutral-700',
                  )}
                />
                <circle
                  cx="15"
                  cy="22"
                  r="4"
                  className={selected ? 'fill-blue-500 dark:fill-blue-400' : 'fill-neutral-300 dark:fill-neutral-600'}
                />
                <foreignObject
                  x="27"
                  y="7"
                  width={GRAPH_NODE_WIDTH - 38}
                  height={GRAPH_NODE_HEIGHT - 12}
                >
                  <div className="flex h-full min-w-0 flex-col justify-center">
                    <div
                      data-graph-node-title="true"
                      title={title}
                      className={cn(
                        'overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-medium leading-3 text-neutral-900 dark:text-neutral-100',
                        selected && 'text-blue-700 dark:text-blue-300',
                      )}
                    >
                      {title}
                    </div>
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[9px] leading-3 text-neutral-400 dark:text-neutral-500">
                      {node.plan.status}
                    </div>
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  t,
  onRefresh,
  onOpenPlanDetail,
  selected = false,
  showActions = true,
  onToggleSelected,
}: {
  item: PlanItem;
  t: (key: string, opts?: Record<string, string>) => string;
  onRefresh: () => Promise<void>;
  onOpenPlanDetail?: (planId: string, projectName: string, projectDisplayName: string, sourceRunId: string, projectKey: string) => void;
  selected?: boolean;
  showActions?: boolean;
  onToggleSelected?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const plan = item.data;
  const title = plan.title || '—';
  const fullTitle = plan.title || '';
  const createdAt = plan.createdAt;
  const displayStatus = mapPlanStatus(plan.status);
  const meta = PLAN_STATUS_LABEL[displayStatus];
  const statusLabel = t(meta.key, { defaultValue: meta.defaultValue });
  const statusStyle = PLAN_STATUS_STYLE[displayStatus];

  const showRetry = displayStatus === 'failed';

  const handleRetry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.executeProjectDiscoveryPlan(item.projectName, plan.id, { source: 'manual' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      await onRefresh();
    } catch {
      // Visible via refresh.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4 px-5 py-2.5 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
      <div className={COL.select}>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`${t('plansCron.selection.selectPlan', { defaultValue: 'Select plan' })}: ${title}`}
          onChange={onToggleSelected}
          className="h-3.5 w-3.5 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      {/* Title */}
      <div className={cn(COL.title, 'truncate text-[13px] text-neutral-900 dark:text-neutral-100')} title={fullTitle}>
        {onOpenPlanDetail ? (
          <button
            type="button"
            onClick={() => onOpenPlanDetail(plan.id, item.projectName, item.projectDisplayName, plan.sourceRunId || plan.sourceDiscoverySessionId || '', item.projectKey)}
            className="truncate text-left hover:underline"
          >
            {title}
          </button>
        ) : (
          title
        )}
      </div>

      {/* Created */}
      <div className={cn(COL.createdAt, 'font-mono text-xxs tabular-nums text-neutral-500 dark:text-neutral-400')}>
        {formatAbsoluteTime(createdAt)}
      </div>

      {/* Status */}
      <div className={COL.status}>
        <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11px] font-medium', statusStyle)}>
          {statusLabel}
        </span>
      </div>

      {showActions && (
        <div className={cn(COL.actions, 'flex items-center gap-1.5')}>
          {showRetry && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRetry()}
              className="inline-flex h-7 items-center rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
              ) : (
                t('plansCron.actions.retry', { defaultValue: 'Retry' })
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
