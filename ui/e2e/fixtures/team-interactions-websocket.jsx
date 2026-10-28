// Controlled browser fixture only. No Gateway connection or model execution.
const subscribers = new Set();
const watchedSessions = new Set();
window.__teamFixtureSent = [];
const context = {
  subscribe(handler) { subscribers.add(handler); return () => subscribers.delete(handler); },
  isConnected: true, latestMessage: null, ws: { readyState: WebSocket.OPEN },
  reconnectInfo: { attempt: 0, nextRetryMs: 0, status: 'connected' },
  sendMessage(message) {
    if (!['watch-session', 'unwatch-session'].includes(message.type)) throw new Error(`Read-only fixture sent unexpected command: ${message.type}`);
    window.__teamFixtureSent.push(message);
    if (message.type === 'watch-session') watchedSessions.add(message.sessionId);
    else watchedSessions.delete(message.sessionId);
    return true;
  },
};
window.__teamFixtureEmit = frame => {
  if (frame.type === 'team-participant-message' && !watchedSessions.has(frame.sessionKey || frame.sessionId)) throw new Error('Member streaming requires a root-session watch subscription.');
  for (const handler of [...subscribers]) handler(frame);
};
export const useWebSocket = () => context;
export const useOptionalWebSocket = () => context;
export const WebSocketProvider = ({ children }) => children;
