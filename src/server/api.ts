// Mind server: local API and connector. Used by the Vite dev server (vite.config.ts) and the standalone server (standalone.ts).
import { OWNER_ID, OWNER_ALIASES, tr } from '../core/i18n.ts';
import { migrateOwner, normalize } from '../core/io.ts';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, renameSync } from 'node:fs';
import { readState, writeState, storeSourceFile, safeDataPath, writeTask, listReports, DATA_DIR } from './store.ts';
import { startHub, hubStatus, setHub } from './hub.ts';
import { NODES_DIR, startRun, dgCommand, runs, setApiBase, ensureBin, ensureTestBot, restoreInbox, chatPending, cancelRun, newSection, updateBot, discardPending, listNodeFiles, readNodeFile, nodeFilePath, okCascade, blockerSweep, fillOk, queued, autoStatus, setAuto, autoActive } from './bots.ts';
import { spawn, execFileSync } from 'node:child_process';
import { synth, publicTts, saveTts } from './tts.ts';
import { handleMcp, connectorToken, rotateToken, tunnelStatus, setConnector, startTunnel, restartTunnel, setFixedTunnel } from './mcp.ts';

let serverPort = 5180;
const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Reads the state so the current language is set (normalize does that), then picks the text. */
function t(de: string, en: string): string {
  try { const s = readState(); if (s) normalize(s); } catch { /* keep the current language */ }
  return tr(de, en);
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function send(res: ServerResponse, code: number, data: unknown, type = 'application/json') {
  res.statusCode = code;
  res.setHeader('Content-Type', type);
  res.end(type === 'application/json' ? JSON.stringify(data) : (data as string | Buffer));
}


export const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  const url = new URL(req.url ?? '/', 'http://local');
  // From outside (tunnel) only the connector with its secret key is reachable.
  const external = !LOCAL_HOSTS.test(String(req.headers.host ?? '')) || !!req.headers['cf-ray'];
  const mcpPath = `/mcp/${connectorToken()}`;
  if (external) console.log(`[connector] ${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname === mcpPath ? 'mcp' : url.pathname.slice(0, 40)} ${url.pathname === mcpPath ? 'ok' : t('403 (falscher Pfad/Schlüssel)', '403 (wrong path/key)')}`);
  if (external && url.pathname !== mcpPath) return send(res, 403, { error: t('nicht erlaubt', 'not allowed') });
  if (url.pathname === mcpPath) {
    if (req.method === 'GET') { res.statusCode = 405; res.setHeader('Allow', 'POST'); return res.end(); }
    if (req.method === 'DELETE') { res.statusCode = 200; return res.end(); }
    if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
    let msg: unknown;
    try { msg = JSON.parse((await body(req)).toString('utf8')); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const out = await handleMcp(msg);
    if (!out) { res.statusCode = 202; return res.end(); }
    return send(res, 200, out);
  }
  if (!url.pathname.startsWith('/api/')) return next();
  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, dataDir: DATA_DIR });
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const st = readState();
      return st ? send(res, 200, st) : send(res, 404, { error: t('kein Stand', 'no state') });
    }
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const st = JSON.parse((await body(req)).toString('utf8'));
      const base = url.searchParams.get('force') === '1' ? null : (st.revision ?? 0);
      const r = writeState(st, base);
      return r.ok ? send(res, 200, r) : send(res, 409, r);
    }
    if (url.pathname === '/api/files' && req.method === 'POST') {
      const name = url.searchParams.get('name') ?? 'file';
      return send(res, 200, storeSourceFile(name, await body(req)));
    }
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const abs = safeDataPath(url.searchParams.get('path') ?? '');
      if (!abs || !existsSync(abs)) return send(res, 404, { error: t('nicht gefunden', 'not found') });
      const type = abs.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
      res.statusCode = 200; res.setHeader('Content-Type', type); return res.end(readFileSync(abs));
    }
    if (url.pathname.startsWith('/api/agent/tasks/') && req.method === 'POST') {
      const id = url.pathname.split('/').pop()!;
      const { markdown, task } = JSON.parse((await body(req)).toString('utf8'));
      return send(res, 200, { path: writeTask(id, markdown, task) });
    }
    if (url.pathname === '/api/agent/reports' && req.method === 'GET') return send(res, 200, listReports());
    if (url.pathname === '/api/rev') return send(res, 200, { revision: readState()?.revision ?? 0 });
    if (url.pathname === '/api/bot/run' && req.method === 'POST') {
      const b = JSON.parse((await body(req)).toString('utf8'));
      const r = await startRun({ nodeId: b.nodeId, text: b.text, from: OWNER_ID, threadId: b.threadId ?? null, edgeId: b.edgeId ?? null, depth: 0, via: b.via ?? 'text', about: b.about ?? null, brief: !!b.brief }, !!b.wait);
      return send(res, 200, r);
    }
    if (url.pathname === '/api/hub' && req.method === 'GET') return send(res, 200, hubStatus());
    if (url.pathname === '/api/hub' && req.method === 'PUT') {
      const b = JSON.parse((await body(req)).toString('utf8'));
      try { return send(res, 200, await setHub(String(b.url ?? ''), String(b.key ?? ''), b.enabled !== false)); } catch (e) { return send(res, 400, { error: (e as Error).message }); }
    }
    if (url.pathname === '/api/connector' && req.method === 'GET') return send(res, 200, tunnelStatus());
    if (url.pathname === '/api/connector' && req.method === 'PUT') { const b = JSON.parse((await body(req)).toString('utf8')); if (b.rotate) rotateToken(); if (b.restart) return send(res, 200, restartTunnel()); if (b.cfToken !== undefined) return send(res, 200, setFixedTunnel(String(b.cfToken ?? ''), String(b.cfHost ?? ''))); return send(res, 200, b.enabled === undefined ? tunnelStatus() : setConnector(!!b.enabled, serverPort)); }
    if (url.pathname === '/api/tts/settings' && req.method === 'GET') return send(res, 200, publicTts());
    if (url.pathname === '/api/tts/settings' && req.method === 'PUT') return send(res, 200, saveTts(JSON.parse((await body(req)).toString('utf8'))));
    if (url.pathname === '/api/tts' && req.method === 'POST') {
      const { text } = JSON.parse((await body(req)).toString('utf8'));
      t('', ''); // sets the language for the voice instruction
      const r = await synth(String(text ?? ''));
      if (!r) return send(res, 204, '', 'text/plain');
      if ('error' in r) return send(res, 502, r);
      res.statusCode = 200; res.setHeader('Content-Type', 'audio/mpeg'); return res.end(r.mp3);
    }
    if (url.pathname === '/api/node-files') return send(res, 200, listNodeFiles(url.searchParams.get('id') ?? ''));
    if (url.pathname === '/api/node-raw') {
      // Serve a file raw (PDF/image/HTML) – for viewing and downloading in the node window.
      const fp = nodeFilePath(url.searchParams.get('id') ?? '', url.searchParams.get('path') ?? '');
      if (!fp || !existsSync(fp) || statSync(fp).isDirectory()) return send(res, 404, { error: t('Datei nicht gefunden', 'File not found') });
      const ext = (fp.split('.').pop() ?? '').toLowerCase();
      const types: Record<string, string> = { pdf: 'application/pdf', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json' };
      const name = fp.split('/').pop()!;
      res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'content-disposition': `${url.searchParams.get('dl') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'no-store' });
      return res.end(readFileSync(fp));
    }
    if (url.pathname === '/api/node-file') { const r = readNodeFile(url.searchParams.get('id') ?? '', url.searchParams.get('path') ?? ''); return r.ok ? send(res, 200, r.text, 'text/plain; charset=utf-8') : send(res, 400, { error: r.text }); }
    if (url.pathname === '/api/chat/discard' && req.method === 'POST') { const b = JSON.parse((await body(req)).toString('utf8')); return send(res, 200, { discarded: discardPending(b) }); }
    if (url.pathname === '/api/chat/pending') return send(res, 200, [...chatPending.values()].map((p) => ({ key: p.key, nodeId: p.nodeId, threadId: p.threadId, readonly: p.readonly, createdAt: p.createdAt })));
    if (url.pathname === '/api/open' && req.method === 'POST') {
      // Opens desktop chat apps or chat web pages in the default browser (whitelist only).
      const b = JSON.parse((await body(req)).toString('utf8'));
      if (b.app && ['Claude', 'ChatGPT'].includes(b.app)) { spawn('open', ['-a', b.app], { detached: true, stdio: 'ignore' }).unref(); return send(res, 200, { ok: true }); }
      if (typeof b.url === 'string' && /^(https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com)\/|claude:\/\/|codex:\/\/)/.test(b.url)) {
        if (b.dock && /^https:/.test(b.url) && existsSync('/Applications/Google Chrome.app')) {
          // slim Chrome app window at the right screen edge (acts like a side window next to Mind)
          let w = 1512, h = 982;
          try { const m = execFileSync('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], { encoding: 'utf8' }).match(/(\d+), (\d+)\s*$/); if (m) { w = +m[1]; h = +m[2]; } } catch { /* default size */ }
          const cw = Math.min(620, Math.round(w * 0.4));
          spawn('open', ['-na', 'Google Chrome', '--args', `--app=${b.url}`, `--window-size=${cw},${h - 40}`, `--window-position=${w - cw},25`], { detached: true, stdio: 'ignore' }).unref();
          return send(res, 200, { ok: true, docked: true });
        }
        spawn('open', [b.url], { detached: true, stdio: 'ignore' }).unref();
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: t('Ziel nicht erlaubt', 'Target not allowed') });
    }
    if (url.pathname === '/api/bot/update' && req.method === 'POST') { const b = JSON.parse((await body(req)).toString('utf8')); const r = await updateBot(b.nodeId); return send(res, r ? 200 : 400, r ?? { error: t('kein Bot', 'not a bot') }); }
    if (url.pathname === '/api/bot/new-section' && req.method === 'POST') { const b = JSON.parse((await body(req)).toString('utf8')); newSection(b.nodeId); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/bot/cancel' && req.method === 'POST') { const b = JSON.parse((await body(req)).toString('utf8')); return send(res, 200, { ok: cancelRun(b.runId) }); }
    if (url.pathname === '/api/bot/runs') return send(res, 200, [...runs.values()].slice(-50));
    if (url.pathname === '/api/ok' && req.method === 'POST') { const b = JSON.parse((await body(req)).toString('utf8')); return send(res, 200, okCascade(b.nodeId, ['self', 'next', 'zone'].includes(b.scope) ? b.scope : 'self')); }
    if (url.pathname === '/api/ok-fill' && req.method === 'POST') { const b = JSON.parse((await body(req)).toString('utf8')); return send(res, 200, fillOk(b.nodeId)); }
    if (url.pathname === '/api/blockers/refresh' && req.method === 'POST') { const b = JSON.parse((await body(req)).toString('utf8')); return send(res, 200, blockerSweep(b.nodeId)); }
    if (url.pathname === '/api/auto' && req.method === 'GET') return send(res, 200, { ...autoStatus(), queued: queued() });
    if (url.pathname === '/api/auto' && req.method === 'PUT') { const b = JSON.parse((await body(req)).toString('utf8')); return send(res, 200, setAuto(!!b.on, b.nodeId, b.idleHours)); }
    if (url.pathname === '/api/active' && req.method === 'POST') { autoActive(); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/dg' && req.method === 'POST') {
      const r = await dgCommand(JSON.parse((await body(req)).toString('utf8')));
      return send(res, r.code, r.text, 'text/plain; charset=utf-8');
    }
    return send(res, 404, { error: t('unbekannter Endpunkt', 'unknown endpoint') });
  } catch (e) {
    return send(res, 500, { error: String(e) });
  }
};

/** Once: switch the old root id (e.g. the owner's first name) in the stored state and the folder name to OWNER_ID. */
function migrateStoredOwner() {
  const raw = readState();
  if (!raw || !migrateOwner(raw)) return;
  const root = raw.nodes.find((n: { id: string }) => n.id === OWNER_ID);
  if (root?.agentProfile?.session) root.agentProfile.session = null; // the Claude session was tied to the old folder
  for (const old of OWNER_ALIASES) {
    const from = join(NODES_DIR, old), to = join(NODES_DIR, OWNER_ID);
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  }
  writeState(raw, null);
  console.log('[mind] owner id migrated');
}

export const isLocalHost = (host: unknown) => LOCAL_HOSTS.test(String(host ?? ''));
/** After start: set the API address for the bots, restore tunnel and queues. */
export function onListening(port: number) {
  migrateStoredOwner();
  startHub();
  setApiBase(`http://127.0.0.1:${port}`); serverPort = port;
  if (tunnelStatus().enabled) startTunnel(port);
  ensureBin(); ensureTestBot(); restoreInbox();
}
