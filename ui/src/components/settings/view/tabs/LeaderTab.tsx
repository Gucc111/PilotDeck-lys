import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Save,
  Trash2,
} from 'lucide-react';
import { parse as parseYaml } from 'yaml';
import { Button, MultiSelect, PillBar, Pill, Select } from '../../../../shared/view/ui';
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
  type ProjectOption,
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

type DetailTab = 'definition' | 'workspaces';

type ArrayLeaderField = 'tools' | 'plugins' | 'skills' | 'mcpServers';
const ARRAY_LEADER_FIELDS: ArrayLeaderField[] = ['tools', 'plugins', 'skills', 'mcpServers'];

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

type OverrideSnapshot = {
  revision: string;
  override?: Record<string, unknown>;
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

  const [tab, setTab] = useState<DetailTab>('definition');

  const [globalDraft, setGlobalDraft] = useState<LeaderDraft>(EMPTY_DRAFT);
  const [globalErrors, setGlobalErrors] = useState<LeaderValidationErrors>({});
  const [globalConfigured, setGlobalConfigured] = useState(false);

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
        const hasAnyContent = draft.prompt || draft.model || draft.tools || draft.plugins || draft.skills || draft.mcpServers;
        setGlobalConfigured(Boolean(hasAnyContent));
      } else {
        setGlobalDraft(EMPTY_DRAFT);
        setGlobalConfigured(false);
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
      setGlobalConfigured(true);
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

      <PillBar>
        <Pill isActive={tab === 'definition'} onClick={() => setTab('definition')}>
          {t('leader.detail.definitionTab')}
        </Pill>
        <Pill isActive={tab === 'workspaces'} onClick={() => setTab('workspaces')}>
          {t('leader.detail.workspacesTab')}
        </Pill>
      </PillBar>

      {tab === 'definition' && (
        <LeaderDefinitionForm
          draft={globalDraft}
          errors={globalErrors}
          catalog={firstCatalog}
          catalogUnavailable={catalogUnavailable}
          hasWorkspace={projectOptions.length > 0}
          modelOptions={modelOptions}
          saving={saving}
          onUpdateDraft={updateGlobalDraft}
          onSave={() => void saveGlobal()}
          onCancel={onBack}
        />
      )}

      {tab === 'workspaces' && (
        <LeaderWorkspacesPanel
          projects={projectOptions}
          catalogMap={catalogMap}
          modelOptions={modelOptions}
        />
      )}
    </div>
  );
}

