import { type ReactNode } from 'react';
import { AlertTriangle, Loader2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Select, MultiSelect } from '../../../../shared/view/ui';
import type { ModelRefOption } from '../../../../shared/buildModelRefOptions';
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
  modelOptions,
  onUpdateDraft,
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
  modelOptions: ModelRefOption[];
  onUpdateDraft: (field: DraftField, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');

  const modelSelectOptions = [
    { value: '', label: t('teammates.placeholders.model') },
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
        {serverDiagnostics.length > 0 && (
          <DiagnosticList
            title={t('teammates.diagnostics.validation')}
            diagnostics={serverDiagnostics}
          />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('teammates.fields.id')}
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

        <Field label={t('teammates.fields.model')}>
          <Select
            value={draft.model}
            onChange={(v) => onUpdateDraft('model', v)}
            options={modelSelectOptions}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('teammates.fields.maxOutputTokens')}
            error={validationErrors.maxOutputTokens}
          >
            <input
              type="number"
              min={1}
              step={1}
              value={draft.maxOutputTokens}
              onChange={(event) => onUpdateDraft('maxOutputTokens', event.target.value)}
              placeholder={t('teammates.placeholders.maxOutputTokens')}
              className={fieldClass(INPUT_CLASS, validationErrors.maxOutputTokens)}
            />
            <span className="block text-xs leading-5 text-muted-foreground">
              {t('teammates.fields.maxOutputTokensHelp')}
            </span>
          </Field>
          <Field
            label={t('teammates.fields.maxContextTokens')}
            error={validationErrors.maxContextTokens}
          >
            <input
              type="number"
              min={1}
              step={1}
              value={draft.maxContextTokens}
              onChange={(event) => onUpdateDraft('maxContextTokens', event.target.value)}
              placeholder={t('teammates.placeholders.maxContextTokens')}
              className={fieldClass(INPUT_CLASS, validationErrors.maxContextTokens)}
            />
            <span className="block text-xs leading-5 text-muted-foreground">
              {t('teammates.fields.maxContextTokensHelp')}
            </span>
          </Field>
        </div>

        {ARRAY_FIELDS.map((field) => (
          <Field key={field} label={t(`teammates.fields.${field}`)}>
            <MultiSelect
              selected={parseArrayField(draft[field])}
              options={catalog?.[field] ?? []}
              onChange={(values) => onUpdateDraft(field, values.join('\n'))}
              placeholder={t(`teammates.placeholders.${field}`)}
            />
          </Field>
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

function Field({
  label,
  error,
  children,
}: {
  label: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="block text-sm font-medium text-foreground">{label}</span>
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
