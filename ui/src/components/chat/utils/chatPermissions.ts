import { safeJsonParse } from '../../../lib/utils.js';
import type { ChatMessage, PilotDeckPermissionSuggestion, PermissionGrantResult } from '../types/types.js';
import type { PermissionRule, ToolCallCondition } from '../../../../../src/permission/protocol/types';
import {
  normalizeToolName,
  permissionRuleKey,
  serializePermissionRule,
} from '../../../../../src/permission/settingsSchema';
import {
  PILOTDECK_SETTINGS_KEY,
  getPilotDeckSettings,
  safeLocalStorage,
  savePilotDeckPermissionSettings,
} from './chatStorage';

export function buildPilotDeckToolPermissionRule(
  toolName?: string,
  toolInput?: unknown,
): PermissionRule | null {
  if (!toolName) return null;
  const fileWriteToolName = normalizeFileWriteToolName(toolName);
  if (fileWriteToolName) return buildFileWritePermissionRule(fileWriteToolName, toolInput);
  const canonicalToolName = normalizeToolName(toolName);
  if (canonicalToolName !== 'bash') {
    return {
      source: 'user',
      behavior: 'allow',
      toolName: canonicalToolName,
      selector: { version: 2, toolName: canonicalToolName },
    };
  }

  const parsed = parseToolInputRecord(toolInput);
  const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  if (!command || /[;&|`$(){}[\]<>\\'"\n]/.test(command)) return null;
  const tokens = command.split(/\s+/);
  if (!tokens.every((token) => /^[A-Za-z0-9_./@+=,%~-]+$/.test(token))) return null;
  const conditions: ToolCallCondition[] = [{
    subject: 'bash.command',
    operator: 'executableEquals',
    value: tokens[0],
  }];
  if (tokens[1]) {
    conditions.push({
      subject: 'bash.command',
      operator: 'argvPrefix',
      value: [tokens[0], tokens[1]],
    });
  }
  return {
    source: 'user',
    behavior: 'allow',
    toolName: 'bash',
    selector: { version: 2, toolName: 'bash', conditions },
  };
}

function normalizeFileWriteToolName(toolName: string) {
  if (toolName === 'write_file' || toolName === 'Write') return 'write_file';
  if (toolName === 'edit_file' || toolName === 'Edit') return 'edit_file';
  return null;
}

function buildFileWritePermissionRule(
  toolName: 'write_file' | 'edit_file',
  toolInput: unknown,
): PermissionRule | null {
  const parsed = parseToolInputRecord(toolInput);
  const filePath = typeof parsed?.file_path === 'string' ? parsed.file_path.trim() : '';
  if (!isAbsoluteFilePath(filePath)) return null;
  const parent = dirnameForPermission(filePath);
  if (!parent) return null;
  return {
    source: 'user',
    behavior: 'allow',
    toolName,
    selector: {
      version: 2,
      toolName,
      conditions: [{
        subject: `${toolName}.file_path`,
        operator: 'pathWithin',
        value: parent,
      }],
    },
  };
}

export function formatPermissionRuleSummary(rule: PermissionRule): string {
  const condition = rule.selector?.conditions?.[0];
  if (!condition) return rule.pattern ? `${rule.toolName}: ${rule.pattern}` : rule.toolName;
  if (condition.subject === 'bash.command') {
    const executable = rule.selector?.conditions?.find((item) => item.operator === 'executableEquals');
    const argv = rule.selector?.conditions?.find((item) => item.operator === 'argvPrefix');
    const executableValue = typeof executable?.value === 'string' ? executable.value : rule.toolName;
    const invocation = Array.isArray(argv?.value) ? argv.value.join(' ') : executableValue;
    return `${rule.toolName}: ${invocation}`;
  }
  return `${rule.toolName}: ${String(condition.value)}`;
}

function parseToolInputRecord(toolInput: unknown): Record<string, unknown> | null {
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    return toolInput as Record<string, unknown>;
  }
  return safeJsonParse(toolInput);
}

function isAbsoluteFilePath(filePath: string) {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
}

function dirnameForPermission(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(normalized);
  const value = driveMatch ? `${driveMatch[1]}${driveMatch[2] ?? '/'}` : normalized;
  const index = value.lastIndexOf('/');
  if (index < 0) return '';
  if (index === 0) return '/';
  if (/^[A-Za-z]:\/[^/]*$/.test(value)) return `${value.slice(0, 2)}/`;
  return value.slice(0, index);
}

export function formatToolInputForDisplay(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// Backend `PilotDeckToolErrorCode` values that map to "user can fix this by
// granting a permission rule". Anything else (e.g. `tool_execution_failed`,
// `file_not_found`, `tool_timeout`) is a real failure unrelated to ACL state,
// and surfacing the "Add to Allowed Tools" CTA for those cases is actively
// misleading — clicking it adds the rule, but the next retry still fails
// because the original error was not about permissions.
const PERMISSION_ERROR_CODES = new Set<string>([
  'permission_denied',
  'permission_required',
  'permission_cancelled',
]);

export function isReadOnlyModeToolDeny(message: ChatMessage | null | undefined): boolean {
  if (!message?.toolResult?.isError) return false;
  const errorCode = typeof message.toolResult.errorCode === 'string'
    ? message.toolResult.errorCode
    : '';
  if (
    errorCode === 'plan_mode_violation' ||
    errorCode === 'plan_mode_denied' ||
    errorCode === 'ask_mode_violation' ||
    errorCode === 'ask_mode_denied'
  ) {
    return true;
  }
  const content = typeof message.toolResult.content === 'string'
    ? message.toolResult.content
    : '';
  return (
    /\[PLAN_MODE_VIOLATION\]/i.test(content) ||
    /plan mode denies side-effecting tool\b/i.test(content) ||
    /\[ASK_MODE_VIOLATION\]/i.test(content) ||
    /ask mode denies side-effecting tool\b/i.test(content)
  );
}

export const isPlanModeToolDeny = isReadOnlyModeToolDeny;

export function getPilotDeckPermissionSuggestion(
  message: ChatMessage | null | undefined,
  _provider: string,
): PilotDeckPermissionSuggestion | null {
  // migration every provider routes tool calls through the same gateway
  // PermissionContext, so the "Permission added" affordance is useful
  // regardless of which model is selected.
  if (!message?.toolResult?.isError) return null;
  if (isReadOnlyModeToolDeny(message)) return null;

  // Only offer the rule-grant affordance for genuine permission failures.
  // For historical / replayed messages without an `errorCode` we fall back to
  // the legacy behaviour (showing the suggestion) so users on older
  // transcripts still see it.
  const errorCode = message.toolResult.errorCode;
  if (errorCode && !PERMISSION_ERROR_CODES.has(errorCode)) return null;

  const toolName = message?.toolName;
  const rule = buildPilotDeckToolPermissionRule(toolName, message.toolInput);
  if (!rule) return null;
  const entry = serializePermissionRule(rule);

  const settings = getPilotDeckSettings();
  const isAllowed = settings.rules.some((candidate) =>
    candidate.behavior === 'allow' && permissionRuleKey(candidate) === permissionRuleKey(rule));
  return {
    toolName: toolName || 'UnknownTool',
    rule,
    entry,
    summary: formatPermissionRuleSummary(rule),
    isAllowed,
  };
}

export function grantPilotDeckToolPermission(rule: PermissionRule | null): PermissionGrantResult {
  if (!rule) return { success: false };

  const settings = getPilotDeckSettings();
  const allowKey = permissionRuleKey({ ...rule, behavior: 'allow' });
  const alreadyAllowed = settings.rules.some((candidate) =>
    candidate.behavior === 'allow' && permissionRuleKey(candidate) === allowKey);
  const nextRules = settings.rules.filter((candidate) =>
    candidate.behavior !== 'deny'
    || permissionRuleKey({ ...candidate, behavior: 'allow' }) !== allowKey);
  if (!alreadyAllowed) {
    nextRules.push({ ...rule, source: 'user', behavior: 'allow' });
  }
  const updatedSettings = {
    ...settings,
    rules: nextRules,
    lastUpdated: new Date().toISOString(),
  };

  safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(updatedSettings));
  savePilotDeckPermissionSettings({
    rules: nextRules,
  }).catch((error) => {
    console.error('Failed to persist granted permission to backend:', error);
  });
  return { success: true, alreadyAllowed, updatedSettings };
}
