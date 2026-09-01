import { type FormEvent, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Network, Square, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TeamState = {
  progress: {
    summary?: string;
    items: Array<{
      id: string;
      subject: string;
      status: string;
      teammateId?: string;
    }>;
  };
  teammates: Array<{
    id: string;
    sessionId: string;
    status: string;
    currentTask?: string;
  }>;
};

type Teammate = TeamState['teammates'][number];

function statusLabel(status: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const key = `team.status.${status}`;
  const map: Record<string, string> = {
    running: 'Running',
    idle: 'Idle',
    failed: 'Failed',
    aborted: 'Aborted',
    not_started: 'Waiting',
  };
  return t(key, { defaultValue: map[status] ?? status });
}

export default function TeamStatusPanel({
  projectPath,
  sessionId,
}: {
  projectPath: string;
  sessionId: string;
}) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(true);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [state, setState] = useState<TeamState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/teammates/state?projectPath=${encodeURIComponent(projectPath)}&sessionId=${encodeURIComponent(sessionId)}`,
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error || `Team state request failed (${response.status})`);
        if (!disposed) {
          setState(body as TeamState);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!disposed) timer = window.setTimeout(load, 2_000);
      }
    };
    void load();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [projectPath, sessionId]);

  const [injectionText, setInjectionText] = useState<Record<string, string>>({});
  const [actionInFlight, setActionInFlight] = useState<Record<string, boolean>>({});

  const handleInject = async (teammateId: string, e: FormEvent) => {
    e.preventDefault();
    const text = injectionText[teammateId]?.trim();
    if (!text) return;
    setActionInFlight((prev) => ({ ...prev, [teammateId]: true }));
    try {
      await fetch(`/api/teammates/${encodeURIComponent(teammateId)}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, sessionId, text }),
      });
      setInjectionText((prev) => ({ ...prev, [teammateId]: '' }));
    } catch { /* next poll will reflect state */ }
    setActionInFlight((prev) => ({ ...prev, [teammateId]: false }));
  };

  const handleAbort = async (teammateId: string) => {
    setActionInFlight((prev) => ({ ...prev, [teammateId]: true }));
    try {
      await fetch(`/api/teammates/${encodeURIComponent(teammateId)}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, sessionId }),
      });
    } catch { /* next poll will reflect state */ }
    setActionInFlight((prev) => ({ ...prev, [teammateId]: false }));
  };

  const active: Teammate[] = state?.teammates.filter((tm) => tm.status === 'running') ?? [];
  const failed: Teammate[] = state?.teammates.filter((tm) => tm.status === 'failed' || tm.status === 'aborted') ?? [];
  const done: Teammate[] = state?.teammates.filter((tm) =>
    tm.status === 'idle' && state!.progress.items.some(
      (item) => item.teammateId === tm.id && item.status === 'completed',
    ),
  ) ?? [];
  const waiting: Teammate[] = state?.teammates.filter((tm) =>
    !active.includes(tm) && !failed.includes(tm) && !done.includes(tm),
  ) ?? [];

  const headerSummary = (): string => {
    const parts: string[] = [];
    if (active.length > 0) parts.push(`${active.length} ${t('team.active', { defaultValue: 'active' })}`);
    if (done.length > 0) parts.push(`${done.length} ${t('team.done', { defaultValue: 'done' })}`);
    if (failed.length > 0) parts.push(`${failed.length} ${t('team.status.failed', { defaultValue: 'Failed' }).toLowerCase()}`);
    if (parts.length === 0) return t('team.idle', { defaultValue: 'idle' });
    return parts.join(' · ');
  };

  return (
    <div className="mx-auto w-full max-w-[720px] px-6 pt-2">
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-neutral-400" />
            : <ChevronRight className="h-3.5 w-3.5 text-neutral-400" />}
          <Network className="h-4 w-4 text-neutral-500" />
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {t('team.statusTitle', { defaultValue: 'Team status' })}
          </span>
          <span className="ml-auto text-[11px] text-neutral-400">
            {headerSummary()}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            {!error && state?.progress.summary && (
              <p className="mb-2 text-[11px] text-neutral-500">{state.progress.summary}</p>
            )}
            {!error && state?.teammates.length === 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {t('team.noTeammates', {
                  defaultValue: 'The current workspace has no enabled and valid Teammate.',
                })}
              </p>
            )}

            {/* Active teammates */}
            {active.length > 0 && (
              <div className="space-y-2">
                {active.map((teammate) => (
                  <div key={teammate.id} className="text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 animate-pulse" />
                      <span className="font-medium text-neutral-700 dark:text-neutral-300">{teammate.id}</span>
                      <span className="text-blue-500">{statusLabel(teammate.status, t)}</span>
                      <button
                        type="button"
                        disabled={actionInFlight[teammate.id]}
                        onClick={() => handleAbort(teammate.id)}
                        className="ml-auto flex items-center gap-0.5 rounded px-1.5 py-0.5 text-red-500 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950"
                        title={t('team.stopTeammate', { defaultValue: 'Stop this teammate' })}
                      >
                        <Square className="h-2.5 w-2.5" />
                        {t('team.stop', { defaultValue: 'Stop' })}
                      </button>
                    </div>
                    {teammate.currentTask && (
                      <p className="mt-0.5 truncate text-neutral-500 pl-5">└ {teammate.currentTask}</p>
                    )}
                    <form onSubmit={(e) => handleInject(teammate.id, e)} className="mt-1 flex gap-1 pl-5">
                      <input
                        type="text"
                        value={injectionText[teammate.id] ?? ''}
                        onChange={(e) => setInjectionText((prev) => ({ ...prev, [teammate.id]: e.target.value }))}
                        placeholder={t('team.injectPlaceholder', { defaultValue: 'Inject a message...' })}
                        className="min-w-0 flex-1 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] dark:border-neutral-700 dark:bg-neutral-800"
                      />
                      <button
                        type="submit"
                        disabled={actionInFlight[teammate.id] || !injectionText[teammate.id]?.trim()}
                        className="flex items-center gap-0.5 rounded bg-blue-500 px-1.5 py-0.5 text-[10px] text-white disabled:opacity-50"
                      >
                        <Send className="h-2.5 w-2.5" />
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            )}

            {/* Failed teammates */}
            {failed.length > 0 && (
              <div className={active.length > 0 ? 'mt-2 space-y-1' : 'space-y-1'}>
                {failed.map((teammate) => (
                  <div key={teammate.id} className="flex items-center gap-2 text-[11px]">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                    <span className="font-medium text-neutral-700 dark:text-neutral-300">{teammate.id}</span>
                    <span className="text-red-500">{statusLabel(teammate.status, t)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Waiting teammates */}
            {waiting.length > 0 && (
              <div className={(active.length > 0 || failed.length > 0) ? 'mt-2 space-y-1' : 'space-y-1'}>
                {waiting.map((teammate) => (
                  <div key={teammate.id} className="flex items-center gap-2 text-[11px]">
                    <span className="h-1.5 w-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                    <span className="text-neutral-500 dark:text-neutral-400">{teammate.id}</span>
                    <span className="text-neutral-400">{statusLabel(teammate.status, t)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Completed teammates - collapsible */}
            {done.length > 0 && (
              <div className={(active.length > 0 || failed.length > 0 || waiting.length > 0) ? 'mt-2' : undefined}>
                <button
                  type="button"
                  onClick={() => setDoneExpanded((value) => !value)}
                  className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                >
                  {doneExpanded
                    ? <ChevronDown className="h-3 w-3" />
                    : <ChevronRight className="h-3 w-3" />}
                  {t('team.completedCount', { count: done.length, defaultValue: `Completed (${done.length})` })}
                </button>
                {doneExpanded && (
                  <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                    {done.map((teammate) => (
                      <span key={teammate.id} className="flex items-center gap-1 truncate text-neutral-500">
                        <Check className="h-3 w-3 shrink-0 text-green-500" />
                        {teammate.id}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
