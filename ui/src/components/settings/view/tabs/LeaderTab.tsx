import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronLeft,
  Loader2,
  Save,
} from 'lucide-react';
import { parse as parseYaml } from 'yaml';
import { Button, MultiSelect, Select } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import { usePilotDeckConfig } from '../../../../hooks/usePilotDeckConfig';
import { buildModelRefOptions, type ModelRefOption } from '../../../../shared/buildModelRefOptions';
import type { SettingsProject, TeammateCatalog } from '../../types/types';
import {
  INPUT_CLASS,
  TEXTAREA_CLASS,
  fieldClass,
  parseArrayField,
  readJson,
  apiError,
  isRecord,
  buildProjectOptions,
  normalizeCatalog,
} from './teammatesShared';

type LeaderDraft = {
  prompt: string;
  model: string;
  maxContextTokens: string;
  maxOutputTokens: string;
  tools: string;
  plugins: string;
  skills: string;
  mcpServers: string;
};

type LeaderValidationErrors = Partial<Record<keyof LeaderDraft, string>>;

type ArrayLeaderField = 'tools' | 'plugins' | 'skills' | 'mcpServers';

const LEADER_BUILTIN_TOOLS = [
  'team_progress',
  'delegate_to_teammate',
  'send_team_message',
  'ask_user_question',
] as const;

const BUILTIN_TOOLS_SET = new Set<string>(LEADER_BUILTIN_TOOLS);

const EMPTY_DRAFT: LeaderDraft = {
  prompt: '',
  model: '',
  maxContextTokens: '',
  maxOutputTokens: '',
  tools: '',
  plugins: '',
  skills: '',
  mcpServers: '',
};

type Props = {
  projects: SettingsProject[];
  onBack: () => void;
};

function validateLeaderDraft(
  draft: LeaderDraft,
  t: (key: string) => string,
): LeaderValidationErrors {
  const errors: LeaderValidationErrors = {};
  if (!isBlankOrPositiveInteger(draft.maxContextTokens)) {
    errors.maxContextTokens = t('leader.validation.positiveInteger');
  }
  if (!isBlankOrPositiveInteger(draft.maxOutputTokens)) {
    errors.maxOutputTokens = t('leader.validation.positiveInteger');
  }
  return errors;
}

function isBlankOrPositiveInteger(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0;
}

