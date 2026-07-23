import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TeamState = {
  progress: {
    summary?: string;
    items: Array<{
      id: string;
      content: string;
      status: string;
      teammateId?: string;
      summary?: string;
    }>;
  };
  teammates: Array<{
    id: string;
    sessionId: string;
    status: string;
    currentTask?: string;
  }>;
};

export default function TeamStatusPanel({
  projectPath,
  sessionId,
}: {
  projectPath: string;
  sessionId: string;
}) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(true);
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
            {state?.teammates.filter((teammate) => teammate.status === 'running').length ?? 0}
            {' '}
            {t('team.running', { defaultValue: 'running' })}
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
                  defaultValue: 'No Teammates are configured in this workspace.',
                })}
              </p>
            )}
            <div className="space-y-1.5">
              {state?.teammates.map((teammate) => (
                <div key={teammate.id} className="flex items-start gap-2 text-[11px]">
                  <span className={`mt-1 h-1.5 w-1.5 rounded-full ${
                    teammate.status === 'running'
                      ? 'bg-blue-500'
                      : teammate.status === 'failed'
                        ? 'bg-red-500'
                        : teammate.status === 'idle'
                          ? 'bg-green-500'
                          : 'bg-neutral-400'
                  }`} />
                  <div className="min-w-0">
                    <span className="font-medium text-neutral-700 dark:text-neutral-300">{teammate.id}</span>
                    <span className="ml-2 text-neutral-400">{teammate.status}</span>
                    {teammate.currentTask && (
                      <p className="truncate text-neutral-500">{teammate.currentTask}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {state && state.progress.items.length > 0 && (
              <div className="mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
                {state.progress.items.map((item) => (
                  <p key={item.id} className="truncate text-[11px] text-neutral-500">
                    [{item.status}] {item.content}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
