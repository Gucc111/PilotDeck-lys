import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';
import type {
  SettingsProject,
  TeammateCatalog,
  TeammateDiagnostic,
  TeammateRecord,
  TeammateWorkspaceBinding,
} from '../../types/types';
import {
  type ArrayDraftField,
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
  normalizeWorkspaceBindings,
  parseArrayField,
  readJson,
  validateDraft,
} from './teammatesShared';
import TeammateList from './TeammateList';
import TeammateDetail from './TeammateDetail';

export default function TeammatesTab({ projects = [] }: { projects?: SettingsProject[] }) {
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

  const [workspaceBindingsMap, setWorkspaceBindingsMap] = useState<
    Record<string, Record<string, TeammateWorkspaceBinding>>
  >({});
  const [catalogMap, setCatalogMap] = useState<Record<string, TeammateCatalog | null>>({});
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const [workspaceLoadingSet, setWorkspaceLoadingSet] = useState<Set<string>>(new Set());
  const [workspaceRevisionMap, setWorkspaceRevisionMap] = useState<Record<string, string>>({});
  const [canonicalProjectKeyMap, setCanonicalProjectKeyMap] = useState<Record<string, string>>({});
  const [bindingSavingId, setBindingSavingId] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);

  const workspaceRequestIds = useRef<Record<string, number>>({});

  const firstProjectPath = projectOptions[0]?.value ?? '';

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

  const loadWorkspaceContext = useCallback(async (projectPath: string) => {
    if (!projectPath) return;
    const requestId = (workspaceRequestIds.current[projectPath] ?? 0) + 1;
    workspaceRequestIds.current[projectPath] = requestId;
    const isCurrentRequest = () =>
      workspaceRequestIds.current[projectPath] === requestId;

    setWorkspaceLoadingSet((prev) => new Set(prev).add(projectPath));
    try {
      const [catalogResult, bindingsResult] = await Promise.allSettled([
        authenticatedFetch(
          `/api/teammates/catalog?projectPath=${encodeURIComponent(projectPath)}`,
          { suppressServerErrorToast: true },
        ),
        authenticatedFetch(
          `/api/teammates/bindings?projectPath=${encodeURIComponent(projectPath)}`,
          { suppressServerErrorToast: true },
        ),
      ]);
      if (!isCurrentRequest()) return;

      if (catalogResult.status === 'fulfilled') {
        const data = await readJson(catalogResult.value);
        if (!isCurrentRequest()) return;
        if (catalogResult.value.ok) {
          const normalized = normalizeCatalog(data);
          setCatalogMap((prev) => ({ ...prev, [projectPath]: normalized }));
          setCatalogUnavailable(false);
        } else {
          setCatalogMap((prev) => ({ ...prev, [projectPath]: null }));
          setCatalogUnavailable(true);
        }
      } else {
        setCatalogMap((prev) => ({ ...prev, [projectPath]: null }));
        setCatalogUnavailable(true);
      }

      if (bindingsResult.status === 'fulfilled') {
        const data = await readJson(bindingsResult.value);
        if (!isCurrentRequest()) return;
        if (!bindingsResult.value.ok) {
          throw new Error(apiError(data, t('teammates.errors.bindingsLoad')));
        }
        const normalized = normalizeWorkspaceBindings(data);
        setWorkspaceBindingsMap((prev) => ({
          ...prev,
          [projectPath]: normalized.bindings,
        }));
        setWorkspaceRevisionMap((prev) => ({
          ...prev,
          [projectPath]: normalized.revision,
        }));
        setCanonicalProjectKeyMap((prev) => ({
          ...prev,
          [projectPath]: normalized.canonicalProjectKey,
        }));
      } else {
        throw bindingsResult.reason;
      }
    } catch (caught) {
      if (!isCurrentRequest()) return;
      setBindingError(
        caught instanceof Error ? caught.message : t('teammates.errors.bindingsLoad'),
      );
    } finally {
      if (isCurrentRequest()) {
        setWorkspaceLoadingSet((prev) => {
          const next = new Set(prev);
          next.delete(projectPath);
          return next;
        });
      }
    }
  }, [t]);

  useEffect(() => {
    void loadTeammates();
  }, [loadTeammates]);

  useEffect(() => {
    for (const project of projectOptions) {
      void loadWorkspaceContext(project.value);
    }
  }, [loadWorkspaceContext, projectOptions]);

  const enabledCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const bindings of Object.values(workspaceBindingsMap)) {
      for (const [id, binding] of Object.entries(bindings)) {
        if (binding.enabled) {
          counts[id] = (counts[id] ?? 0) + 1;
        }
      }
    }
    return counts;
  }, [workspaceBindingsMap]);

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

  const addCatalogValue = (field: ArrayDraftField, value: string) => {
    const values = parseArrayField(draft[field]);
    if (values.includes(value)) return;
    updateDraft(field, [...values, value].join('\n'));
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
      for (const project of projectOptions) {
        void loadWorkspaceContext(project.value);
      }
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
      for (const project of projectOptions) {
        void loadWorkspaceContext(project.value);
      }
      setMessage(t('teammates.status.deleted'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('teammates.errors.delete'));
    } finally {
      setDeletingId(null);
    }
  };

  const saveWorkspaceBinding = async (
    projectPath: string,
    teammateId: string,
    binding: TeammateWorkspaceBinding,
  ) => {
    const expectedRevision = workspaceRevisionMap[projectPath];
    if (!projectPath || bindingSavingId || !expectedRevision) return;
    const savingKey = `${projectPath}:${teammateId}`;
    setBindingSavingId(savingKey);
    setBindingError(null);
    try {
      const response = await authenticatedFetch(
        `/api/teammates/bindings/${encodeURIComponent(teammateId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            projectPath,
            binding,
            expectedRevision,
          }),
        },
      );
      const data = await readJson(response);
      if (!response.ok) {
        if (response.status === 409 && data.code === 'revision_conflict') {
          await loadWorkspaceContext(projectPath);
          setBindingError(t('teammates.errors.revisionConflict'));
          return;
        }
        throw new Error(apiError(data, t('teammates.errors.bindingsSave')));
      }
      const normalized = normalizeWorkspaceBindings(data);
      setWorkspaceBindingsMap((prev) => ({
        ...prev,
        [projectPath]: normalized.bindings,
      }));
      setWorkspaceRevisionMap((prev) => ({
        ...prev,
        [projectPath]: normalized.revision,
      }));
      setCanonicalProjectKeyMap((prev) => ({
        ...prev,
        [projectPath]: normalized.canonicalProjectKey,
      }));
    } catch (caught) {
      setBindingError(
        caught instanceof Error ? caught.message : t('teammates.errors.bindingsSave'),
      );
      await loadWorkspaceContext(projectPath).catch(() => {});
    } finally {
      setBindingSavingId(null);
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
        enabledCounts={enabledCounts}
        onSelect={navigateToDetail}
        onNew={navigateToNew}
        onDelete={(teammate) => void remove(teammate)}
        onRefresh={() => {
          void loadTeammates();
          for (const project of projectOptions) {
            void loadWorkspaceContext(project.value);
          }
        }}
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
      projects={projectOptions}
      workspaceBindingsMap={workspaceBindingsMap}
      catalogMap={catalogMap}
      workspaceLoadingSet={workspaceLoadingSet}
      bindingSavingId={bindingSavingId}
      canonicalProjectKeyMap={canonicalProjectKeyMap}
      bindingError={bindingError}
      onUpdateDraft={updateDraft}
      onAddCatalogValue={addCatalogValue}
      onSave={() => void save()}
      onBack={navigateToList}
      onSaveBinding={(projectPath, teammateId, binding) =>
        void saveWorkspaceBinding(projectPath, teammateId, binding)
      }
    />
  );
}
