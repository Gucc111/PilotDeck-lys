import { describe, expect, it } from 'vitest';
import * as runtimeSettings from '../../../src/permission/settings.ts';
import * as serverSettings from './permissionSettings.js';

describe('permission settings server parity', () => {
  it('re-exports the runtime implementation instead of mirroring its parser', () => {
    expect(serverSettings.normalizePermissionSettings)
      .toBe(runtimeSettings.normalizePermissionSettings);
    expect(serverSettings.readPermissionSettings)
      .toBe(runtimeSettings.readPermissionSettings);
    expect(serverSettings.writePermissionSettings)
      .toBe(runtimeSettings.writePermissionSettings);
  });

  it('accepts V2 structured rules through the server surface', () => {
    const normalized = serverSettings.normalizePermissionSettings({
      version: 2,
      rules: [{
        source: 'user',
        behavior: 'ask',
        toolName: 'bash',
        selector: {
          version: 2,
          toolName: 'bash',
          conditions: [{
            subject: 'bash.command',
            operator: 'executableEquals',
            value: 'npm',
          }],
        },
      }],
      skipPermissions: false,
    });

    expect(normalized.version).toBe(2);
    expect(normalized.rules[0].behavior).toBe('ask');
  });
});
