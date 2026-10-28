import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: uiRoot,
  optimizeDeps: { entries: ['e2e/fixtures/team-interactions.html'] },
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  plugins: [{
    name: 'controlled-team-fixture', enforce: 'pre',
    resolveId(source) {
      if (/\/contexts\/WebSocketContext(?:\.tsx)?$/.test(source)) return path.join(uiRoot, 'e2e/fixtures/team-interactions-websocket.jsx');
    },
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.headers.accept?.includes('text/html') && request.url?.startsWith('/team/')) request.url = '/e2e/fixtures/team-interactions.html';
        next();
      });
    },
  }],
});
await server.listen();
server.printUrls();
