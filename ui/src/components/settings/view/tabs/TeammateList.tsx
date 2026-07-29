import { type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Loader2, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { TeammateDiagnostic, TeammateRecord } from '../../types/types';

export default function TeammateList({
  teammates,
  loading,
  diagnostics,
  error,
  message,
  deletingId,
  enabledCounts,
  onSelect,
  onNew,
  onDelete,
  onRefresh,
}: {
  teammates: TeammateRecord[];
  loading: boolean;
  diagnostics: TeammateDiagnostic[];
  error: string | null;
  message: string | null;
  deletingId: string | null;
  enabledCounts: Record<string, number>;
  onSelect: (teammate: TeammateRecord) => void;
  onNew: () => void;
  onDelete: (teammate: TeammateRecord) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('settings');

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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              {t('teammates.actions.refresh')}
            </Button>
            <Button size="sm" onClick={onNew}>
              <Plus className="h-4 w-4" />
              {t('teammates.actions.new')}
            </Button>
          </div>
        </div>
      </div>

      {(error || message) && (
        <Notice tone={error ? 'error' : 'success'}>{error || message}</Notice>
      )}

      {diagnostics.length > 0 && (
        <DiagnosticList
          title={t('teammates.diagnostics.global')}
          diagnostics={diagnostics}
        />
      )}

      {loading ? (
        <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('teammates.loading')}
        </div>
      ) : teammates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {t('teammates.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {teammates.map((teammate) => {
            const wsCount = enabledCounts[teammate.id] ?? 0;
            return (
              <button
                key={`${teammate.id}:${teammate.relativePath || ''}`}
                type="button"
                onClick={() => onSelect(teammate)}
                className="group flex w-full items-center gap-4 rounded-lg border border-border bg-card/60 p-4 text-left transition-colors hover:bg-accent/30"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {teammate.name}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t('teammates.list.toolCount', { count: teammate.tools.length })}
                    </span>
                    {wsCount > 0 && (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-950 dark:text-green-200">
                        {t('teammates.list.workspaceCount', { count: wsCount })}
                      </span>
                    )}
                  </div>
                  <code className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {teammate.id}
                  </code>
                  {teammate.description && (
                    <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {teammate.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(teammate);
                    }}
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
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
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
  tone: 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        tone === 'error' && 'border-destructive/40 bg-destructive/5 text-destructive',
        tone === 'success' && 'border-border bg-card/60 text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}
