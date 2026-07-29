import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PillBar, Pill } from '../../../../shared/view/ui';
import type {
  TeammateCatalog,
  TeammateDiagnostic,
  TeammateRecord,
  TeammateWorkspaceBinding,
} from '../../types/types';
import type {
  ArrayDraftField,
  DraftField,
  ProjectOption,
  TeammateDraft,
  ValidationErrors,
} from './teammatesShared';
import TeammateDefinitionForm from './TeammateDefinitionForm';
import TeammateWorkspacesPanel from './TeammateWorkspacesPanel';

type DetailTab = 'definition' | 'workspaces';

export default function TeammateDetail({
  teammate,
  draft,
  validationErrors,
  serverDiagnostics,
  catalog,
  catalogUnavailable,
  hasWorkspace,
  saving,
  isNew,
  projects,
  workspaceBindingsMap,
  catalogMap,
  workspaceLoadingSet,
  bindingSavingId,
  canonicalProjectKeyMap,
  bindingError,
  onUpdateDraft,
  onAddCatalogValue,
  onSave,
  onBack,
  onSaveBinding,
}: {
  teammate: TeammateRecord | null;
  draft: TeammateDraft;
  validationErrors: ValidationErrors;
  serverDiagnostics: TeammateDiagnostic[];
  catalog: TeammateCatalog | null;
  catalogUnavailable: boolean;
  hasWorkspace: boolean;
  saving: boolean;
  isNew: boolean;
  projects: ProjectOption[];
  workspaceBindingsMap: Record<string, Record<string, TeammateWorkspaceBinding>>;
  catalogMap: Record<string, TeammateCatalog | null>;
  workspaceLoadingSet: Set<string>;
  bindingSavingId: string | null;
  canonicalProjectKeyMap: Record<string, string>;
  bindingError: string | null;
  onUpdateDraft: (field: DraftField, value: string) => void;
  onAddCatalogValue: (field: ArrayDraftField, value: string) => void;
  onSave: () => void;
  onBack: () => void;
  onSaveBinding: (
    projectPath: string,
    teammateId: string,
    binding: TeammateWorkspaceBinding,
  ) => void;
}) {
  const { t } = useTranslation('settings');
  const [tab, setTab] = useState<DetailTab>('definition');

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        {t('teammates.detail.backToList')}
      </button>

      <div>
        <h3 className="text-lg font-semibold text-foreground">
          {isNew ? t('teammates.editor.new') : (teammate?.name ?? draft.name)}
        </h3>
        {!isNew && teammate && (
          <code className="mt-0.5 block text-xs text-muted-foreground">{teammate.id}</code>
        )}
      </div>

      {!isNew && (
        <PillBar>
          <Pill
            isActive={tab === 'definition'}
            onClick={() => setTab('definition')}
          >
            {t('teammates.detail.definitionTab')}
          </Pill>
          <Pill
            isActive={tab === 'workspaces'}
            onClick={() => setTab('workspaces')}
          >
            {t('teammates.detail.workspacesTab')}
          </Pill>
        </PillBar>
      )}

      {(isNew || tab === 'definition') && (
        <TeammateDefinitionForm
          draft={draft}
          validationErrors={validationErrors}
          serverDiagnostics={serverDiagnostics}
          catalog={catalog}
          catalogUnavailable={catalogUnavailable}
          hasWorkspace={hasWorkspace}
          saving={saving}
          isNew={isNew}
          onUpdateDraft={onUpdateDraft}
          onAddCatalogValue={onAddCatalogValue}
          onSave={onSave}
          onCancel={onBack}
        />
      )}

      {!isNew && tab === 'workspaces' && teammate && (
        <TeammateWorkspacesPanel
          teammate={teammate}
          projects={projects}
          workspaceBindingsMap={workspaceBindingsMap}
          catalogMap={catalogMap}
          workspaceLoadingSet={workspaceLoadingSet}
          savingId={bindingSavingId}
          canonicalProjectKeyMap={canonicalProjectKeyMap}
          bindingError={bindingError}
          onSaveBinding={onSaveBinding}
        />
      )}
    </div>
  );
}
