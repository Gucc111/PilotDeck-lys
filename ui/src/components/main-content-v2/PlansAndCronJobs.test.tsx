// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DiscoveryPlanOverview,
  Project,
  WorkCycleOverview,
} from '../../types/app';
import PlansAndCronJobs from './PlansAndCronJobs';

const apiMock = vi.hoisted(() => ({
  projects: vi.fn(),
  allCronJobs: vi.fn(),
  projectDiscoveryPlans: vi.fn(),
  projectWorkCycles: vi.fn(),
  checkApplyReadiness: vi.fn(),
  applyWorkCycle: vi.fn(),
  archiveWorkCycle: vi.fn(),
  executeProjectDiscoveryPlan: vi.fn(),
  cronDelete: vi.fn(),
  cronRunNow: vi.fn(),
  cronStop: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  api: apiMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => (
      typeof options?.defaultValue === 'string' ? options.defaultValue : _key
    ),
  }),
}));

const project: Project = {
  name: 'general',
  displayName: 'General',
  fullPath: '/project/general',
};

type CyclePlanState = NonNullable<WorkCycleOverview['plans']>[string];

function jsonResponse<T>(body: T, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function makePlan(
  id: string,
  title: string,
  overrides: Partial<DiscoveryPlanOverview> = {},
): DiscoveryPlanOverview {
  return {
    id,
    title,
    createdAt: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
    updatedAt: `2026-01-01T00:00:1${id.slice(-1)}.000Z`,
    status: 'completed',
    workCycleId: 'cycle-current',
    sourceRunId: `run-${id}`,
    executionCommitShas: [`commit-${id}`],
    dependsOnPlanIds: [],
    dependencyReasons: [],
    dependencyAnalysisStatus: 'clean',
    ...overrides,
  };
}

function makePlanState(overrides: Partial<CyclePlanState> = {}): CyclePlanState {
  return {
    status: 'completed',
    commitShas: ['commit'],
    dependsOnPlanIds: [],
    dependencyReasons: [],
    dependencyAnalysisStatus: 'clean',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCycle(
  plans: Record<string, CyclePlanState>,
  overrides: Partial<WorkCycleOverview> = {},
): WorkCycleOverview {
  return {
    id: 'cycle-current',
    projectKey: '/project/general',
    status: 'active',
    baseCommit: 'base',
    workspace: {
      strategy: 'snapshot-copy',
      cwd: '/tmp/workspace',
    },
    planIds: Object.keys(plans),
    plans,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(plans: DiscoveryPlanOverview[], cycles: WorkCycleOverview[]) {
  apiMock.projects.mockResolvedValue(jsonResponse([project]));
  apiMock.projectDiscoveryPlans.mockResolvedValue(jsonResponse({ plans }));
  apiMock.projectWorkCycles.mockResolvedValue(jsonResponse({ cycles }));
  apiMock.checkApplyReadiness.mockResolvedValue(jsonResponse({
    isProjectGit: true,
    status: 'clean',
    changedFiles: [],
    affectedPaths: [],
    conflictingPaths: [],
    message: 'clean',
  }));
  apiMock.applyWorkCycle.mockResolvedValue(jsonResponse({ ok: true }));
  apiMock.archiveWorkCycle.mockResolvedValue(jsonResponse({ archived: true }));

  return render(<PlansAndCronJobs />);
}

async function waitForPlans() {
  await screen.findByText('General');
}

function applyButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Apply Selected/ }) as HTMLButtonElement;
}

function archiveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Archive/ }) as HTMLButtonElement;
}

function graphNode(planId: string): Element {
  const node = document.querySelector(`[data-plan-node="${planId}"]`);
  if (!node) throw new Error(`Missing graph node ${planId}`);
  return node;
}

