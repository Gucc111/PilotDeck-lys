import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { buildSystemNotification, type SessionNotification } from '../../shared/notifications';
import { notificationWorkerMessage, setSystemBadge, showSystemNotification } from '../lib/systemNotifications';
import { useNotificationPreferences, getNotificationPreferences } from './useNotificationPreferences';
import { syncWebPush } from './useWebPush';

type IndicatorStore = {
  receive: (message: any) => void; markRead: (id: string | null, expectedId?: string) => void;
  readRecords: () => Record<string, { runId: string; unread: boolean }>;
  getSnapshot: () => { unreadSessionIds: Set<string>; processingSessions: Set<string> };
  subscribe: (listener: () => void) => () => void;
};
let pushSync = Promise.resolve();

export function useSystemNotifications({ store, viewedSessionId, scope, subscribe, isConnected, sessionNames }: {
  store: IndicatorStore; viewedSessionId: string | null; scope: string;
  subscribe: (listener: (message: any) => void) => () => void; isConnected: boolean;
  sessionNames?: Record<string, string>;
}) {
  const { preferences, status } = useNotificationPreferences();
  const { i18n } = useTranslation();
  const viewRef = useRef(viewedSessionId);
  viewRef.current = viewedSessionId;
  const languageRef = useRef(i18n.language);
  languageRef.current = i18n.language;
  const namesRef = useRef(sessionNames);
  namesRef.current = sessionNames;
  const serverScope = useRef<string | null>(null);
  const connectedOnce = useRef(false);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    try { seen.current = new Set(JSON.parse(localStorage.getItem(`pilotdeck-notified-v1:${scope}`) || '[]')); }
    catch { seen.current = new Set(); }
  }, [scope]);
  useEffect(() => {
    serverScope.current = null;
    const viewing = (sessionId: string) => sessionId === viewRef.current && document.visibilityState === 'visible' && document.hasFocus();
    const acknowledgeVisible = () => { if (viewRef.current && viewing(viewRef.current)) store.markRead(viewRef.current); };
    const remember = (event: SessionNotification) => {
      const key = JSON.stringify([event.scope, event.sessionId, event.id]);
      const duplicate = seen.current.has(key);
      seen.current.add(key);
      if (seen.current.size > 2048) seen.current.delete(seen.current.values().next().value!);
      try { localStorage.setItem(`pilotdeck-notified-v1:${scope}`, JSON.stringify([...seen.current])); } catch { /* Best effort. */ }
      return duplicate;
    };
    const receive = (event: SessionNotification) => {
      if (!event || typeof event.id !== 'string' || !event.sessionId) return;
      store.receive({ type: 'session-attention', activity: { sessionId: event.sessionId, attentionId: event.id, attentionAt: event.createdAt } });
      const duplicate = remember(event);
      if (viewing(event.sessionId)) { store.markRead(event.sessionId, event.id); return; }
      const prefs = getNotificationPreferences();
      if (!duplicate && prefs.enabled) void showSystemNotification(buildSystemNotification({ ...event, sessionName: namesRef.current?.[event.sessionId] || event.sessionName }, prefs, languageRef.current)).catch(error => console.warn('Notification delivery failed:', error));
    };
    const unsubscribe = subscribe(message => {
      store.receive(message);
      if (message.type === 'session-activity-snapshot' && typeof message.scope === 'string') {
        serverScope.current = message.scope;
        void notificationWorkerMessage('notification:preferences', { preferences: getNotificationPreferences(), scope: message.scope })
          .then(() => notificationWorkerMessage('notification:read', { scope: message.scope,
            records: Object.entries(store.readRecords()).filter(([, value]) => !value.unread).map(([sessionId, value]) => ({ sessionId, id: value.runId })) }))
          .then(() => notificationWorkerMessage('notification:pending', { scope: message.scope }))
          .then(pending => {
            if (Array.isArray(pending)) for (const item of pending) store.receive({ type: 'session-attention', activity: { sessionId: item.sessionId, attentionId: item.id, attentionAt: item.createdAt } });
            acknowledgeVisible();
          }).catch(() => {});
      }
      if (message.type === 'session-notification') { serverScope.current = message.notification.scope; receive(message.notification); }
      // A foreground conversation is already being read.
      if (message.type === 'session-activity') acknowledgeVisible();
    });
    const workerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'notification:context') {
        const data = event.data.data;
        event.ports[0]?.postMessage({ viewed: data?.scope === serverScope.current && viewing(data.sessionId) });
      }
      if (event.data?.type === 'notification:received' && event.data.notification?.scope === serverScope.current) receive(event.data.notification);
    };
    navigator.serviceWorker?.addEventListener('message', workerMessage);
    window.addEventListener('focus', acknowledgeVisible);
    document.addEventListener('visibilitychange', acknowledgeVisible);
    acknowledgeVisible();
    return () => { unsubscribe(); navigator.serviceWorker?.removeEventListener('message', workerMessage);
      window.removeEventListener('focus', acknowledgeVisible); document.removeEventListener('visibilitychange', acknowledgeVisible); };
  }, [store, scope, subscribe]);
  useEffect(() => {
    const sync = () => {
      const snapshot = store.getSnapshot();
      void setSystemBadge(snapshot.unreadSessionIds.size, preferences).catch(() => { /* Unsupported shell or browser. */ });
      if (serverScope.current) void notificationWorkerMessage('notification:read', { scope: serverScope.current,
        records: Object.entries(store.readRecords()).filter(([, value]) => !value.unread).map(([sessionId, value]) => ({ sessionId, id: value.runId })) });
    };
    sync();
    return store.subscribe(sync);
  }, [store, preferences]);
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      await notificationWorkerMessage('notification:preferences', { preferences, scope: serverScope.current });
      const pending = await notificationWorkerMessage('notification:pending', { scope: serverScope.current });
      if (!cancelled && Array.isArray(pending)) for (const item of pending) store.receive({ type: 'session-attention', activity: { sessionId: item.sessionId, attentionId: item.id, attentionAt: item.createdAt } });
      if (!cancelled && viewRef.current && document.visibilityState === 'visible' && document.hasFocus()) store.markRead(viewRef.current);
      pushSync = pushSync.catch(() => {}).then(() => cancelled ? undefined : syncWebPush(preferences, i18n.language));
      await pushSync;
    };
    const safeSync = () => { void sync().catch(error => console.warn('Background notifications unavailable:', error)); };
    safeSync();
    navigator.serviceWorker?.addEventListener('controllerchange', safeSync);
    window.addEventListener('focus', safeSync);
    return () => { cancelled = true; navigator.serviceWorker?.removeEventListener('controllerchange', safeSync); window.removeEventListener('focus', safeSync); };
  }, [preferences, i18n.language, isConnected, status.permission, store]);
  useEffect(() => {
    if (isConnected) { connectedOnce.current = true; return; }
    if (!connectedOnce.current) return;
    const timer = window.setTimeout(() => {
      const now = new Date().toISOString();
      for (const sessionId of store.getSnapshot().processingSessions) {
        const id = `disconnected:${now}`;
        store.receive({ type: 'session-attention', activity: { sessionId, attentionId: id, attentionAt: now } });
        if (sessionId === viewRef.current && document.visibilityState === 'visible' && document.hasFocus()) { store.markRead(sessionId, id); continue; }
        const prefs = getNotificationPreferences();
        if (prefs.enabled) void showSystemNotification(buildSystemNotification({ id, sessionId, sessionName: namesRef.current?.[sessionId], scope: serverScope.current || scope, kind: 'disconnected', createdAt: now }, prefs, languageRef.current)).catch(() => {});
      }
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [isConnected, scope, store]);
  useEffect(() => {
    if (viewedSessionId && document.visibilityState === 'visible' && document.hasFocus()) store.markRead(viewedSessionId);
  }, [viewedSessionId, store]);
  useEffect(() => () => { void setSystemBadge(0, getNotificationPreferences()).catch(() => {}); }, [scope]);
}
