import { defineConfig, type Plugin } from 'vite';

// The server code is only loaded when a server starts: it sets permanent timers that would otherwise keep `vite build` from ever ending.
const api = () => import('./src/server/api.ts');

// Dev mode (npm run dev). Permanent operation runs via src/server/standalone.ts with the built app (npm run serve).
function localApi(): Plugin {
  return {
    name: 'decision-graph-local-api',
    configureServer: async (s) => {
      const { handler, onListening, isLocalHost } = await api();
      s.middlewares.use(handler);
      // WebSocket (HMR) only locally – drop it immediately when coming through the tunnel
      s.httpServer?.prependListener('upgrade', (req, socket) => {
        if (!isLocalHost(req.headers.host) || req.headers['cf-ray']) socket.destroy();
      });
      s.httpServer?.on('listening', () => {
        const a = s.httpServer?.address();
        if (a && typeof a === 'object') onListening(a.port);
      });
    },
    configurePreviewServer: async (s) => { s.middlewares.use((await api()).handler); },
  };
}

export default defineConfig({
  build: { rollupOptions: { input: { map: 'index.html' } } },
  plugins: [localApi()], server: { host: '127.0.0.1', allowedHosts: ['.trycloudflare.com'] }, preview: { host: '127.0.0.1' } });