describe('PlansAndCronJobs selection behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows only unresolved plans from the current active cycle', async () => {
    setup(
      [
        makePlan('plan-a', 'Current Cycle Plan'),
        makePlan('plan-old', 'Old Cycle Plan', { workCycleId: 'cycle-old' }),
        makePlan('plan-applied', 'Applied Plan', { status: 'applied' }),
      ],
      [
        makeCycle({
          'plan-a': makePlanState(),
          'plan-applied': makePlanState({ status: 'applied' }),
        }),
      ],
    );

    await waitFor(() => {
      expect(screen.getAllByText('Current Cycle Plan').length).toBeGreaterThan(0);
    });

    expect(screen.queryByText('Old Cycle Plan')).toBeNull();
    expect(screen.queryByText('Applied Plan')).toBeNull();
    expect(apiMock.allCronJobs).not.toHaveBeenCalled();
  });

  it('shows plans from the latest active or applying cycle when cycles are unordered', async () => {
    setup(
      [
        makePlan('plan-old', 'Older Active Cycle Plan', {
          workCycleId: 'cycle-old',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        makePlan('plan-new', 'Latest Active Cycle Plan', {
          workCycleId: 'cycle-new',
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
      ],
      [
        makeCycle(
          { 'plan-old': makePlanState() },
          { id: 'cycle-old', createdAt: '2026-01-01T00:00:00.000Z' },
        ),
        makeCycle(
          { 'plan-new': makePlanState() },
          { id: 'cycle-new', status: 'applying', createdAt: '2026-01-03T00:00:00.000Z' },
        ),
      ],
    );

    await waitFor(() => {
      expect(screen.getAllByText('Latest Active Cycle Plan').length).toBeGreaterThan(0);
    });

    expect(screen.queryByText('Older Active Cycle Plan')).toBeNull();
  });

  it('hides archived plans from the latest cycle while showing unresolved plans', async () => {
    setup(
      [
        makePlan('plan-visible', 'Visible Latest Plan', { workCycleId: 'cycle-new' }),
        makePlan('plan-archived-record', 'Archived By Plan Record', {
          workCycleId: 'cycle-new',
          status: 'archived',
        }),
        makePlan('plan-archived-cycle', 'Archived By Cycle State', { workCycleId: 'cycle-new' }),
      ],
      [
        makeCycle(
          {
            'plan-visible': makePlanState(),
            'plan-archived-record': makePlanState(),
            'plan-archived-cycle': makePlanState({ status: 'archived' }),
          },
          { id: 'cycle-new', createdAt: '2026-01-03T00:00:00.000Z' },
        ),
      ],
    );

    await waitFor(() => {
      expect(screen.getAllByText('Visible Latest Plan').length).toBeGreaterThan(0);
    });

    expect(screen.queryByText('Archived By Plan Record')).toBeNull();
    expect(screen.queryByText('Archived By Cycle State')).toBeNull();
  });

  it('does not show unresolved plans from older cycles', async () => {
    setup(
      [
        makePlan('plan-old', 'Unresolved Older Cycle Plan', { workCycleId: 'cycle-old' }),
        makePlan('plan-new', 'Unresolved Latest Cycle Plan', { workCycleId: 'cycle-new' }),
      ],
      [
        makeCycle(
          { 'plan-new': makePlanState() },
          { id: 'cycle-new', createdAt: '2026-01-03T00:00:00.000Z' },
        ),
        makeCycle(
          { 'plan-old': makePlanState() },
          { id: 'cycle-old', createdAt: '2026-01-02T00:00:00.000Z' },
        ),
      ],
    );

    await waitFor(() => {
      expect(screen.getAllByText('Unresolved Latest Cycle Plan').length).toBeGreaterThan(0);
    });

    expect(screen.queryByText('Unresolved Older Cycle Plan')).toBeNull();
  });

  it('disables apply until selected plans include their dependencies', async () => {
    setup(
      [
        makePlan('plan-a', 'Plan A'),
        makePlan('plan-b', 'Plan B'),
      ],
      [
        makeCycle({
          'plan-a': makePlanState({ commitShas: ['commit-a'] }),
          'plan-b': makePlanState({ commitShas: ['commit-b'], dependsOnPlanIds: ['plan-a'] }),
        }),
      ],
    );

    await waitForPlans();

    fireEvent.click(screen.getByLabelText('Select plan: Plan B'));
    expect(applyButton().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Select plan: Plan A'));
    await waitFor(() => expect(applyButton().disabled).toBe(false));
  });

  it('replaces the plan Actions column with a selectable dependency graph', async () => {
    setup(
      [
        makePlan('plan-a', 'Plan A'),
        makePlan('plan-b', 'Plan B'),
      ],
      [
        makeCycle({
          'plan-a': makePlanState({ commitShas: ['commit-a'] }),
          'plan-b': makePlanState({ commitShas: ['commit-b'], dependsOnPlanIds: ['plan-a'] }),
        }),
      ],
    );

    await waitForPlans();

    expect(screen.queryByText('Actions')).toBeNull();
    expect(screen.getByText('Dependency Graph')).toBeTruthy();

    const planList = document.querySelector('[data-plan-list="true"]');
    const dependencyGraph = document.querySelector('[data-dependency-graph="true"]');
    expect(planList).toBeTruthy();
    expect(dependencyGraph).toBeTruthy();
    expect(
      planList!.compareDocumentPosition(dependencyGraph!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Select plan: Plan B'));
    await waitFor(() => {
      expect(graphNode('plan-b').getAttribute('data-selected')).toBe('true');
    });

    fireEvent.click(screen.getByLabelText('Select graph plan: Plan A'));
    await waitFor(() => {
      expect((screen.getByLabelText('Select plan: Plan A') as HTMLInputElement).checked).toBe(true);
    });
  });

  it('clips long dependency graph titles inside fixed-size nodes', async () => {
    const longTitle = 'Fix every exceptionally long failing test title in poker core without letting text escape graph nodes';
    setup(
      [makePlan('plan-a', longTitle)],
      [makeCycle({ 'plan-a': makePlanState({ commitShas: ['commit-a'] }) })],
    );

    await waitForPlans();

    const title = graphNode('plan-a').querySelector('[data-graph-node-title="true"]');
    expect(title).toBeTruthy();
    expect(title!.textContent).toBe(longTitle);
    expect(title!.classList.contains('overflow-hidden')).toBe(true);
    expect(title!.classList.contains('text-ellipsis')).toBe(true);
    expect(title!.classList.contains('whitespace-nowrap')).toBe(true);
  });

  it('disables archive when remaining plans would lose a dependency', async () => {
    setup(
      [
        makePlan('plan-a', 'Plan A'),
        makePlan('plan-b', 'Plan B'),
      ],
      [
        makeCycle({
          'plan-a': makePlanState({ commitShas: ['commit-a'] }),
          'plan-b': makePlanState({ commitShas: ['commit-b'], dependsOnPlanIds: ['plan-a'] }),
        }),
      ],
    );

    await waitForPlans();

    fireEvent.click(screen.getByLabelText('Select plan: Plan A'));
    expect(archiveButton().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Select plan: Plan A'));
    fireEvent.click(screen.getByLabelText('Select plan: Plan B'));
    await waitFor(() => expect(archiveButton().disabled).toBe(false));
  });

  it('requires whole-cycle archive when dependency analysis failed', async () => {
    setup(
      [
        makePlan('plan-a', 'Plan A'),
        makePlan('plan-b', 'Plan B'),
      ],
      [
        makeCycle({
          'plan-a': makePlanState({ dependencyAnalysisStatus: 'failed' }),
          'plan-b': makePlanState(),
        }),
      ],
    );

    await waitForPlans();

    fireEvent.click(screen.getByLabelText('Select plan: Plan A'));
    expect(applyButton().disabled).toBe(true);
    expect(archiveButton().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Select all plans'));
    await waitFor(() => expect(archiveButton().disabled).toBe(false));
    expect(applyButton().disabled).toBe(true);
  });

  it('sends selected planIds to apply and archive APIs', async () => {
    setup(
      [
        makePlan('plan-a', 'Plan A'),
        makePlan('plan-b', 'Plan B'),
      ],
      [
        makeCycle({
          'plan-a': makePlanState({ commitShas: ['commit-a'] }),
          'plan-b': makePlanState({ commitShas: ['commit-b'] }),
        }),
      ],
    );

    await waitForPlans();

    fireEvent.click(screen.getByLabelText('Select plan: Plan A'));
    fireEvent.click(screen.getByLabelText('Select plan: Plan B'));
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    fireEvent.click(applyButton());
    await waitFor(() => {
      expect(apiMock.checkApplyReadiness).toHaveBeenCalledWith('general', 'cycle-current', ['plan-a', 'plan-b']);
      expect(apiMock.applyWorkCycle).toHaveBeenCalledWith('general', 'cycle-current', ['plan-a', 'plan-b'], { allowDivergedProject: false });
    });

    fireEvent.click(archiveButton());
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }));
    await waitFor(() => {
      expect(apiMock.archiveWorkCycle).toHaveBeenCalledWith('general', 'cycle-current', ['plan-a', 'plan-b']);
    });
  });

  it('blocks apply when readiness reports dirty project files', async () => {
    setup(
      [makePlan('plan-a', 'Plan A')],
      [makeCycle({ 'plan-a': makePlanState({ commitShas: ['commit-a'] }) })],
    );
    apiMock.checkApplyReadiness.mockResolvedValue(jsonResponse({
      isProjectGit: true,
      status: 'dirty',
      changedFiles: [{ status: 'M', path: 'file.txt' }],
      affectedPaths: ['file.txt'],
      conflictingPaths: ['file.txt'],
      message: 'dirty',
    }));

    await waitForPlans();
    fireEvent.click(screen.getByLabelText('Select plan: Plan A'));
    fireEvent.click(applyButton());

    await screen.findByText('The project has uncommitted changes. Please handle them before applying.');
    expect(apiMock.applyWorkCycle).not.toHaveBeenCalled();
  });

  it('confirms diverged project files before continuing apply', async () => {
    setup(
      [makePlan('plan-a', 'Plan A')],
      [makeCycle({ 'plan-a': makePlanState({ commitShas: ['commit-a'] }) })],
    );
    apiMock.checkApplyReadiness.mockResolvedValue(jsonResponse({
      isProjectGit: true,
      status: 'diverged',
      changedFiles: [{ status: 'M', path: 'file.txt' }],
      affectedPaths: ['file.txt'],
      conflictingPaths: ['file.txt'],
      message: 'diverged',
    }));

    await waitForPlans();
    fireEvent.click(screen.getByLabelText('Select plan: Plan A'));
    fireEvent.click(applyButton());

    await screen.findByText('The project state differs from the isolated workspace base.');
    expect(apiMock.applyWorkCycle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(apiMock.applyWorkCycle).toHaveBeenCalledWith('general', 'cycle-current', ['plan-a'], { allowDivergedProject: true });
    });
  });
});
