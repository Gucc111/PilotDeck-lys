import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Shield, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  PermissionRule,
  PermissionRuleBehavior,
  ToolCallSelector,
} from '../../../../../../src/permission/protocol/types';
import {
  normalizePermissionSettings,
  permissionRuleKey,
} from '../../../../../../src/permission/settingsSchema';
import { Button } from '../../../../shared/view/ui';
import {
  PILOTDECK_SETTINGS_KEY,
  fetchPilotDeckPermissionSettings,
  getPilotDeckSettings,
  safeLocalStorage,
  savePilotDeckPermissionSettings,
} from '../../../chat/utils/chatStorage';
import type { PilotDeckSettings } from '../../../chat/types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { ToolCallSelectorBuilder } from '../ToolCallSelectorBuilder';
import {
  TOOL_SELECTOR_DESCRIPTORS,
  toolCallSelectorSummary,
} from '../toolCallSelectorMetadata';

type RuleEffect = PermissionRuleBehavior;

function persist(updates: Partial<PilotDeckSettings>) {
  const current = getPilotDeckSettings();
  const next: PilotDeckSettings = {
    ...current,
    ...updates,
    version: 2,
    lastUpdated: new Date().toISOString(),
  };
  safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event('pilotdeck-settings-changed'));
  savePilotDeckPermissionSettings(updates).catch((error) => {
    console.error('Failed to persist permission settings to backend:', error);
  });
  return next;
}

function mergeRules(current: PermissionRule[], imported: PermissionRule[]): PermissionRule[] {
  const seen = new Set(current.map(permissionRuleKey));
  const next = [...current];
  for (const rule of imported) {
    const key = permissionRuleKey(rule);
    if (!seen.has(key)) {
      seen.add(key);
      next.push(rule);
    }
  }
  return next;
}

function ruleSummary(rule: PermissionRule): string {
  if (!rule.selector) {
    return rule.pattern ? `${rule.toolName}: ${rule.pattern}` : rule.toolName;
  }
  return toolCallSelectorSummary(rule.selector);
}

