import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import { cn } from '../../../../lib/utils';
import type {
  SettingsProject,
  TeammateCatalog,
  TeammateDefinition,
  TeammateDiagnostic,
  TeammateRecord,
} from '../../types/types';

type EditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; originalId: string };

type TeammateDraft = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model: string;
  tools: string;
  plugins: string;
  skills: string;
  mcpServers: string;
};

type DraftField = keyof TeammateDraft;
type ArrayDraftField = 'tools' | 'plugins' | 'skills' | 'mcpServers';
type ValidationErrors = Partial<Record<DraftField, string>>;

const INPUT_CLASS =
  'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring';
const TEXTAREA_CLASS =
  'w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring';
const TEAMMATE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const ARRAY_FIELDS: ArrayDraftField[] = ['tools', 'plugins', 'skills', 'mcpServers'];

const EMPTY_DRAFT: TeammateDraft = {
  id: '',
  name: '',
  description: '',
  prompt: '',
  model: '',
  tools: '',
  plugins: '',
  skills: '',
  mcpServers: '',
};

export default function TeammatesTab({ projects = [] }: { projects?: SettingsProject[] }) {
  const { t } = useTranslation('settings');
  const projectOptions = useMemo(
    () =>
      projects
        .map((project) => ({
          label: project.displayName || project.name || project.fullPath || project.path || '',
          value: (project.fullPath || project.path || '').trim(),
        }))
        .filter((project) => project.value),
    [projects],
  );

  const [projectPath, setProjectPath] = useState(projectOptions[0]?.value ?? '');
  const [teammates, setTeammates] = useState<TeammateRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<TeammateDiagnostic[]>([]);
  const [catalog, setCatalog] = useState<TeammateCatalog | null>(null);
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [draft, setDraft] = useState<TeammateDraft>(EMPTY_DRAFT);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [serverDiagnostics, setServerDiagnostics] = useState<TeammateDiagnostic[]>([]);

  useEffect(() => {
    if (projectOptions.some((project) => project.value === projectPath)) return;
    setProjectPath(projectOptions[0]?.value ?? '');
  }, [projectOptions, projectPath]);

  const loadTeammates = useCallback(async () => {
    if (!projectPath) {
      setTeammates([]);
      setDiagnostics([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch(
        `/api/teammates?projectPath=${encodeURIComponent(projectPath)}`,
      );
      const data = await readJson(response);
      if (!response.ok) throw new Error(apiError(data, t('teammates.errors.load')));
      setTeammates(normalizeTeammates(data.teammates));
      setDiagnostics(normalizeDiagnostics(data.diagnostics));
    } catch (caught) {
      setTeammates([]);
      setDiagnostics([]);
      setError(caught instanceof Error ? caught.message : t('teammates.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [projectPath, t]);

  const loadCatalog = useCallback(async () => {
    if (!projectPath) {
      setCatalog(null);
      setCatalogUnavailable(false);
      return;
    }
    try {
      const response = await authenticatedFetch(
        `/api/teammates/catalog?projectPath=${encodeURIComponent(projectPath)}`,
        { suppressServerErrorToast: true },
      );
      const data = await readJson(response);
      if (!response.ok) throw new Error(apiError(data, t('teammates.errors.catalog')));
      setCatalog(normalizeCatalog(data));
      setCatalogUnavailable(false);
    } catch {
      setCatalog(null);
      setCatalogUnavailable(true);
    }
  }, [projectPath, t]);

  useEffect(() => {
    setEditorMode(null);
    setDraft(EMPTY_DRAFT);
    setValidationErrors({});
    setServerDiagnostics([]);
    setMessage(null);
    void loadTeammates();
    void loadCatalog();
  }, [loadCatalog, loadTeammates]);

  const startNew = () => {
    setEditorMode({ kind: 'new' });
    setDraft(EMPTY_DRAFT);
    setValidationErrors({});
    setServerDiagnostics([]);
    setError(null);
    setMessage(null);
  };

  const startEdit = (teammate: TeammateRecord) => {
    setEditorMode({ kind: 'edit', originalId: teammate.id });
    setDraft(draftFromTeammate(teammate));
    setValidationErrors({});
    setServerDiagnostics([]);
    setError(null);
    setMessage(null);
  };

  const closeEditor = () => {
    setEditorMode(null);
    setDraft(EMPTY_DRAFT);
    setValidationErrors({});
    setServerDiagnostics([]);
  };

  const updateDraft = (field: DraftField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setValidationErrors((current) => ({ ...current, [field]: undefined }));
    setServerDiagnostics([]);
  };

  const save = async () => {
    if (!projectPath || !editorMode) return;
    const nextErrors = validateDraft(draft, t);
    setValidationErrors(nextErrors);
    setServerDiagnostics([]);
    setError(null);
    setMessage(null);
    if (Object.keys(nextErrors).length > 0) return;

    const definition = definitionFromDraft(draft);
    const routeId = editorMode.kind === 'edit' ? editorMode.originalId : definition.id;
    setSaving(true);
    try {
      const response = await authenticatedFetch(
        `/api/teammates/${encodeURIComponent(routeId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ projectPath, definition }),
        },
      );
      const data = await readJson(response);
      if (!response.ok) {
        const responseDiagnostics = extractResponseDiagnostics(data);
        setServerDiagnostics(responseDiagnostics);
        throw new Error(apiError(data, t('teammates.errors.save')));
      }
      await loadTeammates();
      closeEditor();
      setMessage(t('teammates.status.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('teammates.errors.save'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (teammate: TeammateRecord) => {
    if (!projectPath || !window.confirm(t('teammates.confirmDelete', { name: teammate.name }))) {
      return;
    }
    setDeletingId(teammate.id);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch(
        `/api/teammates/${encodeURIComponent(teammate.id)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ projectPath }),
        },
      );
      const data = await readJson(response);
      if (!response.ok) throw new Error(apiError(data, t('teammates.errors.delete')));
      if (editorMode?.kind === 'edit' && editorMode.originalId === teammate.id) {
        closeEditor();
      }
      await loadTeammates();
      setMessage(t('teammates.status.deleted'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('teammates.errors.delete'));
    } finally {
      setDeletingId(null);
    }
  };

  const addCatalogValue = (field: ArrayDraftField, value: string) => {
    const values = parseArrayField(draft[field]);
    if (values.includes(value)) return;
    updateDraft(field, [...values, value].join('\n'));
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-card/60 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm font-semibold text-foreground">{t('teammates.title')}</div>
              <div className="text-xs leading-5 text-muted-foreground">{t('teammates.description')}</div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void loadTeammates();
              void loadCatalog();
            }}
            disabled={!projectPath || loading}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            {t('teammates.actions.refresh')}
          </Button>
        </div>
      </div>

      <label className="block space-y-2">
        <span className="text-xs font-medium text-muted-foreground">{t('teammates.project')}</span>
        <select
          value={projectPath}
          onChange={(event) => setProjectPath(event.target.value)}
          disabled={projectOptions.length === 0}
          className={cn(INPUT_CLASS, 'disabled:cursor-not-allowed disabled:opacity-60')}
        >
          {projectOptions.length === 0 ? (
            <option value="">{t('teammates.selectProject')}</option>
          ) : (
            projectOptions.map((project) => (
              <option key={project.value} value={project.value}>
                {project.label}
              </option>
            ))
          )}
        </select>
      </label>

      {projectOptions.length === 0 && (
        <Notice tone="warning">{t('teammates.noProjects')}</Notice>
      )}

      {diagnostics.length > 0 && (
        <DiagnosticList
          title={t('teammates.diagnostics.title')}
          diagnostics={diagnostics}
        />
      )}

      {(error || message) && (
        <Notice tone={error ? 'error' : 'success'}>{error || message}</Notice>
      )}

      <div className="grid gap-5 md:grid-cols-[minmax(230px,0.85fr)_minmax(0,1.45fr)]">
        <section className="overflow-hidden rounded-lg border border-border bg-card/60">
          <div className="flex items-center justify-between gap-3 border-b border-border p-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">{t('teammates.list.title')}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('teammates.list.count', { count: teammates.length })}
              </p>
            </div>
            <Button size="sm" onClick={startNew} disabled={!projectPath}>
              <Plus className="h-4 w-4" />
              {t('teammates.actions.new')}
            </Button>
          </div>

          {loading ? (
            <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('teammates.loading')}
            </div>
          ) : teammates.length === 0 ? (
            <div className="p-4">
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                {t('teammates.empty')}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {teammates.map((teammate) => {
                const active =
                  editorMode?.kind === 'edit' && editorMode.originalId === teammate.id;
                return (
                  <div
                    key={`${teammate.id}:${teammate.relativePath || ''}`}
                    className={cn('p-4 transition-colors', active && 'bg-accent/30')}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {teammate.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {teammate.id}
                      </div>
                      {teammate.description && (
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {teammate.description}
                        </p>
                      )}
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => startEdit(teammate)}
                      >
                        <Pencil className="h-4 w-4" />
                        {t('teammates.actions.edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void remove(teammate)}
                        disabled={deletingId === teammate.id}
                        aria-label={t('teammates.actions.delete')}
                        title={t('teammates.actions.delete')}
                      >
                        {deletingId === teammate.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-lg border border-border bg-card/60">
          {!editorMode ? (
            <div className="flex min-h-[360px] items-center justify-center p-8 text-center text-sm leading-6 text-muted-foreground">
              {t('teammates.editor.select')}
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="border-b border-border p-4">
                <h3 className="text-sm font-semibold text-foreground">
                  {editorMode.kind === 'new'
                    ? t('teammates.editor.new')
                    : t('teammates.editor.edit')}
                </h3>
              </div>

              <div className="space-y-4 p-4">
                {serverDiagnostics.length > 0 && (
                  <DiagnosticList
                    title={t('teammates.diagnostics.validation')}
                    diagnostics={serverDiagnostics}
                  />
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t('teammates.fields.id')}
                    description={t('teammates.fields.idHelp')}
                    error={validationErrors.id}
                  >
                    <input
                      value={draft.id}
                      onChange={(event) => updateDraft('id', event.target.value)}
                      placeholder={t('teammates.placeholders.id')}
                      className={fieldClass(INPUT_CLASS, validationErrors.id)}
                    />
                  </Field>
                  <Field
                    label={t('teammates.fields.name')}
                    error={validationErrors.name}
                  >
                    <input
                      value={draft.name}
                      onChange={(event) => updateDraft('name', event.target.value)}
                      placeholder={t('teammates.placeholders.name')}
                      className={fieldClass(INPUT_CLASS, validationErrors.name)}
                    />
                  </Field>
                </div>

                <Field label={t('teammates.fields.description')}>
                  <textarea
                    value={draft.description}
                    onChange={(event) => updateDraft('description', event.target.value)}
                    placeholder={t('teammates.placeholders.description')}
                    rows={2}
                    className={TEXTAREA_CLASS}
                  />
                </Field>

                <Field label={t('teammates.fields.prompt')} error={validationErrors.prompt}>
                  <textarea
                    value={draft.prompt}
                    onChange={(event) => updateDraft('prompt', event.target.value)}
                    placeholder={t('teammates.placeholders.prompt')}
                    rows={8}
                    className={fieldClass(TEXTAREA_CLASS, validationErrors.prompt)}
                  />
                </Field>

                <Field
                  label={t('teammates.fields.model')}
                  description={t('teammates.fields.modelHelp')}
                >
                  <input
                    value={draft.model}
                    onChange={(event) => updateDraft('model', event.target.value)}
                    placeholder={t('teammates.placeholders.model')}
                    className={INPUT_CLASS}
                  />
                </Field>

                {ARRAY_FIELDS.map((field) => (
                  <ArrayField
                    key={field}
                    field={field}
                    value={draft[field]}
                    catalogValues={catalog?.[field] ?? []}
                    onChange={(value) => updateDraft(field, value)}
                    onAddCatalogValue={(value) => addCatalogValue(field, value)}
                  />
                ))}

                {catalogUnavailable && (
                  <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <span>{t('teammates.catalog.manualOnly')}</span>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t border-border bg-muted/20 px-4 py-3">
                <Button type="button" variant="outline" onClick={closeEditor} disabled={saving}>
                  {t('teammates.actions.cancel')}
                </Button>
                <Button type="submit" disabled={saving || !projectPath}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving ? t('teammates.actions.saving') : t('teammates.actions.save')}
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

function ArrayField({
  field,
  value,
  catalogValues,
  onChange,
  onAddCatalogValue,
}: {
  field: ArrayDraftField;
  value: string;
  catalogValues: string[];
  onChange: (value: string) => void;
  onAddCatalogValue: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const selected = new Set(parseArrayField(value));

  return (
    <Field
      label={t(`teammates.fields.${field}`)}
      description={t('teammates.fields.arrayHelp')}
    >
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t(`teammates.placeholders.${field}`)}
        rows={3}
        className={TEXTAREA_CLASS}
      />
      {catalogValues.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {catalogValues.map((entry) => {
            const isSelected = selected.has(entry);
            return (
              <button
                key={entry}
                type="button"
                onClick={() => onAddCatalogValue(entry)}
                disabled={isSelected}
                className={cn(
                  'rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
                  isSelected
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {entry}
              </button>
            );
          })}
        </div>
      )}
    </Field>
  );
}

function Field({
  label,
  description,
  error,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
        )}
      </span>
      {children}
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </label>
  );
}

function DiagnosticList({
  title,
  diagnostics,
}: {
  title: ReactNode;
  diagnostics: TeammateDiagnostic[];
}) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
        <AlertTriangle className="h-4 w-4" />
        {title}
      </div>
      <ul className="mt-2 space-y-1 text-xs leading-5 text-destructive">
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.code}:${diagnostic.relativePath || ''}:${index}`}>
            {diagnostic.relativePath ? `${diagnostic.relativePath}: ` : ''}
            {diagnostic.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'error' | 'warning' | 'success';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        tone === 'error' && 'border-destructive/40 bg-destructive/5 text-destructive',
        tone === 'warning' && 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300',
        tone === 'success' && 'border-border bg-card/60 text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

function validateDraft(
  draft: TeammateDraft,
  t: (key: string) => string,
): ValidationErrors {
  const errors: ValidationErrors = {};
  const id = draft.id.trim();
  if (!id) {
    errors.id = t('teammates.validation.idRequired');
  } else if (!TEAMMATE_ID_RE.test(id) || id.includes('..')) {
    errors.id = t('teammates.validation.idInvalid');
  }
  if (!draft.name.trim()) errors.name = t('teammates.validation.nameRequired');
  if (!draft.prompt.trim()) errors.prompt = t('teammates.validation.promptRequired');
  return errors;
}

function definitionFromDraft(draft: TeammateDraft): TeammateDefinition {
  const model = draft.model.trim();
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    prompt: draft.prompt.trim(),
    ...(model ? { model } : {}),
    tools: parseArrayField(draft.tools),
    plugins: parseArrayField(draft.plugins),
    skills: parseArrayField(draft.skills),
    mcpServers: parseArrayField(draft.mcpServers),
  };
}

function draftFromTeammate(teammate: TeammateRecord): TeammateDraft {
  return {
    id: teammate.id,
    name: teammate.name,
    description: teammate.description || '',
    prompt: teammate.prompt,
    model: teammate.model || '',
    tools: teammate.tools.join('\n'),
    plugins: teammate.plugins.join('\n'),
    skills: teammate.skills.join('\n'),
    mcpServers: teammate.mcpServers.join('\n'),
  };
}

function parseArrayField(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeTeammates(value: unknown): TeammateRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return [];
    const id = entry.id.trim();
    if (!id) return [];
    return [{
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : id,
      description: typeof entry.description === 'string' ? entry.description : '',
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      ...(typeof entry.model === 'string' && entry.model ? { model: entry.model } : {}),
      tools: normalizeStringArray(entry.tools),
      plugins: normalizeStringArray(entry.plugins),
      skills: normalizeStringArray(entry.skills),
      mcpServers: normalizeStringArray(entry.mcpServers),
      relativePath: typeof entry.relativePath === 'string' ? entry.relativePath : '',
      filePath: typeof entry.filePath === 'string' ? entry.filePath : '',
    }];
  });
}

function normalizeDiagnostics(value: unknown): TeammateDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.message !== 'string') return [];
    return [{
      code: typeof entry.code === 'string' ? entry.code : 'UNKNOWN',
      severity: entry.severity === 'warning' ? 'warning' : 'error',
      message: entry.message,
      ...(typeof entry.relativePath === 'string' ? { relativePath: entry.relativePath } : {}),
      ...(typeof entry.field === 'string' ? { field: entry.field } : {}),
    }];
  });
}

function normalizeCatalog(value: Record<string, unknown>): TeammateCatalog {
  return {
    tools: normalizeStringArray(value.tools),
    plugins: normalizeStringArray(value.plugins),
    skills: normalizeStringArray(value.skills),
    mcpServers: normalizeStringArray(value.mcpServers),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())),
  );
}

function extractResponseDiagnostics(data: Record<string, unknown>): TeammateDiagnostic[] {
  const direct = normalizeDiagnostics(data.diagnostics);
  if (direct.length > 0) return direct;
  if (isRecord(data.validation)) return normalizeDiagnostics(data.validation.diagnostics);
  return [];
}

function apiError(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.details === 'string' && data.details.trim()) return data.details;
  if (typeof data.error === 'string' && data.error.trim()) return data.error;
  if (typeof data.message === 'string' && data.message.trim()) return data.message;
  return fallback;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function fieldClass(base: string, error?: string): string {
  return cn(base, error && 'border-destructive focus:border-destructive focus:ring-destructive');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
