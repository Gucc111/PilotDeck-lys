import type { PilotDeckSettings } from '../types/types';
import { authenticatedFetch } from '../../../utils/api.js';
import { normalizePermissionSettings } from '../../../../../src/permission/settingsSchema';

export const PILOTDECK_SETTINGS_KEY = 'pilotdeck-settings';

export const getDraftInputStorageKey = (
  projectName: string,
  sessionId?: string | null,
): string => `draft_input_${projectName}:${sessionId || 'new'}`;

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

// When localStorage has no cached permission settings, fall back to the
// conservative default (false). The authoritative value lives on disk
// (~/.pilotdeck/permissions.json) and is synced to localStorage when the
// Settings page loads or after a save round-trip. This avoids the old
// problem where a browser cache clear silently re-enabled bypass mode.

export function getPilotDeckSettings(): PilotDeckSettings {
  const raw = safeLocalStorage.getItem(PILOTDECK_SETTINGS_KEY);
  if (!raw) {
    return {
      version: 2,
      rules: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }

  try {
    return normalizePilotDeckSettings(JSON.parse(raw), false);
  } catch {
    return {
      version: 2,
      rules: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }
}

export async function fetchPilotDeckPermissionSettings(): Promise<PilotDeckSettings> {
  const response = await authenticatedFetch('/api/settings/permissions');
  if (!response.ok) {
    throw new Error(`Failed to fetch permission settings: HTTP ${response.status}`);
  }
  const data = await response.json();
  return mergePermissionSettings(data.permissions);
}

export async function savePilotDeckPermissionSettings(
  updates: Partial<PilotDeckSettings>,
): Promise<PilotDeckSettings> {
  const response = await authenticatedFetch('/api/settings/permissions', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    throw new Error(`Failed to save permission settings: HTTP ${response.status}`);
  }
  const data = await response.json();
  const next = mergePermissionSettings(data.permissions);
  safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify({
    ...getPilotDeckSettings(),
    ...next,
  }));
  window.dispatchEvent(new Event('pilotdeck-settings-changed'));
  return next;
}

function mergePermissionSettings(value: unknown): PilotDeckSettings {
  const current = getPilotDeckSettings();
  const permissions = normalizePilotDeckSettings(value, current.skipPermissions);
  const mergedRules = permissions.rules.length > 0
    ? permissions.rules
    : current.rules;
  return {
    ...current,
    ...permissions,
    rules: mergedRules,
    projectSortOrder: current.projectSortOrder || 'name',
  };
}

export function normalizePilotDeckSettings(
  value: unknown,
  defaultSkipPermissions = false,
): PilotDeckSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const { allowedTools: _allowedTools, disallowedTools: _disallowedTools, ...rest } = record;
  const permissions = normalizePermissionSettings({
    ...record,
    skipPermissions: typeof record.skipPermissions === 'boolean'
      ? record.skipPermissions
      : defaultSkipPermissions,
  });
  return {
    ...rest,
    ...permissions,
    projectSortOrder: typeof record.projectSortOrder === 'string' && record.projectSortOrder
      ? record.projectSortOrder
      : 'name',
  };
}