function LeaderDefinitionForm({
  draft,
  errors,
  catalog,
  catalogUnavailable,
  hasWorkspace,
  modelOptions,
  saving,
  onUpdateDraft,
  onSave,
  onCancel,
}: {
  draft: LeaderDraft;
  errors: LeaderValidationErrors;
  catalog: TeammateCatalog | null;
  catalogUnavailable: boolean;
  hasWorkspace: boolean;
  modelOptions: ModelRefOption[];
  saving: boolean;
  onUpdateDraft: (field: keyof LeaderDraft, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');

  const modelSelectOptions = [
    { value: '', label: t('leader.fields.modelDefault') },
    ...modelOptions,
  ];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{t('leader.globalSection')}</h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('leader.globalDescription')}</p>
        </div>

        <Field label={t('leader.fields.prompt')}>
          <textarea
            value={draft.prompt}
            onChange={(e) => onUpdateDraft('prompt', e.target.value)}
            placeholder={t('leader.fields.promptPlaceholder')}
            rows={8}
            className={TEXTAREA_CLASS}
          />
        </Field>

        <Field label={t('leader.fields.model')}>
          <Select
            value={draft.model}
            onChange={(v) => onUpdateDraft('model', v)}
            options={modelSelectOptions}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('leader.fields.maxOutputTokens')}
            error={errors.maxOutputTokens}
          >
            <input
              type="number"
              min={1}
              step={1}
              value={draft.maxOutputTokens}
              onChange={(e) => onUpdateDraft('maxOutputTokens', e.target.value)}
              placeholder={t('leader.placeholders.maxOutputTokens')}
              className={fieldClass(INPUT_CLASS, errors.maxOutputTokens)}
            />
            <span className="block text-xs leading-5 text-muted-foreground">
              {t('leader.fields.maxOutputTokensHelp')}
            </span>
          </Field>
          <Field
            label={t('leader.fields.maxContextTokens')}
            error={errors.maxContextTokens}
          >
            <input
              type="number"
              min={1}
              step={1}
              value={draft.maxContextTokens}
              onChange={(e) => onUpdateDraft('maxContextTokens', e.target.value)}
              placeholder={t('leader.placeholders.maxContextTokens')}
              className={fieldClass(INPUT_CLASS, errors.maxContextTokens)}
            />
            <span className="block text-xs leading-5 text-muted-foreground">
              {t('leader.fields.maxContextTokensHelp')}
            </span>
          </Field>
        </div>

        <Field label={t('leader.fields.tools')}>
          <BuiltinToolsBadges />
          <MultiSelect
            selected={parseArrayField(draft.tools).filter((t) => !BUILTIN_TOOLS_SET.has(t))}
            options={(catalog?.tools ?? []).filter((t) => !BUILTIN_TOOLS_SET.has(t))}
            onChange={(values) => onUpdateDraft('tools', values.join('\n'))}
            placeholder={t('leader.placeholders.tools')}
          />
        </Field>

        {(['plugins', 'skills', 'mcpServers'] as const).map((field) => (
          <Field key={field} label={t(`leader.fields.${field}`)}>
            <MultiSelect
              selected={parseArrayField(draft[field])}
              options={catalog?.[field] ?? []}
              onChange={(values) => onUpdateDraft(field, values.join('\n'))}
              placeholder={t(`leader.placeholders.${field}`)}
            />
          </Field>
        ))}

        {!hasWorkspace && (
          <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{t('leader.workspace.none')}</span>
          </div>
        )}

        {hasWorkspace && catalogUnavailable && (
          <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{t('leader.errors.catalogFailed')}</span>
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
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
  );
}

function LeaderWorkspacesPanel({
  projects,
  catalogMap,
  modelOptions,
}: {
  projects: ProjectOption[];
  catalogMap: Record<string, TeammateCatalog | null>;
  modelOptions: ModelRefOption[];
}) {
  const { t } = useTranslation('settings');
  const [expandedWorkspace, setExpandedWorkspace] = useState<string | null>(null);

  const [overrideSnapshots, setOverrideSnapshots] = useState<Record<string, OverrideSnapshot>>({});
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, LeaderDraft>>({});
  const [overrideEnabled, setOverrideEnabled] = useState<Record<string, boolean>>({});
  const [overrideErrors, setOverrideErrors] = useState<Record<string, LeaderValidationErrors>>({});
  const [overrideLoading, setOverrideLoading] = useState<Set<string>>(new Set());
  const [savingProject, setSavingProject] = useState<string | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsMessage, setWsMessage] = useState<string | null>(null);

  const loadOverride = useCallback(async (projectPath: string) => {
    setOverrideLoading((prev) => new Set(prev).add(projectPath));
    try {
      const response = await authenticatedFetch(
        `/api/leader/override?projectPath=${encodeURIComponent(projectPath)}`,
      );
      const data = await readJson(response);
      if (!response.ok) return;
      const revision = typeof data.revision === 'string' ? data.revision : '';
      const override = isRecord(data.override) ? data.override : undefined;
      setOverrideSnapshots((prev) => ({ ...prev, [projectPath]: { revision, override } }));
      if (override) {
        setOverrideEnabled((prev) => ({ ...prev, [projectPath]: true }));
        setOverrideDrafts((prev) => ({
          ...prev,
          [projectPath]: overrideToDraft(override),
        }));
      } else {
        setOverrideEnabled((prev) => ({ ...prev, [projectPath]: false }));
        setOverrideDrafts((prev) => ({ ...prev, [projectPath]: EMPTY_DRAFT }));
      }
    } catch {
      // silently ignore
    } finally {
      setOverrideLoading((prev) => {
        const next = new Set(prev);
        next.delete(projectPath);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    for (const project of projects) {
      void loadOverride(project.value);
    }
  }, [projects, loadOverride]);

  const saveOverride = useCallback(async (projectPath: string) => {
    const snapshot = overrideSnapshots[projectPath];
    const draft = overrideDrafts[projectPath];
    if (!snapshot || !draft) return;
    const errors = validateLeaderDraft(draft, t);
    setOverrideErrors((prev) => ({ ...prev, [projectPath]: errors }));
    if (Object.keys(errors).length > 0) return;

    setSavingProject(projectPath);
    setWsError(null);
    setWsMessage(null);
    try {
      const model = draft.model.trim();
      const maxCtx = draft.maxContextTokens.trim();
      const maxOut = draft.maxOutputTokens.trim();
      const tools = parseArrayField(draft.tools);
      const override: Record<string, unknown> = {};
      if (model) override.model = model;
      if (maxCtx) override.maxContextTokens = Number(maxCtx);
      if (maxOut) override.maxOutputTokens = Number(maxOut);
      if (draft.prompt.trim()) override.prompt = draft.prompt.trim();
      if (tools.length > 0) override.toolProfile = { mode: 'custom', tools };
      const plugins = parseArrayField(draft.plugins);
      if (plugins.length > 0) override.plugins = plugins;
      const skills = parseArrayField(draft.skills);
      if (skills.length > 0) override.skills = skills;
      const mcpServers = parseArrayField(draft.mcpServers);
      if (mcpServers.length > 0) override.mcpServers = mcpServers;

      const response = await authenticatedFetch('/api/leader/override', {
        method: 'PUT',
        body: JSON.stringify({
          projectPath,
          override,
          expectedRevision: snapshot.revision,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        if (response.status === 409) {
          await loadOverride(projectPath);
          setWsError(t('leader.errors.revisionConflict'));
        } else {
          setWsError(apiError(data, t('leader.errors.saveFailed')));
        }
        return;
      }
      const newRevision = typeof data.revision === 'string' ? data.revision : snapshot.revision;
      setOverrideSnapshots((prev) => ({ ...prev, [projectPath]: { revision: newRevision, override } }));
      setWsMessage(t('leader.messages.overrideSaved'));
    } catch {
      setWsError(t('leader.errors.saveFailed'));
    } finally {
      setSavingProject(null);
    }
  }, [overrideSnapshots, overrideDrafts, t, loadOverride]);

  const deleteOverride = useCallback(async (projectPath: string) => {
    const snapshot = overrideSnapshots[projectPath];
    if (!snapshot) return;
    setSavingProject(projectPath);
    setWsError(null);
    setWsMessage(null);
    try {
      const response = await authenticatedFetch(
        `/api/leader/override?projectPath=${encodeURIComponent(projectPath)}&expectedRevision=${encodeURIComponent(snapshot.revision)}`,
        { method: 'DELETE' },
      );
      const data = await readJson(response);
      if (!response.ok) {
        if (response.status === 409) {
          await loadOverride(projectPath);
          setWsError(t('leader.errors.revisionConflict'));
        } else {
          setWsError(apiError(data, t('leader.errors.deleteFailed')));
        }
        return;
      }
      setOverrideEnabled((prev) => ({ ...prev, [projectPath]: false }));
      setOverrideDrafts((prev) => ({ ...prev, [projectPath]: EMPTY_DRAFT }));
      const newRevision = typeof data.revision === 'string' ? data.revision : '';
      setOverrideSnapshots((prev) => ({
        ...prev,
        [projectPath]: { revision: newRevision, override: undefined },
      }));
      setWsMessage(t('leader.messages.overrideDeleted'));
    } catch {
      setWsError(t('leader.errors.deleteFailed'));
    } finally {
      setSavingProject(null);
    }
  }, [overrideSnapshots, t, loadOverride]);

  if (projects.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t('leader.workspace.none')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-foreground">{t('leader.workspace.title')}</h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('leader.workspace.description')}</p>
      </div>

      {(wsError || wsMessage) && (
        <Notice tone={wsError ? 'error' : 'success'}>{wsError || wsMessage}</Notice>
      )}

      <div className="space-y-2">
        {projects.map((project) => {
          const snapshot = overrideSnapshots[project.value];
          const hasOverride = Boolean(snapshot?.override);
          const loading = overrideLoading.has(project.value);
          const expanded = expandedWorkspace === project.value;
          const enabled = overrideEnabled[project.value] ?? false;
          const draft = overrideDrafts[project.value] ?? EMPTY_DRAFT;
          const errs = overrideErrors[project.value] ?? {};
          const isSaving = savingProject === project.value;
          const catalog = catalogMap[project.value] ?? null;

          return (
            <div
              key={project.value}
              className="rounded-lg border border-border bg-background/70"
            >
              <button
                type="button"
                onClick={() => setExpandedWorkspace(expanded ? null : project.value)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/30"
              >
                {expanded
                  ? <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  : <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {project.label}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      hasOverride
                        ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {hasOverride
                        ? t('leader.workspace.hasOverride')
                        : t('leader.workspace.noOverride')}
                    </span>
                  </div>
                </div>
                {loading && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />}
              </button>

              {expanded && (
                <div className="border-t border-border px-4 py-4">
                  {loading ? (
                    <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    </div>
                  ) : (
                    <LeaderWorkspaceOverrideEditor
                      draft={draft}
                      errors={errs}
                      enabled={enabled}
                      hasExistingOverride={hasOverride}
                      catalog={catalog}
                      modelOptions={modelOptions}
                      saving={isSaving}
                      disabled={savingProject !== null}
                      onToggleEnabled={(value) => setOverrideEnabled((prev) => ({ ...prev, [project.value]: value }))}
                      onUpdateDraft={(field, value) => {
                        setOverrideDrafts((prev) => ({
                          ...prev,
                          [project.value]: { ...(prev[project.value] ?? EMPTY_DRAFT), [field]: value },
                        }));
                        setOverrideErrors((prev) => {
                          const next = { ...(prev[project.value] ?? {}) };
                          delete next[field];
                          return { ...prev, [project.value]: next };
                        });
                      }}
                      onSave={() => void saveOverride(project.value)}
                      onDelete={() => void deleteOverride(project.value)}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LeaderWorkspaceOverrideEditor({
  draft,
  errors,
  enabled,
  hasExistingOverride,
  catalog,
  modelOptions,
  saving,
  disabled,
  onToggleEnabled,
  onUpdateDraft,
  onSave,
  onDelete,
}: {
  draft: LeaderDraft;
  errors: LeaderValidationErrors;
  enabled: boolean;
  hasExistingOverride: boolean;
  catalog: TeammateCatalog | null;
  modelOptions: ModelRefOption[];
  saving: boolean;
  disabled: boolean;
  onToggleEnabled: (value: boolean) => void;
  onUpdateDraft: (field: keyof LeaderDraft, value: string) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('settings');

  const modelSelectOptions = [
    { value: '', label: t('leader.fields.modelDefault') },
    ...modelOptions,
  ];

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggleEnabled(e.target.checked)}
          disabled={disabled}
          className="h-4 w-4 rounded border-border accent-primary disabled:cursor-not-allowed disabled:opacity-60"
        />
        {t('leader.workspace.enableOverride')}
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </label>

      {enabled && (
        <>
          <Field label={t('leader.fields.prompt')}>
            <textarea
              value={draft.prompt}
              onChange={(e) => onUpdateDraft('prompt', e.target.value)}
              placeholder={t('leader.fields.promptPlaceholder')}
              rows={5}
              className={TEXTAREA_CLASS}
            />
          </Field>

          <Field label={t('leader.fields.model')}>
            <Select
              value={draft.model}
              onChange={(v) => onUpdateDraft('model', v)}
              options={modelSelectOptions}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('leader.fields.maxOutputTokens')}
              error={errors.maxOutputTokens}
            >
              <input
                type="number"
                min={1}
                step={1}
                value={draft.maxOutputTokens}
                onChange={(e) => onUpdateDraft('maxOutputTokens', e.target.value)}
                placeholder={t('leader.placeholders.maxOutputTokens')}
                className={fieldClass(INPUT_CLASS, errors.maxOutputTokens)}
              />
            </Field>
            <Field
              label={t('leader.fields.maxContextTokens')}
              error={errors.maxContextTokens}
            >
              <input
                type="number"
                min={1}
                step={1}
                value={draft.maxContextTokens}
                onChange={(e) => onUpdateDraft('maxContextTokens', e.target.value)}
                placeholder={t('leader.placeholders.maxContextTokens')}
                className={fieldClass(INPUT_CLASS, errors.maxContextTokens)}
              />
            </Field>
          </div>

          <Field label={t('leader.fields.tools')}>
            <BuiltinToolsBadges />
            <MultiSelect
              selected={parseArrayField(draft.tools).filter((t) => !BUILTIN_TOOLS_SET.has(t))}
              options={(catalog?.tools ?? []).filter((t) => !BUILTIN_TOOLS_SET.has(t))}
              onChange={(values) => onUpdateDraft('tools', values.join('\n'))}
              placeholder={t('leader.placeholders.tools')}
            />
          </Field>

          {(['plugins', 'skills', 'mcpServers'] as const).map((field) => (
            <Field key={field} label={t(`leader.fields.${field}`)}>
              <MultiSelect
                selected={parseArrayField(draft[field])}
                options={catalog?.[field] ?? []}
                onChange={(values) => onUpdateDraft(field, values.join('\n'))}
                placeholder={t(`leader.placeholders.${field}`)}
              />
            </Field>
          ))}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            {hasExistingOverride && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onDelete}
                disabled={disabled}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                {t('leader.actions.deleteOverride')}
              </Button>
            )}
            <Button type="button" size="sm" onClick={onSave} disabled={disabled}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t('leader.actions.saveOverride')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function overrideToDraft(override: Record<string, unknown>): LeaderDraft {
  return {
    prompt: typeof override.prompt === 'string' ? override.prompt : '',
    model: typeof override.model === 'string' ? override.model : '',
    maxContextTokens: typeof override.maxContextTokens === 'number' ? String(override.maxContextTokens) : '',
    maxOutputTokens: typeof override.maxOutputTokens === 'number' ? String(override.maxOutputTokens) : '',
    tools: isRecord(override.toolProfile) && override.toolProfile.mode === 'custom' && Array.isArray(override.toolProfile.tools)
      ? (override.toolProfile.tools as string[]).join('\n')
      : '',
    plugins: Array.isArray(override.plugins) ? (override.plugins as string[]).join('\n') : '',
    skills: Array.isArray(override.skills) ? (override.skills as string[]).join('\n') : '',
    mcpServers: Array.isArray(override.mcpServers) ? (override.mcpServers as string[]).join('\n') : '',
  };
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
