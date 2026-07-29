import { type ReactNode } from 'react';
import { AlertTriangle, Loader2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { TeammateCatalog, TeammateDiagnostic } from '../../types/types';
import {
  type ArrayDraftField,
  type DraftField,
  type TeammateDraft,
  type ValidationErrors,
  ARRAY_FIELDS,
  INPUT_CLASS,
  TEXTAREA_CLASS,
  fieldClass,
  parseArrayField,
} from './teammatesShared';

export default function TeammateDefinitionForm({
  draft,
  validationErrors,
  serverDiagnostics,
  catalog,
  catalogUnavailable,
  hasWorkspace,
  saving,
  isNew,
  onUpdateDraft,
  onAddCatalogValue,
  onSave,
  onCancel,
}: {
  draft: TeammateDraft;
  validationErrors: ValidationErrors;
  serverDiagnostics: TeammateDiagnostic[];
  catalog: TeammateCatalog | null;
  catalogUnavailable: boolean;
  hasWorkspace: boolean;
  saving: boolean;
  isNew: boolean;
  onUpdateDraft: (field: DraftField, value: string) => void;
  onAddCatalogValue: (field: ArrayDraftField, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="space-y-4">
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
              onChange={(event) => onUpdateDraft('id', event.target.value)}
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
              onChange={(event) => onUpdateDraft('name', event.target.value)}
              placeholder={t('teammates.placeholders.name')}
              className={fieldClass(INPUT_CLASS, validationErrors.name)}
            />
          </Field>
        </div>

        <Field label={t('teammates.fields.description')}>
          <textarea
            value={draft.description}
            onChange={(event) => onUpdateDraft('description', event.target.value)}
            placeholder={t('teammates.placeholders.description')}
            rows={2}
            className={TEXTAREA_CLASS}
          />
        </Field>

        <Field label={t('teammates.fields.prompt')} error={validationErrors.prompt}>
          <textarea
            value={draft.prompt}
            onChange={(event) => onUpdateDraft('prompt', event.target.value)}
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
            onChange={(event) => onUpdateDraft('model', event.target.value)}
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
            onChange={(value) => onUpdateDraft(field, value)}
            onAddCatalogValue={(value) => onAddCatalogValue(field, value)}
          />
        ))}

        {!hasWorkspace && (
          <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{t('teammates.catalog.noWorkspace')}</span>
          </div>
        )}

        {hasWorkspace && catalogUnavailable && (
          <div className="flex gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{t('teammates.catalog.manualOnly')}</span>
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t('teammates.actions.cancel')}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {saving ? t('teammates.actions.saving') : t('teammates.actions.save')}
        </Button>
      </div>
    </form>
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
      description={t(
        field === 'tools'
          ? 'teammates.fields.toolsHelp'
          : 'teammates.fields.arrayHelp',
      )}
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
