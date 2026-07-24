// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getThinkingModeAvailability } from '../chat/constants/thinkingModeAvailability';
import ComposerV2, { type ComposerV2Props } from './ComposerV2';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'input.permissions.teamDefault': 'Team Permissions',
        'input.permissions.teamDefaultDescription': 'Ask before risky Teammate execution',
        'input.permissions.teamBypassPermissions': 'Full Team Access',
        'input.permissions.teamBypassPermissionsDescription': 'Let Teammates execute without confirmations',
        'input.permissions.teamChange': 'Select Teammate execution permissions',
      };
      return translations[key] ?? String(options?.defaultValue ?? key);
    },
  }),
}));

afterEach(cleanup);

function makeProps(runMode: ComposerV2Props['runMode']): ComposerV2Props {
  return {
    input: '',
    placeholder: 'Type a message',
    textareaRef: createRef<HTMLTextAreaElement>(),
    inputHighlightRef: createRef<HTMLDivElement>(),
    renderInputWithMentions: (text) => text,
    onInputChange: vi.fn(),
    onTextareaClick: vi.fn(),
    onTextareaKeyDown: vi.fn(),
    onTextareaPaste: vi.fn(),
    onTextareaScrollSync: vi.fn(),
    onTextareaInput: vi.fn(),
    onSubmit: vi.fn(),
    onAbortSession: vi.fn(),
    openImagePicker: vi.fn(),
    attachedImages: [],
    onRemoveImage: vi.fn(),
    documentReferences: [],
    onRemoveDocumentReference: vi.fn(),
    uploadingImages: new Map(),
    imageErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile: vi.fn(),
    filteredCommands: [],
    selectedCommandIndex: 0,
    onCommandSelect: vi.fn(),
    onCloseCommandMenu: vi.fn(),
    isCommandMenuOpen: false,
    frequentCommands: [],
    onToggleCommandMenu: vi.fn(),
    onInsertMention: vi.fn(),
    onInsertSlash: vi.fn(),
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    isLoading: false,
    canAbortSession: false,
    thinkingMode: 'default',
    thinkingModeAvailability: getThinkingModeAvailability({}),
    onThinkingModeChange: vi.fn(),
    pendingPermissionRequests: [],
    handlePermissionDecision: vi.fn(),
    handleGrantToolPermission: vi.fn(() => ({ success: true })),
    permissionMode: 'default',
    onPermissionModeChange: vi.fn(),
    runMode,
    onRunModeChange: vi.fn(),
  };
}

describe('ComposerV2 permission labels', () => {
  it('uses Team execution permission copy in Team mode', () => {
    render(<ComposerV2 {...makeProps('team')} />);

    const selector = screen.getByTitle('Select Teammate execution permissions');
    expect(selector.textContent).toContain('Team Permissions');
    fireEvent.click(selector);

    expect(screen.getByText('Ask before risky Teammate execution')).toBeTruthy();
    expect(screen.getByText('Full Team Access')).toBeTruthy();
    expect(screen.getByText('Let Teammates execute without confirmations')).toBeTruthy();
  });

  it('keeps the existing permission copy outside Team mode', () => {
    render(<ComposerV2 {...makeProps('agent')} />);

    const selector = screen.getByTitle('Select permission mode');
    expect(selector.textContent).toContain('Default Permissions');
    expect(screen.queryByText('Team Permissions')).toBeNull();
  });
});
