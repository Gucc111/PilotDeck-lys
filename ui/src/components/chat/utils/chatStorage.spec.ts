import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PILOTDECK_SETTINGS_KEY,
  getDraftInputStorageKey,
  getPilotDeckSettings,
} from './chatStorage';

let storage = new Map<string, string>();

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getDraftInputStorageKey', () => {
  it('scopes drafts to a project and conversation', () => {
    expect(getDraftInputStorageKey('general', 'session-a'))
      .toBe('draft_input_general:session-a');
    expect(getDraftInputStorageKey('general', 'session-b'))
      .toBe('draft_input_general:session-b');
  });

  it('uses a separate key for a new conversation', () => {
    expect(getDraftInputStorageKey('general', null))
      .toBe('draft_input_general:new');
  });
});

describe('getPilotDeckSettings', () => {
  it('migrates V1 localStorage to one V2 rules representation', () => {
    localStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify({
      allowedTools: ['Bash(git status:*)'],
      disallowedTools: ['write_file:/tmp/protected/*'],
      skipPermissions: true,
      projectSortOrder: 'recent',
    }));

    const settings = getPilotDeckSettings();

    expect(settings.version).toBe(2);
    expect(settings.rules).toHaveLength(2);
    expect(settings.rules[0].selector?.conditions).toEqual([
      { subject: 'bash.command', operator: 'executableEquals', value: 'git' },
      { subject: 'bash.command', operator: 'argvPrefix', value: ['git', 'status'] },
    ]);
    expect(settings.projectSortOrder).toBe('recent');
    expect(settings).not.toHaveProperty('allowedTools');
    expect(settings).not.toHaveProperty('disallowedTools');
  });
});
