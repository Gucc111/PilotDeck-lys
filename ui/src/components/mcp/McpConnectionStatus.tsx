import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../utils/api';
import type { McpManagementInput, McpManagementResult } from '../../../../src/mcp/protocol/management';

/** Polling also covers preparation before an Agent Loop or participant stream exists. */
export function McpConnectionStatus({ sessionKey, activationId, participantId, management = false }: { sessionKey?: string | null; activationId?: string; participantId?: string; management?: boolean }) {
  const { t } = useTranslation('settings');
  const [snapshot, setSnapshot] = useState<McpManagementResult>({ statuses: [] });
  const [error, setError] = useState('');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await authenticatedFetch('/api/mcp/connections', { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (!signal?.aborted) { setSnapshot({ statuses: Array.isArray(data.statuses) ? data.statuses : [] }); setError(''); }
    } catch (caught) { if (!signal?.aborted) setError(String((caught as Error).message)); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = setInterval(() => void refresh(controller.signal), 1500);
    return () => { clearInterval(interval); controller.abort(); };
  }, [refresh, sessionKey, activationId, participantId]);
  const act = async (input: McpManagementInput) => {
    try {
      const response = await authenticatedFetch('/api/mcp/connections', { method: 'POST', body: JSON.stringify(input) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setSnapshot(data); setError('');
    } catch (caught) { setError(String((caught as Error).message)); }
  };
  const statuses = snapshot.statuses.filter(status => management || (participantId ? status.owner?.activationId === activationId && status.owner?.participantId === participantId : status.owner?.sessionKey === sessionKey));
  const visible = statuses;
  if (!management && !visible.length && !error) return null;
  return <section aria-label={t('mcpConfig.connections')} className="mcp-connection-status p-3 text-sm" aria-live="polite">
    {management && <strong>{t('mcpConfig.connections')}</strong>}
    {error && <p role="alert">{error}</p>}
    {management && !visible.length && <p>{t('mcpConfig.noConnections')}</p>}
    {visible.map((status, index) => <div key={`${status.resourceId}:${status.owner?.sessionKey}:${index}`} className="my-2 rounded border p-2">
      <p><strong>{status.serverId}</strong> · {t(`mcpConfig.status.${status.state}`)} · {t(`mcpConfig.stage.${status.stage}`)}</p>
      {status.owner && <p>{t('mcpConfig.waiter')}: {status.owner.participantId || status.owner.sessionKey}</p>}
      {status.holders.length > 0 && <p>{t('mcpConfig.holders')}: {status.holders.map(owner => owner.participantId || owner.sessionKey).join(', ')}</p>}
      {status.reason && <p>{status.reason}</p>}
      {status.owner && (status.state === 'waiting_capacity' || status.state === 'waiting_call' || status.state === 'connecting') && <button type="button" onClick={() => void act({ action: 'cancel', owner: status.owner! })}>{t('mcpConfig.cancelWait')}</button>}
      {management && status.owner && <button type="button" disabled={status.busy} onClick={() => void act({ action: 'release', owner: status.owner! })}>{t('mcpConfig.release')}</button>}
      {management && status.state === 'unknown' && <button type="button" onClick={() => void act({ action: 'reset', resourceId: status.resourceId })}>{t('mcpConfig.resetUnknown')}</button>}
    </div>)}
  </section>;
}
