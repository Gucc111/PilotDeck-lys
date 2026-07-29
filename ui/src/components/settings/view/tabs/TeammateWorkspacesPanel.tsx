import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils';
import type {
  TeammateCatalog,
  TeammateRecord,
  TeammateWorkspaceBinding,
} from '../../types/types';
import type { ProjectOption } from './teammatesShared';
import WorkspaceBindingEditor from './WorkspaceBindingEditor';

export default function TeammateWorkspacesPanel({
  teammate,
  projects,
  workspaceBindingsMap,
  catalogMap,
  workspaceLoadingSet,
  savingId,
  canonicalProjectKeyMap,
  bindingError,
  onSaveBinding,
}: {
  teammate: TeammateRecord;
  projects: ProjectOption[];
  workspaceBindingsMap: Record<string, Record<string, TeammateWorkspaceBinding>>;
  catalogMap: Record<string, TeammateCatalog | null>;
  workspaceLoadingSet: Set<string>;
  savingId: string | null;
  canonicalProjectKeyMap: Record<string, string>;
  bindingError: string | null;
  onSaveBinding: (
    projectPath: string,
    teammateId: string,
    binding: TeammateWorkspaceBinding,
  ) => void;
}) {
  const { t } = useTranslation('settings');
  const [expandedWorkspace, setExpandedWorkspace] = useState<string | null>(null);

  if (projects.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t('teammates.workspace.none')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {bindingError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {bindingError}
        </div>
      )}
      {projects.map((project) => {
        const bindings = workspaceBindingsMap[project.value] ?? {};
        const binding = bindings[teammate.id];
        const catalog = catalogMap[project.value] ?? null;
        const loading = workspaceLoadingSet.has(project.value);
        const expanded = expandedWorkspace === project.value;
        const enabled = binding?.enabled ?? false;
        const isCustom = binding?.toolProfile.mode === 'custom';
        const canonicalKey = canonicalProjectKeyMap[project.value];
        const isSaving = savingId === `${project.value}:${teammate.id}`;

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
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    enabled
                      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
                      : 'bg-muted text-muted-foreground',
                  )}>
                    {enabled ? t('teammates.workspacePanel.on') : t('teammates.workspacePanel.off')}
                  </span>
                  {isCustom && (
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                      {t('teammates.bindings.customStatus')}
                    </span>
                  )}
                </div>
                {canonicalKey && (
                  <code className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {canonicalKey}
                  </code>
                )}
              </div>
              {loading && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />}
            </button>

            {expanded && (
              <div className="border-t border-border px-4 py-4">
                {loading ? (
                  <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('teammates.bindings.loading')}
                  </div>
                ) : (
                  <WorkspaceBindingEditor
                    teammate={teammate}
                    binding={binding}
                    catalogTools={catalog?.tools ?? []}
                    saving={isSaving}
                    disabled={savingId !== null}
                    onChange={(nextBinding) =>
                      onSaveBinding(project.value, teammate.id, nextBinding)
                    }
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
