// Mind as a standalone server: serves the built app from dist/ and the same local API as in dev mode.
// No Vite, no hot reload, no file watcher – code changes only take effect after `npm run build` and a restart.
// Start: npm run serve  (port: MIND_PORT or --port, default 5180)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler, onListening } from './api.ts';
import { stopTunnel } from './mcp.ts';
import { tr } from '../core/i18n.ts';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(APP_DIR, 'dist');
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.MIND_PORT ?? 5180);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(tr(`[mind] Gebaute App fehlt (${DIST}). Erst bauen: npm run build`, `[mind] Built app missing (${DIST}). Build first: npm run build`));
  process.exit(1);
}

/** File from dist/ – only inside dist; directories and unknown paths fall back to the map. */
function staticFile(pathname: string): string | null {
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = normalize(join(DIST, rel));
  if (abs !== DIST && !abs.startsWith(DIST + sep)) return null;
  if (existsSync(abs) && statSync(abs).isFile()) return abs;
  return null;
}

const server = createServer((req, res) => {
  void handler(req, res, () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    const url = new URL(req.url ?? '/', 'http://local');
    const file = staticFile(url.pathname);
    if (!file) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end(tr('nicht gefunden', 'not found')); }
    res.statusCode = 200;
    res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    // Files under assets/ carry a hash in the name and may stay cached for a long time; everything else always fresh
    res.setHeader('Cache-Control', url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.method === 'HEAD') return res.end();
    res.end(readFileSync(file));
  }).catch((e) => { if (!res.headersSent) res.statusCode = 500; res.end(String(e)); });
});

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? tr(`[mind] Port ${PORT} ist belegt – läuft Mind schon?`, `[mind] Port ${PORT} is in use – is Mind already running?`) : `[mind] ${String(e)}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(tr(`[mind] ${new Date().toISOString().slice(0, 19)} läuft auf http://127.0.0.1:${PORT}/ (gebaute App, ohne Vite)`, `[mind] ${new Date().toISOString().slice(0, 19)} running on http://127.0.0.1:${PORT}/ (built app, without Vite)`));
  onListening(PORT);
});

// Shut down cleanly: take the tunnel process along so no orphaned cloudflared is left after a restart
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { try { stopTunnel(); } catch { /* */ } server.close(); setTimeout(() => process.exit(0), 300); });
