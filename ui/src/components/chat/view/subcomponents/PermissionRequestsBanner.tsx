import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingPermissionRequest, PilotDeckPermissionSuggestion } from '../../types/types';
import {
  buildPilotDeckToolPermissionRule,
  formatPermissionRuleSummary,
  formatToolInputForDisplay,
} from '../../utils/chatPermissions';
import { getPilotDeckSettings } from '../../utils/chatStorage';
import { permissionRuleKey, serializePermissionRule } from '../../../../../../src/permission/settingsSchema';
import { getPermissionPanel, registerPermissionPanel } from '../../tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel, ExitPlanModePanel } from '../../tools/components/InteractiveRenderers';

registerPermissionPanel('AskUserQuestion', AskUserQuestionPanel);
registerPermissionPanel('ask_user_question', AskUserQuestionPanel);
registerPermissionPanel('ExitPlanMode', ExitPlanModePanel);
registerPermissionPanel('exit_plan_mode', ExitPlanModePanel);
registerPermissionPanel('ExitPlanModeV2', ExitPlanModePanel);

interface PermissionRequestsBannerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: PilotDeckPermissionSuggestion) => { success: boolean };
  onPlanExecutionApproved?: () => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getPermissionRequestTeammateId(request: PendingPermissionRequest): string | null {
  const input = asRecord(request.input);
  const context = asRecord(request.context);
  const candidates = [
    request.metadata,
    context,
    asRecord(context?.metadata),
    input,
    asRecord(input?.metadata),
  ];
  for (const candidate of candidates) {
    const teammateId = candidate?.teammateId;
    if (typeof teammateId === 'string' && teammateId.trim()) {
      return teammateId;
    }
  }
  return null;
}

export default function PermissionRequestsBanner({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  onPlanExecutionApproved,
}: PermissionRequestsBannerProps) {
  const { t } = useTranslation('chat');

  if (!pendingPermissionRequests.length) {
    return null;
  }

  const customPanelRequests: PendingPermissionRequest[] = [];
  const grouped = new Map<string, PendingPermissionRequest[]>();

  for (const request of pendingPermissionRequests) {
    if (getPermissionPanel(request.toolName)) {
      customPanelRequests.push(request);
      continue;
    }
    const rawInput = formatToolInputForDisplay(request.input);
    const rule = buildPilotDeckToolPermissionRule(request.toolName, rawInput);
    const entry = rule ? serializePermissionRule(rule) : request.requestId;
    const groupKey = `${entry}\u0000${getPermissionRequestTeammateId(request) ?? ''}`;
    const group = grouped.get(groupKey);
    if (group) {
      group.push(request);
    } else {
      grouped.set(groupKey, [request]);
    }
  }

  return (
    <div className="mb-3 space-y-2">
      {customPanelRequests.map((request) => {
        const CustomPanel = getPermissionPanel(request.toolName)!;
        const teammateId = getPermissionRequestTeammateId(request);
        return (
          <div key={request.requestId} className="space-y-1.5">
            {teammateId ? (
              <div className="px-1 text-xs font-medium text-blue-700 dark:text-blue-300">
                {t('permissionBanner.fromTeammate', { id: teammateId })}
              </div>
            ) : null}
            <CustomPanel
              request={request}
              onDecision={handlePermissionDecision}
              onPlanExecutionApproved={onPlanExecutionApproved}
            />
          </div>
        );
      })}

      {Array.from(grouped.entries()).map(([groupKey, requests]) => {
        const first = requests[0];
        const teammateId = getPermissionRequestTeammateId(first);
        const allIds = requests.map((r) => r.requestId);
        const rawInput = formatToolInputForDisplay(first.input);
        const permissionRule = buildPilotDeckToolPermissionRule(first.toolName, rawInput);
        const permissionEntry = permissionRule ? serializePermissionRule(permissionRule) : null;
        const permissionSummary = permissionRule ? formatPermissionRuleSummary(permissionRule) : null;
        const settings = getPilotDeckSettings();
        const alreadyAllowed = permissionRule
          ? settings.rules.some((candidate) =>
              candidate.behavior === 'allow'
              && permissionRuleKey(candidate) === permissionRuleKey(permissionRule))
          : false;
        const rememberLabel = alreadyAllowed ? t('permissionBanner.allowSaved') : t('permissionBanner.allowRemember');

        return (
          <div
            key={groupKey}
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 shadow-sm dark:border-amber-800 dark:bg-amber-900/20"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  {requests.length > 1
                    ? t('permissionBanner.titleCount', { count: requests.length })
                    : t('permissionBanner.title')}
                </div>
                <div className="text-xs text-amber-800 dark:text-amber-200">
                  {t('permissionBanner.tool')} <span className="font-mono">{first.toolName}</span>
                </div>
                {teammateId ? (
                  <div className="mt-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                    {t('permissionBanner.fromTeammate', { id: teammateId })}
                  </div>
                ) : null}
              </div>
              {permissionEntry && (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  {t('permissionBanner.allowRule')} <span className="font-mono">{permissionSummary}</span>
                </div>
              )}
            </div>

            {requests.length <= 1 && rawInput && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100">
                  {t('permissionBanner.viewToolInput')}
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-amber-200/60 bg-white/80 p-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-gray-900/60 dark:text-amber-100">
                  {rawInput}
                </pre>
              </details>
            )}

            {requests.length > 1 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100">
                  {t('permissionBanner.viewToolInputs', { count: requests.length })}
                </summary>
                <div className="mt-2 space-y-1">
                  {requests.map((r) => {
                    const inp = formatToolInputForDisplay(r.input);
                    return inp ? (
                      <pre key={r.requestId} className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md border border-amber-200/60 bg-white/80 p-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-gray-900/60 dark:text-amber-100">
                        {inp}
                      </pre>
                    ) : null;
                  })}
                </div>
              </details>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handlePermissionDecision(allIds, { allow: true })}
                className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700"
              >
                {t('permissionBanner.allowOnce')}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (permissionRule && permissionEntry && !alreadyAllowed) {
                    handleGrantToolPermission({
                      entry: permissionEntry,
                      rule: permissionRule,
                      summary: permissionSummary ?? first.toolName,
                      toolName: first.toolName,
                      isAllowed: false,
                    });
                  }
                  handlePermissionDecision(allIds, { allow: true, rememberEntry: permissionEntry });
                }}
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  permissionEntry
                    ? 'border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/30'
                    : 'cursor-not-allowed border-gray-300 text-gray-400'
                }`}
                disabled={!permissionEntry}
              >
                {rememberLabel}
              </button>
              <button
                type="button"
                onClick={() => handlePermissionDecision(allIds, { allow: false, message: 'User denied tool use' })}
                className="inline-flex items-center gap-2 rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/30"
              >
                {t('permissionBanner.deny')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
