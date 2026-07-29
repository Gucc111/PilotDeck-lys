import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ToolCallSelector } from '../../../../../../src/permission/protocol/types';
import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type {
  TeammateRecord,
  TeammateWorkspaceBinding,
} from '../../types/types';
import { ToolCallSelectorBuilder } from '../ToolCallSelectorBuilder';
import { toolCallSelectorSummary } from '../toolCallSelectorMetadata';

const INHERIT_BINDING: TeammateWorkspaceBinding = {
  enabled: false,
  toolProfile: { mode: 'inherit' },
  contextPolicy: 'persistent',
};

export default function WorkspaceBindingEditor({
  teammate,
  binding: rawBinding,
  catalogTools,
  saving,
  disabled,
  onChange,
}: {
  teammate: TeammateRecord;
  binding: TeammateWorkspaceBinding | undefined;
  catalogTools: string[];
  saving: boolean;
  disabled: boolean;
  onChange: (binding: TeammateWorkspaceBinding) => void;
}) {
  const { t } = useTranslation('settings');
  const [constraintsOpen, setConstraintsOpen] = useState(false);

  const binding = rawBinding ?? INHERIT_BINDING;
  const custom = binding.toolProfile.mode === 'custom' ? binding.toolProfile : null;
  const catalogToolSet = new Set(catalogTools);
  const effectiveTools = (custom?.tools ?? teammate.tools)
    .filter((tool) => catalogToolSet.has(tool));
  const constraintCount =
    (custom?.constraints.allow.length ?? 0) + (custom?.constraints.deny.length ?? 0);

  const save = (nextBinding: TeammateWorkspaceBinding) => onChange(nextBinding);
  const makeCustom = (tools = teammate.tools.filter((tool) => catalogToolSet.has(tool))) => ({
    enabled: binding.enabled,
    contextPolicy: binding.contextPolicy,
    toolProfile: {
      mode: 'custom' as const,
      tools,
      constraints: custom?.constraints ?? { allow: [], deny: [] },
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              custom
                ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
                : 'bg-muted text-muted-foreground',
            )}
            >
              {custom
                ? t('teammates.bindings.customStatus')
                : t('teammates.bindings.inheritedStatus')}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t('teammates.bindings.effectiveTools', { count: effectiveTools.length })}
            </span>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium text-foreground">
          <input
            type="checkbox"
            checked={binding.enabled}
            onChange={(event) => save({ ...binding, enabled: event.target.checked })}
            disabled={disabled}
            aria-label={t('teammates.enablement.toggleLabel', { name: teammate.name })}
            className="h-4 w-4 rounded border-border accent-primary disabled:cursor-not-allowed disabled:opacity-60"
          />
          {t('teammates.enablement.rowLabel')}
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
          <input
            type="radio"
            name={`profile-${teammate.id}`}
            checked={!custom}
            onChange={() => save({
              enabled: binding.enabled,
              contextPolicy: binding.contextPolicy,
              toolProfile: { mode: 'inherit' },
            })}
            disabled={disabled}
          />
          {t('teammates.bindings.inherit')}
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
          <input
            type="radio"
            name={`profile-${teammate.id}`}
            checked={Boolean(custom)}
            onChange={() => save(makeCustom())}
            disabled={disabled}
          />
          {t('teammates.bindings.custom')}
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !custom}
          onClick={() => save(makeCustom(
            teammate.tools.filter((tool) => catalogToolSet.has(tool)),
          ))}
        >
          <Copy className="h-3.5 w-3.5" />
          {t('teammates.bindings.copyDefaults')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || !custom}
          onClick={() => save({
            enabled: binding.enabled,
            contextPolicy: binding.contextPolicy,
            toolProfile: { mode: 'inherit' },
          })}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('teammates.bindings.resetDefault')}
        </Button>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <div>
          <div className="text-xs font-semibold text-foreground">
            {t('teammates.bindings.contextTitle')}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t('teammates.bindings.contextDescription')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
            <input
              type="radio"
              name={`context-${teammate.id}`}
              checked={binding.contextPolicy === 'persistent'}
              onChange={() => save({ ...binding, contextPolicy: 'persistent' })}
              disabled={disabled}
            />
            {t('teammates.bindings.contextPersistent')}
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
            <input
              type="radio"
              name={`context-${teammate.id}`}
              checked={binding.contextPolicy === 'fresh_per_delegation'}
              onChange={() => save({ ...binding, contextPolicy: 'fresh_per_delegation' })}
              disabled={disabled}
            />
            {t('teammates.bindings.contextFreshPerDelegation')}
          </label>
        </div>
      </div>

      {custom && (
        <div className="space-y-4 border-t border-border pt-4">
          <div>
            <div className="text-xs font-semibold text-foreground">
              {t('teammates.bindings.toolsTitle')}
            </div>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {t('teammates.bindings.toolsDescription')}
            </p>
            {catalogTools.length === 0 ? (
              <div className="mt-2 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                {t('teammates.bindings.noCatalogTools')}
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {catalogTools.map((tool) => {
                  const selected = custom.tools.includes(tool);
                  return (
                    <label
                      key={tool}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                        selected
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={disabled}
                        aria-label={t('teammates.bindings.toolToggleLabel', {
                          name: teammate.name,
                          tool,
                        })}
                        onChange={(event) => {
                          const tools = event.target.checked
                            ? [...custom.tools, tool]
                            : custom.tools.filter((entry) => entry !== tool);
                          const constraints = event.target.checked
                            ? custom.constraints
                            : {
                                allow: custom.constraints.allow.filter(
                                  (selector) => selector.toolName !== tool,
                                ),
                                deny: custom.constraints.deny.filter(
                                  (selector) => selector.toolName !== tool,
                                ),
                              };
                          save({
                            ...binding,
                            toolProfile: { mode: 'custom', tools, constraints },
                          });
                        }}
                      />
                      <code>{tool}</code>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setConstraintsOpen(!constraintsOpen)}
              className="flex w-full items-center gap-2 text-left text-xs font-semibold text-foreground"
            >
              {constraintsOpen
                ? <ChevronDown className="h-3.5 w-3.5" />
                : <ChevronRight className="h-3.5 w-3.5" />}
              {t('teammates.constraints.title')}
              {constraintCount > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {constraintCount}
                </span>
              )}
            </button>

            {constraintsOpen && (
              <>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('teammates.constraints.description')}
                </p>
                <div className="rounded-lg border border-border bg-card/50 p-3">
                  <ToolCallSelectorBuilder
                    availableTools={custom.tools}
                    effects={[
                      { value: 'allow', label: t('teammates.constraints.allowedScope') },
                      { value: 'deny', label: t('teammates.constraints.blockedScope') },
                    ]}
                    labels={{
                      effect: t('teammates.constraints.scopeType'),
                      tool: t('teammates.constraints.tool'),
                      subject: t('teammates.constraints.subject'),
                      entireTool: '',
                      operator: t('teammates.constraints.operator'),
                      add: t('teammates.constraints.add'),
                      emptyTools: t('teammates.constraints.selectToolFirst'),
                      pathPlaceholder: t('teammates.constraints.pathPlaceholder'),
                      argvPlaceholder: t('teammates.constraints.argvPlaceholder'),
                      executablePlaceholder: t('teammates.constraints.executablePlaceholder'),
                      workspaceHint: t('teammates.constraints.workspaceHint'),
                      commandHint: t('teammates.constraints.commandHint'),
                      operatorLabel: (operator) =>
                        t(`teammates.constraints.operators.${operator}`),
                    }}
                    onAdd={(effect, selector) => {
                      const list = effect === 'deny'
                        ? custom.constraints.deny
                        : custom.constraints.allow;
                      if (list.some((entry) => selectorKey(entry) === selectorKey(selector))) {
                        return;
                      }
                      save({
                        ...binding,
                        toolProfile: {
                          ...custom,
                          constraints: {
                            ...custom.constraints,
                            [effect]: [...list, selector],
                          },
                        },
                      });
                    }}
                  />
                </div>
                <ConstraintList
                  allow={custom.constraints.allow}
                  deny={custom.constraints.deny}
                  disabled={disabled}
                  onRemove={(effect, index) => save({
                    ...binding,
                    toolProfile: {
                      ...custom,
                      constraints: {
                        ...custom.constraints,
                        [effect]: custom.constraints[effect].filter(
                          (_, selectorIndex) => selectorIndex !== index,
                        ),
                      },
                    },
                  })}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConstraintList({
  allow,
  deny,
  disabled,
  onRemove,
}: {
  allow: ToolCallSelector[];
  deny: ToolCallSelector[];
  disabled: boolean;
  onRemove: (effect: 'allow' | 'deny', index: number) => void;
}) {
  const { t } = useTranslation('settings');
  const entries = [
    ...allow.map((selector, index) => ({ effect: 'allow' as const, selector, index })),
    ...deny.map((selector, index) => ({ effect: 'deny' as const, selector, index })),
  ];

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
        {t('teammates.constraints.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map(({ effect, selector, index }) => (
        <div
          key={`${effect}:${selectorKey(selector)}:${index}`}
          className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
        >
          <div className="min-w-0">
            <span className={cn(
              'rounded px-1.5 py-0.5 text-[11px] font-semibold',
              effect === 'allow'
                ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
                : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
            )}
            >
              {effect === 'allow'
                ? t('teammates.constraints.allowedScope')
                : t('teammates.constraints.blockedScope')}
            </span>
            <code className="mt-1.5 block break-all text-xs text-muted-foreground">
              {toolCallSelectorSummary(selector)}
            </code>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
            disabled={disabled}
            aria-label={t('teammates.constraints.remove')}
            onClick={() => onRemove(effect, index)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function selectorKey(selector: ToolCallSelector): string {
  return JSON.stringify(selector);
}