export default function LeaderDetail({ projects, onBack }: Props) {
  const { t } = useTranslation('settings');
  const projectOptions = useMemo(() => buildProjectOptions(projects), [projects]);

  const [globalDraft, setGlobalDraft] = useState<LeaderDraft>(EMPTY_DRAFT);
  const [globalErrors, setGlobalErrors] = useState<LeaderValidationErrors>({});

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const requestSeq = useRef(0);

  const { raw: configRaw } = usePilotDeckConfig();
  const modelOptions: ModelRefOption[] = useMemo(() => {
    if (!configRaw) return [];
    try {
      const parsed = parseYaml(configRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return buildModelRefOptions(parsed.model?.providers);
      }
    } catch { /* ignore */ }
    return [];
  }, [configRaw]);

  const firstProjectPath = projectOptions[0]?.value ?? '';
  const [catalogMap, setCatalogMap] = useState<Record<string, TeammateCatalog | null>>({});
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);

  const loadCatalog = useCallback(async (projectPath: string) => {
    if (!projectPath) return;
    try {
      const response = await authenticatedFetch(
        `/api/teammates/catalog?projectPath=${encodeURIComponent(projectPath)}`,
        { suppressServerErrorToast: true },
      );
      const data = await readJson(response);
      if (response.ok) {
        setCatalogMap((prev) => ({ ...prev, [projectPath]: normalizeCatalog(data) }));
        setCatalogUnavailable(false);
      } else {
        setCatalogMap((prev) => ({ ...prev, [projectPath]: null }));
        setCatalogUnavailable(true);
      }
    } catch {
      setCatalogMap((prev) => ({ ...prev, [projectPath]: null }));
      setCatalogUnavailable(true);
    }
  }, []);

  const firstCatalog = catalogMap[firstProjectPath] ?? null;

  const loadGlobalConfig = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const response = await authenticatedFetch('/api/leader');
      const data = await readJson(response);
      if (seq !== requestSeq.current) return;
      if (!response.ok) {
        setError(apiError(data, t('leader.errors.loadFailed')));
        return;
      }
      if (isRecord(data.leader)) {
        const leader = data.leader;
        const draft: LeaderDraft = {
          prompt: typeof leader.prompt === 'string' ? leader.prompt : '',
          model: typeof leader.model === 'string' ? leader.model : '',
          maxContextTokens: typeof leader.maxContextTokens === 'number' ? String(leader.maxContextTokens) : '',
          maxOutputTokens: typeof leader.maxOutputTokens === 'number' ? String(leader.maxOutputTokens) : '',
          tools: Array.isArray(leader.tools) ? leader.tools.join('\n') : '',
          plugins: Array.isArray(leader.plugins) ? leader.plugins.join('\n') : '',
          skills: Array.isArray(leader.skills) ? leader.skills.join('\n') : '',
          mcpServers: Array.isArray(leader.mcpServers) ? leader.mcpServers.join('\n') : '',
        };
        setGlobalDraft(draft);
      } else {
        setGlobalDraft(EMPTY_DRAFT);
      }
    } catch {
      if (seq === requestSeq.current) setError(t('leader.errors.loadFailed'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadGlobalConfig(); }, [loadGlobalConfig]);

  useEffect(() => {
    for (const project of projectOptions) {
      void loadCatalog(project.value);
    }
  }, [loadCatalog, projectOptions]);

  const saveGlobal = useCallback(async () => {
    const errors = validateLeaderDraft(globalDraft, t);
    setGlobalErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    setError('');
    setMessage('');
    try {
      const model = globalDraft.model.trim();
      const maxCtx = globalDraft.maxContextTokens.trim();
      const maxOut = globalDraft.maxOutputTokens.trim();
      const definition: Record<string, unknown> = {
        prompt: globalDraft.prompt.trim(),
        tools: parseArrayField(globalDraft.tools),
        plugins: parseArrayField(globalDraft.plugins),
        skills: parseArrayField(globalDraft.skills),
        mcpServers: parseArrayField(globalDraft.mcpServers),
      };
      if (model) definition.model = model;
      if (maxCtx) definition.maxContextTokens = Number(maxCtx);
      if (maxOut) definition.maxOutputTokens = Number(maxOut);

      const response = await authenticatedFetch('/api/leader', {
        method: 'PUT',
        body: JSON.stringify({ definition }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        setError(apiError(data, t('leader.errors.saveFailed')));
        return;
      }
      setMessage(t('leader.messages.saved'));
    } catch {
      setError(t('leader.errors.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [globalDraft, t]);

  const updateGlobalDraft = (field: keyof LeaderDraft, value: string) => {
    setGlobalDraft((prev) => ({ ...prev, [field]: value }));
    setGlobalErrors((prev) => { const next = { ...prev }; delete next[field]; return next; });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const modelSelectOptions = [
    { value: '', label: t('leader.fields.modelDefault') },
    ...modelOptions,
  ];

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        {t('leader.detail.backToList')}
      </button>

      <div>
        <h3 className="text-lg font-semibold text-foreground">{t('leader.title')}</h3>
      </div>

      {(error || message) && (
        <Notice tone={error ? 'error' : 'success'}>{error || message}</Notice>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void saveGlobal();
        }}
      >
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-semibold text-foreground">{t('leader.globalSection')}</h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('leader.globalDescription')}</p>
          </div>

          <Field label={t('leader.fields.prompt')}>
            <textarea
              value={globalDraft.prompt}
              onChange={(e) => updateGlobalDraft('prompt', e.target.value)}
              placeholder={t('leader.fields.promptPlaceholder')}
              rows={8}
              className={TEXTAREA_CLASS}
            />
          </Field>

          <Field label={t('leader.fields.model')}>
            <Select
              value={globalDraft.model}
              onChange={(v) => updateGlobalDraft('model', v)}
              options={modelSelectOptions}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('leader.fields.maxOutputTokens')}
              error={globalErrors.maxOutputTokens}
            >
              <input
                type="number"
                min={1}
                step={1}
                value={globalDraft.maxOutputTokens}
                onChange={(e) => updateGlobalDraft('maxOutputTokens', e.target.value)}
                placeholder={t('leader.placeholders.maxOutputTokens')}
                className={fieldClass(INPUT_CLASS, globalErrors.maxOutputTokens)}
              />
              <span className="block text-xs leading-5 text-muted-foreground">
                {t('leader.fields.maxOutputTokensHelp')}
              </span>
            </Field>
            <Field
              label={t('leader.fields.maxContextTokens')}
              error={globalErrors.maxContextTokens}
            >
              <input
                type="number"
                min={1}
                step={1}
                value={globalDraft.maxContextTokens}
                onChange={(e) => updateGlobalDraft('maxContextTokens', e.target.value)}
                placeholder={t('leader.placeholders.maxContextTokens')}
                className={fieldClass(INPUT_CLASS, globalErrors.maxContextTokens)}
              />
              <span className="block text-xs leading-5 text-muted-foreground">
                {t('leader.fields.maxContextTokensHelp')}
              </span>
            </Field>
          </div>

          <Field label={t('leader.fields.tools')}>
            <BuiltinToolsBadges />
            <MultiSelect
              selected={parseArrayField(globalDraft.tools).filter((t) => !BUILTIN_TOOLS_SET.has(t))}
              options={(firstCatalog?.tools ?? []).filter((t) => !BUILTIN_TOOLS_SET.has(t))}
              onChange={(values) => updateGlobalDraft('tools', values.join('\n'))}
              placeholder={t('leader.placeholders.tools')}
            />
          </Field>

          {(['plugins', 'skills', 'mcpServers'] as const).map((field) => (
            <Field key={field} label={t(`leader.fields.${field}`)}>
              <MultiSelect
                selected={parseArrayField(globalDraft[field])}
                options={firstCatalog?.[field] ?? []}
                onChange={(values) => updateGlobalDraft(field, values.join('\n'))}
                placeholder={t(`leader.placeholders.${field}`)}
              />
            </Field>
          ))}

          {projectOptions.length === 0 && (
            <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{t('leader.workspace.none')}</span>
            </div>
          )}

          {projectOptions.length > 0 && catalogUnavailable && (
            <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{t('leader.errors.catalogFailed')}</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" onClick={onBack} disabled={saving}>
            {t('leader.actions.cancel')}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? t('leader.actions.saving') : t('leader.actions.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      {children}
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </label>
  );
}

function BuiltinToolsBadges() {
  const { t } = useTranslation('settings');
  return (
    <div className="mb-2 space-y-1">
      <span className="text-xs font-medium text-muted-foreground">
        {t('leader.fields.builtinTools')}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {LEADER_BUILTIN_TOOLS.map((tool) => (
          <span
            key={tool}
            className="inline-flex items-center rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border"
          >
            {tool}
          </span>
        ))}
      </div>
      <span className="block text-[11px] leading-4 text-muted-foreground/70">
        {t('leader.fields.builtinToolsHint')}
      </span>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`rounded-lg border px-4 py-3 text-sm ${
        tone === 'error'
          ? 'border-destructive/40 bg-destructive/5 text-destructive'
          : 'border-border bg-card/60 text-muted-foreground'
      }`}
    >
      {children}
    </div>
  );
}
