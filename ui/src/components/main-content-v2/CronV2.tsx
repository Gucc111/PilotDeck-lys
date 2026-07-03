import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import type { CronJobOverview, CronJobsOverviewResponse, Project } from '../../types/app';
import { cn } from '../../lib/utils.js';
import { api } from '../../utils/api';

const POLL_INTERVAL_MS = 15_000;

const COL = {
  title: 'min-w-0 flex-1 max-w-[520px]',
  createdAt: 'w-[150px] shrink-0',
  status: 'w-[140px] shrink-0',
  actions: 'w-[180px] shrink-0',
} as const;

const CRON_STATUS_STYLE: Record<'scheduled' | 'running', string> = {
  scheduled: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  running: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
};

const CRON_STATUS_LABEL: Record<'scheduled' | 'running', { key: string; defaultValue: string }> = {
  scheduled: { key: 'cron.status.scheduled', defaultValue: 'Scheduled' },
  running: { key: 'cron.status.running', defaultValue: 'Running' },
};

type ProjectGroup = {
  displayName: string;
  items: CronJobOverview[];
};

function formatAbsoluteTime(iso: string | number): string {
  const parsed = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function CronV2() {
  const { t } = useTranslation('alwaysOn');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<CronJobOverview[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projectsRes, jobsRes] = await Promise.all([
        api.projects(),
        api.allCronJobs(),
      ]);

      if (!projectsRes.ok) throw new Error(`Projects: HTTP ${projectsRes.status}`);
      if (!jobsRes.ok) throw new Error(`Cron jobs: HTTP ${jobsRes.status}`);

      const projectsPayload = await projectsRes.json() as Project[];
      const jobsPayload = await jobsRes.json() as CronJobsOverviewResponse;
      setProjects(Array.isArray(projectsPayload) ? projectsPayload : []);
      setJobs(Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const grouped = useMemo(() => {
    const projectMap = new Map<string, Project>();
    const projectKeyToName = new Map<string, string>();
    for (const project of projects) {
      projectMap.set(project.name, project);
      projectKeyToName.set(project.name, project.name);
      if (project.fullPath) projectKeyToName.set(project.fullPath, project.name);
    }

    const result = new Map<string, ProjectGroup>();
    for (const job of jobs) {
      if (job.status !== 'scheduled' && job.status !== 'running') continue;

      const projectName = job.projectKey
        ? (projectKeyToName.get(job.projectKey) || job.projectKey)
        : '__unassigned__';
      const project = projectMap.get(projectName);
      const displayName = project?.displayName || (projectName === '__unassigned__'
        ? t('cron.unassigned', { defaultValue: 'Unassigned' })
        : projectName);

      if (!result.has(projectName)) {
        result.set(projectName, { displayName, items: [] });
      }
      result.get(projectName)!.items.push(job);
    }

    for (const group of result.values()) {
      group.items.sort((left, right) => {
        const leftTime = Date.parse(left.createdAt) || 0;
        const rightTime = Date.parse(right.createdAt) || 0;
        return rightTime - leftTime;
      });
    }

    return result;
  }, [jobs, projects, t]);

  const totalItems = useMemo(() => {
    let count = 0;
    for (const group of grouped.values()) count += group.items.length;
    return count;
  }, [grouped]);

  const toggleProject = (key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="w-full space-y-5 px-8 py-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {t('cron.title', { defaultValue: 'Cron' })}
          </h2>
          <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
            {t('cron.subtitle', { defaultValue: 'Scheduled cron jobs across projects.' })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xxs text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
          <span>{t('actions.refresh', { defaultValue: 'Refresh' })}</span>
        </button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 text-xxs text-red-500">
          <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading && totalItems === 0 ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-neutral-500 dark:text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          <span>{t('cron.loading', { defaultValue: 'Loading cron jobs...' })}</span>
        </div>
      ) : totalItems === 0 && !loading ? (
        <div className="py-8 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
          <Clock className="mx-auto mb-2 h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.25} />
          {t('cron.empty', { defaultValue: 'No active cron jobs found.' })}
        </div>
      ) : (
        <div className="space-y-4">
          {[...grouped.entries()].map(([projectKey, group]) => {
            const isCollapsed = collapsedProjects.has(projectKey);
            return (
              <div
                key={projectKey}
                className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
              >
                <button
                  type="button"
                  onClick={() => toggleProject(projectKey)}
                  className="flex w-full items-center gap-2 px-5 py-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                  )}
                  <span className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                    {group.displayName}
                  </span>
                  <span className="ml-auto text-xxs tabular-nums text-neutral-400 dark:text-neutral-500">
                    {group.items.length}
                  </span>
                </button>

                {!isCollapsed && (
                  <>
                    <ColumnHeaders t={t} />
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
                      {group.items.map((job) => (
                        <CronJobRow
                          key={job.id}
                          job={job}
                          t={t}
                          onRefresh={refresh}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ColumnHeaders({ t }: { t: (key: string, opts?: Record<string, string>) => string }) {
  return (
    <div className="flex items-center gap-4 border-b border-neutral-200 bg-neutral-50 px-5 py-2 dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className={COL.title}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.title', { defaultValue: 'Title' })}
        </span>
      </div>
      <div className={COL.createdAt}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.createdAt', { defaultValue: 'Created' })}
        </span>
      </div>
      <div className={COL.status}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.status', { defaultValue: 'Status' })}
        </span>
      </div>
      <div className={COL.actions}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.actions', { defaultValue: 'Actions' })}
        </span>
      </div>
    </div>
  );
}

function CronJobRow({
  job,
  t,
  onRefresh,
}: {
  job: CronJobOverview;
  t: (key: string, opts?: Record<string, string>) => string;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const status = job.status === 'running' ? 'running' : 'scheduled';
  const meta = CRON_STATUS_LABEL[status];

  const runAction = async (action: 'runNow' | 'stop' | 'delete') => {
    if (busy) return;
    setBusy(true);
    try {
      const response = action === 'runNow'
        ? await api.cronRunNow(job.id)
        : action === 'stop'
          ? await api.cronStop(job.id)
          : await api.cronDelete(job.id);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      await onRefresh();
    } catch {
      // The next refresh or global toast surface carries the visible error.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4 px-5 py-2.5 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
      <div className={cn(COL.title, 'truncate text-[13px] text-neutral-900 dark:text-neutral-100')} title={job.prompt || ''}>
        {job.prompt || '—'}
      </div>
      <div className={cn(COL.createdAt, 'font-mono text-xxs tabular-nums text-neutral-500 dark:text-neutral-400')}>
        {formatAbsoluteTime(job.createdAt)}
      </div>
      <div className={COL.status}>
        <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11px] font-medium', CRON_STATUS_STYLE[status])}>
          {t(meta.key, { defaultValue: meta.defaultValue })}
        </span>
      </div>
      <div className={cn(COL.actions, 'flex items-center gap-1.5')}>
        {status === 'running' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction('stop')}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-red-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-red-700 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
            ) : (
              <>
                <Square className="h-3 w-3" strokeWidth={2} />
                {t('cron.actions.stop', { defaultValue: 'Stop' })}
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction('runNow')}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
            ) : (
              <>
                <Play className="h-3 w-3" strokeWidth={2} />
                {t('cron.actions.runNow', { defaultValue: 'Run Now' })}
              </>
            )}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction('delete')}
          className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-neutral-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-red-700 dark:hover:text-red-400"
          title={t('cron.actions.delete', { defaultValue: 'Delete' })}
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
