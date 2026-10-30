import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer } from '../ui/node_modules/ws/wrapper.mjs';

const root = path.resolve('docs/testing/reports/2026-10-30-team-cases01-20');
const armFile = path.join(root, 'proxy-arm.json');
const logFile = path.join(root, 'proxy-events.jsonl');
const target = 'http://127.0.0.1:3002';
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let input;
  try { input = JSON.parse(body.toString()); } catch {}
  let arm;
  try { arm = JSON.parse(await fs.readFile(armFile, 'utf8')); } catch {}
  const drop = req.url === '/api/team-library' && input?.action === arm?.action;
  if (drop) await fs.unlink(armFile);
  const upstream = http.request(`${target}${req.url}`, { method: req.method, headers: { ...req.headers, host: '127.0.0.1:3002' } }, response => {
    if (drop) {
      const received = [];
      response.on('data', data => received.push(data));
      response.on('end', async () => {
        let result;
        try { result = JSON.parse(Buffer.concat(received).toString()); } catch {}
        await fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), action: input.action, requestToken: input.requestToken, id: input.id, upstreamStatus: response.statusCode, savedId: result?.id, injectedStatus: 503 })}\n`);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'ACCEPTANCE_RESPONSE_LOST', message: 'Acceptance proxy: the real server completed this request, but its success response was replaced with a controlled 503. Retry the same operation.' } }));
      });
    } else { res.writeHead(response.statusCode, response.headers); response.pipe(res); }
  });
  upstream.on('error', error => { res.writeHead(502); res.end(error.message); });
  upstream.end(body);
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, downstream => {
  const upstream = new WebSocket(`ws://127.0.0.1:3002${req.url}`, { headers: { origin: target } });
  const pending = [];
  downstream.on('message', async (data, binary) => {
    let frame, arm;
    try { frame = JSON.parse(data.toString()); arm = JSON.parse(await fs.readFile(armFile, 'utf8')); } catch {}
    if (['pilotdeck-command', 'queue-input'].includes(frame?.type) && arm?.action === 'drop-accepted-response') {
      await fs.unlink(armFile);
      downstream.dropAcceptedRunId = frame.options?.runId ?? frame.item?.runId ?? frame.item?.options?.runId ?? frame.item?.id;
      await fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), action: arm.action, runId: downstream.dropAcceptedRunId, armed: true })}\n`);
    }
    if (frame?.type === 'pilotdeck-command' && arm?.action === 'submit-before-accept') {
      await fs.unlink(armFile);
      const options = frame.options ?? {};
      const sessionId = options.sessionId ?? options.sessionKey;
      await fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), action: arm.action, frame, forwarded: false })}\n`);
      downstream.send(JSON.stringify({ kind: 'session_created', provider: 'pilotdeck', id: `acceptance-created-${options.runId}`, sessionId, newSessionId: sessionId, sessionKey: sessionId, projectKey: options.projectPath, runId: options.runId, timestamp: new Date().toISOString() }));
      downstream.send(JSON.stringify({ kind: 'error', terminal: true, provider: 'pilotdeck', id: `acceptance-${options.runId}`, sessionId, runId: options.runId, timestamp: new Date().toISOString(), content: 'Acceptance proxy: controlled failure before input acceptance. Retry the retained input.', userHint: 'Acceptance proxy: controlled failure before input acceptance. Retry the retained input.', code: 'ACCEPTANCE_BEFORE_ACCEPT' }));
      return;
    }
    upstream.readyState === WebSocket.OPEN ? upstream.send(data, { binary }) : pending.push([data, binary]);
  });
  upstream.on('open', () => { for (const [data, binary] of pending) upstream.send(data, { binary }); });
  upstream.on('message', async (data, binary) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch {}
    if (frame?.type === 'session-input-accepted' && frame.runId === downstream.dropAcceptedRunId) {
      downstream.dropAcceptedRunId = undefined;
      await fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), action: 'accepted-response-dropped', runId: frame.runId, sessionId: frame.sessionId })}\n`);
      downstream.close(1012, 'Acceptance: response lost after real acceptance');
      return;
    }
    if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
  });
  for (const [a, b] of [[upstream, downstream], [downstream, upstream]]) { a.on('close', () => b.close()); a.on('error', () => b.close()); }
}));
server.listen(3003, '127.0.0.1', () => console.log('Acceptance-only proxy http://127.0.0.1:3003 -> :3002'));