function downloadJson(payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `pilotdeck-permissions-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function PermissionsSettingsTab() {
  const { t } = useTranslation('settings');
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const applySettings = useCallback((settings: PilotDeckSettings) => {
    setRules(settings.rules);
    setSkipPermissions(settings.skipPermissions);
  }, []);

  const reload = useCallback(() => applySettings(getPilotDeckSettings()), [applySettings]);

  useEffect(() => {
    reload();
    fetchPilotDeckPermissionSettings()
      .then((settings) => {
        safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(settings));
        applySettings(settings);
      })
      .catch((error) => {
        console.error('Failed to load permission settings from backend:', error);
      });
    const onStorage = (event: StorageEvent) => {
      if (event.key === PILOTDECK_SETTINGS_KEY) reload();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pilotdeck-settings-changed', reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pilotdeck-settings-changed', reload);
    };
  }, [applySettings, reload]);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const handleAddRule = (effect: string, selector: ToolCallSelector) => {
    const rule: PermissionRule = {
      source: 'user',
      behavior: effect as RuleEffect,
      toolName: selector.toolName,
      selector,
    };
    const next = mergeRules(rules, [rule]);
    setRules(next);
    persist({ rules: next });
  };

  const handleDeleteRule = (index: number) => {
    const next = rules.filter((_, ruleIndex) => ruleIndex !== index);
    setRules(next);
    persist({ rules: next });
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const normalized = normalizePermissionSettings(parsed);
      const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
      const recognized = Array.isArray(record.rules)
        || Array.isArray(record.allowedTools)
        || Array.isArray(record.disallowedTools)
        || typeof record.skipPermissions === 'boolean';
      if (!recognized) throw new Error('Unrecognized permission settings');
      const nextRules = mergeRules(rules, normalized.rules);
      const nextSkip = typeof record.skipPermissions === 'boolean'
        ? normalized.skipPermissions
        : skipPermissions;
      setRules(nextRules);
      setSkipPermissions(nextSkip);
      persist({ rules: nextRules, skipPermissions: nextSkip });
      setBanner({
        kind: 'success',
        message: t('permissions.importSuccess', {
          added: nextRules.length - rules.length,
          defaultValue: 'Imported {{added}} new rules.',
        }),
      });
    } catch (error) {
      console.error('Failed to import permissions:', error);
      setBanner({
        kind: 'error',
        message: t('permissions.importInvalid', {
          defaultValue: 'Choose a valid V1 or V2 permissions JSON file.',
        }),
      });
    }
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('permissions.title')}
        description={t('permissions.description')}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImport}
        />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => {
              downloadJson({
                version: 2,
                source: 'pilotdeck',
                exportedAt: new Date().toISOString(),
                rules,
                skipPermissions,
              });
              setBanner({
                kind: 'success',
                message: t('permissions.exportSuccess', {
                  count: rules.length,
                  defaultValue: 'Exported {{count}} rules.',
                }),
              });
            }}
          >
            <Download className="h-3.5 w-3.5" />
            {t('permissions.export')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" />
            {t('permissions.import')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('permissions.importExportHint')}
          </span>
        </div>

        {banner ? (
          <div
            role="status"
            className={banner.kind === 'success'
              ? 'mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-200'
              : 'mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200'}
          >
            {banner.message}
          </div>
        ) : null}

        <SettingsCard divided>
          <SettingsRow
            label={
              <span className="inline-flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                {t('permissions.skipPermissions.title')}
              </span>
            }
            description={t('permissions.skipPermissions.description')}
          >
            <SettingsToggle
              checked={skipPermissions}
              ariaLabel={t('permissions.skipPermissions.title')}
              onChange={(next) => {
                setSkipPermissions(next);
                persist({ skipPermissions: next });
              }}
            />
          </SettingsRow>
          {skipPermissions ? (
            <div className="border-t border-border px-4 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {t('permissions.skipPermissions.warning')}
            </div>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={
          <span className="inline-flex items-center gap-2">
            <Shield className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            {t('permissions.builder.title', { defaultValue: 'Add rule' })}
          </span>
        }
        description={t('permissions.builder.description', {
          defaultValue: 'Build a scoped tool rule. Leave Subject as Entire tool for an unscoped rule.',
        })}
      >
        <SettingsCard className="space-y-3 p-4">
          <ToolCallSelectorBuilder
            availableTools={TOOL_SELECTOR_DESCRIPTORS.map((tool) => tool.name)}
            effects={[
              { value: 'allow', label: t('permissions.effects.allow') },
              { value: 'ask', label: t('permissions.effects.ask') },
              { value: 'deny', label: t('permissions.effects.deny') },
            ]}
            allowEntireTool
            labels={{
              effect: t('permissions.builder.effect'),
              tool: t('permissions.builder.tool'),
              subject: t('permissions.builder.subject'),
              entireTool: t('permissions.builder.entireTool'),
              operator: t('permissions.builder.operator'),
              add: t('permissions.actions.add'),
              emptyTools: t('permissions.builder.emptyTools', {
                defaultValue: 'No supported tools are available.',
              }),
              pathPlaceholder: t('permissions.builder.pathPlaceholder'),
              argvPlaceholder: t('permissions.builder.argvPlaceholder'),
              executablePlaceholder: t('permissions.builder.executablePlaceholder'),
              workspaceHint: t('permissions.builder.workspaceHint'),
              commandHint: t('permissions.builder.commandHint'),
              operatorLabel: (operator) => t(`permissions.operators.${operator}`),
            }}
            onAdd={handleAddRule}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('permissions.rules.title', { defaultValue: 'Rules' })}
        description={t('permissions.rules.description', {
          defaultValue: 'Structured and migrated legacy rules are evaluated by the same runtime.',
        })}
      >
        <SettingsCard className="space-y-2 p-3">
          {rules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
              {t('permissions.rules.empty', { defaultValue: 'No permission rules configured.' })}
            </div>
          ) : rules.map((rule, index) => (
            <div
              key={`${permissionRuleKey(rule)}-${index}`}
              className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${
                    rule.behavior === 'allow'
                      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
                      : rule.behavior === 'deny'
                        ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                  }`}
                  >
                    {t(`permissions.effects.${rule.behavior}`, {
                      defaultValue: rule.behavior === 'deny' ? 'Block' : rule.behavior,
                    })}
                  </span>
                  {!rule.selector ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {t('permissions.rules.legacy', { defaultValue: 'Legacy' })}
                    </span>
                  ) : null}
                  <code className="font-mono text-xs font-semibold">{rule.toolName}</code>
                </div>
                <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                  {ruleSummary(rule)}
                </code>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-red-600"
                aria-label={t('permissions.actions.remove')}
                onClick={() => handleDeleteRule(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
