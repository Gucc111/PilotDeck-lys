import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parse as parseYaml } from 'yaml';
import { authenticatedFetch } from '../../../../utils/api';
import { usePilotDeckConfig } from '../../../../hooks/usePilotDeckConfig';
import { buildModelRefOptions, type ModelRefOption } from '../../../../shared/buildModelRefOptions';
import type {
  SettingsProject,
  TeammateCatalog,
  TeammateDiagnostic,
  TeammateRecord,
} from '../../types/types';
import {
  type DraftField,
  type TeammateDraft,
  type TeammatesView,
  type ValidationErrors,
  EMPTY_DRAFT,
  apiError,
  buildProjectOptions,
  definitionFromDraft,
  draftFromTeammate,
  extractResponseDiagnostics,
  normalizeCatalog,
  normalizeDiagnostics,
  normalizeTeammates,
  readJson,
  validateDraft,
} from './teammatesShared';
import TeammateList from './TeammateList';
import TeammateDetail from './TeammateDetail';

export default function TeammatesTab({ projects = [], onViewChange }: { projects?: SettingsProject[]; onViewChange?: (isListView: boolean) => void }) {
  const { t } = useTranslation('settings');
  const projectOptions = useMemo(() => buildProjectOptions(projects), [projects]);

  const [view, setView] = useState<TeammatesView>({ kind: 'list' });
  const [teammates, setTeammates] = useState<TeammateRecord[]>([]);
  const [definitionDiagnostics, setDefinitionDiagnostics] = useState<TeammateDiagnostic[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [draft, setDraft] = useState<TeammateDraft>(EMPTY_DRAFT);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [serverDiagnostics, setServerDiagnostics] = useState<TeammateDiagnostic[]>([]);

  const [catalogMap, setCatalogMap] = useState<Record<string, TeammateCatalog | null>>({});
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);

  const firstProjectPath = projectOptions[0]?.value ?? '';

  const { raw: configRaw } = usePilotDeckConfig();
  const modelOptions: ModelRefOption[] = useMemo(() => {
    if (!configRaw) return [];
    try {
      const parsed = parseYaml(configRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return buildModelRefOptions(parsed.model?.providers);
      }
    } catch { /* ignore parse errors */ }
    return [];
  }, [configRaw]);

  const loadTeammates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/teammates');
      const data = await readJson(response);
      if (!response.ok) throw new Error(apiError(data, t('teammates.errors.load')));
      setTeammates(normalizeTeammates(data.teammates));
      setDefinitionDiagnostics(normalizeDiagnostics(data.diagnostics));
    } catch (caught) {
      setTeammates([]);
      setDefinitionDiagnostics([]);
      setError(caught instanceof Error ? caught.message : t('teammates.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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

  useEffect(() => {
    onViewChange?.(view.kind === 'list');
  }, [view.kind, onViewChange]);

  useEffect(() => {
    void loadTeammates();
  }, [loadTeammates]);

  useEffect(() => {
    for (const project of projectOptions) {
      void loadCatalog(project.value);
    }
  }, [loadCatalog, projectOptions]);

  const navigateToDetail = (teammate: TeammateRecord) => {
    setView({ kind: 'detail', teammateId: teammate.id });
    setDraft(draftFromTeammate(teammate));
    setValidationErrors({});
    setServerDiagnostics([]);
    setError(null);
    setMessage(null);
  };

  const navigateToNew = () => {
    setView({ kind: 'new' });
    setDraft(EMPTY_DRAFT);
    setValidationErrors({});
    setServerDiagnostics([]);
    setError(null);
    setMessage(null);
  };

  const navigateToList = () => {
    setView({ kind: 'list' });
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
    if (view.kind !== 'detail' && view.kind !== 'new') return;
    const nextErrors = validateDraft(draft, t);
    setValidationErrors(nextErrors);
    setServerDiagnostics([]);
    setError(null);
    setMessage(null);
    if (Object.keys(nextErrors).length > 0) return;

    const definition = definitionFromDraft(draft);
    const routeId = view.kind === 'detail' ? view.teammateId : definition.id;
    setSaving(true);
    try {
      const response = await authenticatedFetch(
        `/api/teammates/${encodeURIComponent(routeId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ definition }),
        },
      );
      const data = await readJson(response);
      if (!response.ok) {
        const responseDiagnostics = extractResponseDiagnostics(data);
        setServerDiagnostics(responseDiagnostics);
        throw new Error(apiError(data, t('teammates.errors.save')));
      }
      await loadTeammates();
      navigateToList();
      setMessage(t('teammates.status.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('teammates.errors.save'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (teammate: TeammateRecord) => {
    if (!window.confirm(t('teammates.confirmDelete', { name: teammate.name }))) {
      return;
    }
    setDeletingId(teammate.id);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch(
        `/api/teammates/${encodeURIComponent(teammate.id)}`,
        { method: 'DELETE' },
      );
      const data = await readJson(response);
      if (!response.ok) throw new Error(apiError(data, t('teammates.errors.delete')));
      if (view.kind === 'detail' && view.teammateId === teammate.id) {
        navigateToList();
      }
      await loadTeammates();
      setMessage(t('teammates.status.deleted'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('teammates.errors.delete'));
    } finally {
      setDeletingId(null);
    }
  };

  const currentTeammate = view.kind === 'detail'
    ? teammates.find((tm) => tm.id === view.teammateId) ?? null
    : null;

  const firstCatalog = catalogMap[firstProjectPath] ?? null;

  if (view.kind === 'list') {
    return (
      <TeammateList
        teammates={teammates}
        loading={loading}
        diagnostics={definitionDiagnostics}
        error={error}
        message={message}
        deletingId={deletingId}
        onSelect={navigateToDetail}
        onNew={navigateToNew}
        onDelete={(teammate) => void remove(teammate)}
        onRefresh={() => void loadTeammates()}
      />
    );
  }

  return (
    <TeammateDetail
      teammate={currentTeammate}
      draft={draft}
      validationErrors={validationErrors}
      serverDiagnostics={serverDiagnostics}
      catalog={firstCatalog}
      catalogUnavailable={catalogUnavailable}
      hasWorkspace={projectOptions.length > 0}
      saving={saving}
      isNew={view.kind === 'new'}
      modelOptions={modelOptions}
      onUpdateDraft={updateDraft}
      onSave={() => void save()}
      onBack={navigateToList}
    />
  );
}
