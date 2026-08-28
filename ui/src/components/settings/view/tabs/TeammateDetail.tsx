import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ModelRefOption } from '../../../../shared/buildModelRefOptions';
import type {
  TeammateCatalog,
  TeammateDiagnostic,
  TeammateRecord,
} from '../../types/types';
import type {
  DraftField,
  TeammateDraft,
  ValidationErrors,
} from './teammatesShared';
import TeammateDefinitionForm from './TeammateDefinitionForm';

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
  modelOptions,
  onUpdateDraft,
  onSave,
  onBack,
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
  modelOptions: ModelRefOption[];
  onUpdateDraft: (field: DraftField, value: string) => void;
  onSave: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('settings');

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

      <TeammateDefinitionForm
        draft={draft}
        validationErrors={validationErrors}
        serverDiagnostics={serverDiagnostics}
        catalog={catalog}
        catalogUnavailable={catalogUnavailable}
        hasWorkspace={hasWorkspace}
        saving={saving}
        isNew={isNew}
        modelOptions={modelOptions}
        onUpdateDraft={onUpdateDraft}
        onSave={onSave}
        onCancel={onBack}
      />
    </div>
  );
}
