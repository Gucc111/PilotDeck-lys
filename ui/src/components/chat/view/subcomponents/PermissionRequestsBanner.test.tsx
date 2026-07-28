// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PermissionRequestsBanner from './PermissionRequestsBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'permissionBanner.title': 'Permission required',
        'permissionBanner.tool': 'Tool:',
        'permissionBanner.allowRule': 'Allow rule:',
        'permissionBanner.allowRemember': 'Allow & remember',
        'permissionBanner.allowOnce': 'Allow once',
        'permissionBanner.deny': 'Deny',
        'permissionBanner.fromTeammate': `From Teammate ${String(options?.id ?? '')}`,
        'plan.exitMode.header': 'Plan is ready',
        'plan.exitMode.subtitle': 'Confirm the plan.',
        'plan.exitMode.feedbackLabel': 'Optional notes',
        'plan.exitMode.feedbackPlaceholder': 'Add notes',
        'plan.exitMode.continueButton': 'Continue Discussion',
        'plan.exitMode.executeButton': 'Execute Plan',
        'plan.exitMode.syncingPlan': 'Syncing plan',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../../utils/chatStorage', () => ({
  getPilotDeckSettings: () => ({ version: 2, rules: [] }),
}));

afterEach(() => {
  cleanup();
});

const commonProps = {
  handlePermissionDecision: vi.fn(),
  handleGrantToolPermission: vi.fn(() => ({ success: true })),
};

describe('PermissionRequestsBanner Team origins', () => {
  it('shows a Teammate source on ordinary permission requests', () => {
    render(
      <PermissionRequestsBanner
        {...commonProps}
        pendingPermissionRequests={[{
          requestId: 'permission-1',
          toolName: 'bash',
          input: { command: 'npm test' },
          context: { teammateId: 'implementer' },
        }]}
      />,
    );

    expect(screen.getByText('From Teammate implementer')).toBeTruthy();
    expect(screen.getByText('Permission required')).toBeTruthy();
  });

  it('shows a Teammate source above the ExitPlanMode panel', () => {
    render(
      <PermissionRequestsBanner
        {...commonProps}
        pendingPermissionRequests={[{
          requestId: 'plan-1',
          toolName: 'ExitPlanModeV2',
          input: {
            plan: '# Team plan',
            metadata: { teammateId: 'planner' },
          },
        }]}
      />,
    );

    expect(screen.getByText('From Teammate planner')).toBeTruthy();
    expect(screen.getByText('Plan is ready')).toBeTruthy();
  });

  it('does not add a source label to ordinary non-Team requests', () => {
    render(
      <PermissionRequestsBanner
        {...commonProps}
        pendingPermissionRequests={[{
          requestId: 'permission-plain',
          toolName: 'bash',
          input: { command: 'npm test' },
        }]}
      />,
    );

    expect(screen.queryByText(/From Teammate/)).toBeNull();
    expect(screen.getByText('Permission required')).toBeTruthy();
  });
});
