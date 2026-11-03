// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TeamModeControls, { cleanupTarget } from './TeamModeControls';
import type { TeamRuntimeActivation } from '../../../../src/team/runtimeTypes';
import type { TeamModeState } from './useTeamMode';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const profile = { config: { displayName: 'Release reviewer', model: { mode: 'default' }, capabilities: { tools: [], skills: [], mcpServers: [] } } };
const activation = { id: 'activation-uuid', stopVersion: 4, status: 'stopping', team: { id: 'team', createdAt: '', updatedAt: '', config: { displayName: 'Review team' }, leader: profile as any, teammates: [] }, participants: [
  { id: 'leader-uuid', role: 'leader', profile: { config: { ...profile.config, displayName: 'Release lead' } }, model: profile.config.model, capabilities: profile.config.capabilities },
  { id: 'reviewer-uuid', role: 'teammate', profile, model: profile.config.model, capabilities: profile.config.capabilities },
], works: [], messages: [], cleanup: { startedAt: '', pending: ['activation-uuid:reviewer-uuid:3:messages', 'leader', 'activation-uuid:notifications', 'final resource cleanup'], timedOut: true } } as unknown as TeamRuntimeActivation;

function choiceMode(overrides: Record<string, unknown>) {
  return {
    choice: null,
    confirmChoice: vi.fn(),
    cancelChoice: vi.fn(),
    changing: false,
    locked: false,
    loading: false,
    error: null,
    history: [],
    interactions: [],
    panelOpen: false,
    registeredProjects: [],
    selectedTeam: null,
    setPanelOpen: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as TeamModeState;
}

it('automatically selects a clean Team without showing the confirmation card', async () => {
  const confirmChoice = vi.fn();
  const choice = {
    team: activation.team,
    projectKey: '/work',
    requestToken: 'request',
    checking: false,
    error: null,
    probe: { projectKey: '/work', participants: [], issues: [], compatible: true, fingerprint: 'fingerprint' },
  };
  render(<TeamModeControls mode={choiceMode({ choice, confirmChoice })}/>);
  await waitFor(() => expect(confirmChoice).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not show the confirmation card while the Team probe is still running', () => {
  const choice = {
    team: activation.team,
    projectKey: '/work',
    requestToken: 'request',
    checking: true,
    error: null,
    probe: null,
  };
  render(<TeamModeControls mode={choiceMode({ choice })}/>);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('blocks selection when a required capability is missing', () => {
  const confirmChoice = vi.fn();
  const choice = {
    team: activation.team,
    projectKey: '/work',
    requestToken: 'request',
    checking: false,
    error: null,
    probe: {
      projectKey: '/work',
      participants: [],
      issues: [{ severity: 'error', code: 'TEAM_CAPABILITY_MISSING', message: 'Lead reviewer: skill research is unavailable.', participantId: 'leader-uuid' }],
      compatible: false,
      fingerprint: 'fingerprint',
    },
  };
  render(<TeamModeControls mode={choiceMode({ choice, confirmChoice })}/>);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('Lead reviewer: skill research is unavailable.')).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(confirmChoice).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'teamMode.useTeam' }) as HTMLButtonElement).disabled).toBe(true);
});

it('resolves real runtime execution and message delivery keys to participant display names', () => {
  for (const key of ['activation-uuid:reviewer-uuid:3', 'activation-uuid:reviewer-uuid:3:messages']) {
    expect(cleanupTarget(activation, key)).toEqual({ participantId: 'reviewer-uuid', label: 'Teammate · Release reviewer' });
  }
  expect(cleanupTarget(activation, 'leader')).toEqual({ participantId: 'leader-uuid', label: 'Leader · Release lead' });
  expect(cleanupTarget(activation, 'activation-uuid:notifications').translationKey).toBe('teamMode.cleanupNotifications');
  expect(cleanupTarget(activation, 'final resource cleanup').translationKey).toBe('teamMode.cleanupResources');
});

it('shows both members as stopping and uses human names for actual pending execution keys', () => {
  render(<TeamModeControls mode={{ activation, history: [], selectedTeam: activation.team, panelOpen: true, setPanelOpen: vi.fn(), refresh: vi.fn() } as unknown as TeamModeState}/>);
  const dialog = screen.getByRole('dialog');
  const cards = within(dialog).getAllByRole('article');
  expect(within(cards[0]).getByText('Leader · teamMode.stopping')).toBeTruthy();
  expect(within(cards[1]).getByText('Teammate · teamMode.stopping')).toBeTruthy();
  expect(within(dialog).getByText('Teammate · Release reviewer')).toBeTruthy();
  expect(within(dialog).getByText('teamMode.cleanupResources')).toBeTruthy();
  expect(dialog.textContent).not.toContain('activation-uuid');
  expect(dialog.textContent).not.toContain('reviewer-uuid');
});

it('places Team interaction next to details and restores the panel after returning', () => {
  sessionStorage.clear();
  const mode = { activation, interactions: [], history: [], selectedTeam: activation.team, panelOpen: false, setPanelOpen: vi.fn(), refresh: vi.fn() } as unknown as TeamModeState;
  const view = render(<TeamModeControls mode={mode}/>);
  const details = screen.getByRole('button', { name: 'teamMode.details' });
  const interactions = screen.getByRole('button', { name: 'teamInteractions.title' });
  expect(details.nextElementSibling).toBe(interactions);
  fireEvent.click(interactions);
  expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('teamInteractions.title');
  view.unmount(); render(<TeamModeControls mode={mode}/>);
  expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('teamInteractions.title');
  sessionStorage.clear();
});
