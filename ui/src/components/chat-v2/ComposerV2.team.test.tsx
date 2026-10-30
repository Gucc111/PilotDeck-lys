// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerV2, { type ComposerV2Props } from './ComposerV2';
import type { TeamDefinition } from '../team-library/api';
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }));
vi.mock('../chat/hooks/useChatComposerState', () => ({ MAX_ATTACHMENTS_ERROR_KEY: 'limit' }));
const team = { id: 'team', config: { displayName: 'Release review' }, leader: { config: { displayName: 'Lead reviewer' } }, teammates: [{ config: { displayName: 'Tester' } }] } as TeamDefinition;
function props(overrides: Partial<ComposerV2Props> = {}): ComposerV2Props {
  return { onInputChange: vi.fn(), renderInputWithMentions: () => null, input: '', placeholder: '', textareaRef: { current: null }, inputHighlightRef: { current: null },
    attachedImages: [], documentReferences: [], uploadingImages: new Map(), imageErrors: new Map(), filteredFiles: [], selectedFileMentions: [], selectedSkills: [], selectedCommands: [], filteredCommands: [], frequentCommands: [], pendingPermissionRequests: [],
    getRootProps: () => ({}), getInputProps: () => ({}), modelCatalog: [], modelSelection: null, teamCatalog: [team], projectKey: '', onTeamSelectionChange: vi.fn(), onModelSelectionChange: vi.fn(), permissionMode: 'default', runMode: 'agent', ...overrides } as unknown as ComposerV2Props;
}
afterEach(cleanup);
describe('Composer Team selector', () => {
  it('opens Teams even when no models are configured and selects by display name', () => {
    const select = vi.fn();
    render(<ComposerV2 {...props({ onTeamSelectionChange: select })}/>);
    fireEvent.click(screen.getByTitle('Select model or Team'));
    expect(screen.getByRole('group', { name: 'Teams' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Release review/ }));
    expect(select).toHaveBeenCalledWith(team);
  });
  it('shows the selected Team and locks mode changes while busy', () => {
    render(<ComposerV2 {...props({ selectedTeam: team, executionSelectionLocked: true })}/>);
    expect(screen.getByTitle('Select model or Team').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Release review')).toBeTruthy();
  });
  it('searches model and Team names in the same menu', () => {
    render(<ComposerV2 {...props()}/>);
    fireEvent.click(screen.getByTitle('Select model or Team'));
    fireEvent.change(screen.getByPlaceholderText('Search models and Teams'), { target: { value: 'missing' } });
    expect(screen.queryByRole('button', { name: /Release review/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search models and Teams'), { target: { value: 'tester' } });
    expect(screen.getByRole('button', { name: /Release review/ })).toBeTruthy();
  });
});
