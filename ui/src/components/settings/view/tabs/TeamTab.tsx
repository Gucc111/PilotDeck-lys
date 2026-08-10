import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Crown, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';
import type { SettingsProject } from '../../types/types';
import { readJson, isRecord } from './teammatesShared';
import TeammatesTab from './TeammatesTab';
import LeaderDetail from './LeaderTab';

type TeamView = 'list' | 'leader';

export default function TeamTab({ projects = [] }: { projects?: SettingsProject[] }) {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<TeamView>('list');
  const [teammatesInList, setTeammatesInList] = useState(true);
  const [leaderConfigured, setLeaderConfigured] = useState(false);
  const [leaderChecking, setLeaderChecking] = useState(true);

  const checkLeaderStatus = useCallback(async () => {
    setLeaderChecking(true);
    try {
      const response = await authenticatedFetch('/api/leader');
      const data = await readJson(response);
      if (response.ok && isRecord(data.leader)) {
        const leader = data.leader;
        const has = Boolean(
          (typeof leader.prompt === 'string' && leader.prompt) ||
          (typeof leader.model === 'string' && leader.model) ||
          (Array.isArray(leader.tools) && leader.tools.length > 0),
        );
        setLeaderConfigured(has);
      } else {
        setLeaderConfigured(false);
      }
    } catch {
      setLeaderConfigured(false);
    } finally {
      setLeaderChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkLeaderStatus();
  }, [checkLeaderStatus]);

  if (view === 'leader') {
    return (
      <LeaderDetail
        projects={projects}
        onBack={() => {
          setView('list');
          void checkLeaderStatus();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {teammatesInList && (
        <>
          <button
            type="button"
            onClick={() => setView('leader')}
            className="group flex w-full items-center gap-4 rounded-lg border border-border bg-card/60 p-4 text-left transition-colors hover:bg-accent/30"
          >
            <Crown className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {t('team.leaderCard.title')}
                </span>
                {leaderChecking ? (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                ) : (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    leaderConfigured
                      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
                      : 'bg-muted text-muted-foreground'
                  }`}>
                    {leaderConfigured
                      ? t('team.leaderCard.configured')
                      : t('team.leaderCard.notConfigured')}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t('team.leaderCard.description')}
              </p>
            </div>
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>

          <div className="border-t border-border" />
        </>
      )}

      <TeammatesTab
        projects={projects}
        onViewChange={setTeammatesInList}
      />
    </div>
  );
}
