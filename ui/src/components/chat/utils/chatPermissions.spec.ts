import { describe, expect, it } from 'vitest';
import {
  buildPilotDeckToolPermissionRule,
  formatPermissionRuleSummary,
} from './chatPermissions';

describe('structured permission suggestions', () => {
  it('scopes bash suggestions by executable and first argv item', () => {
    const rule = buildPilotDeckToolPermissionRule('Bash', {
      command: 'git status --short',
    });

    expect(rule?.selector?.conditions).toEqual([
      { subject: 'bash.command', operator: 'executableEquals', value: 'git' },
      { subject: 'bash.command', operator: 'argvPrefix', value: ['git', 'status'] },
    ]);
    expect(rule && formatPermissionRuleSummary(rule)).toBe('bash: git status');
  });

  it('rejects ambiguous compound shell commands instead of broadening access', () => {
    expect(buildPilotDeckToolPermissionRule('bash', {
      command: 'git status && npm test',
    })).toBeNull();
  });

  it('creates pathWithin rules for file-write suggestions', () => {
    const rule = buildPilotDeckToolPermissionRule('write_file', {
      file_path: '/workspace/src/index.ts',
    });

    expect(rule?.selector?.conditions).toEqual([{
      subject: 'write_file.file_path',
      operator: 'pathWithin',
      value: '/workspace/src',
    }]);
  });
});
