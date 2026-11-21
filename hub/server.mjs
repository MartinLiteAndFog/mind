// Mind hub: relays the online connector to a Mind on a Mac and lets several Minds share branches.
// No AI, no owner data except shared branches. Zero dependencies (Node >= 20). State: $HUB_DATA/hub.json
//
// Minds connect outbound (long-poll), so no tunnel or domain is needed on the Mac.
//   POST /mcp/<connector-token>     – Claude/ChatGPT connector → forwarded to that Mind
//   POST /v1/hello                  – Mind registers (needs HUB_KEY or a valid invite)
//   GET  /v1/poll                   – Mind fetches jobs (connector calls, questions from partners)
//   POST /v1/done                   – Mind returns a job result
//   POST /v1/shares                 – share a branch · PUT /v1/shares/:id/snapshot · POST /v1/shares/:id/invite
//   POST /v1/join                   – join a shared branch with an invite code
//   GET  /v1/shares                 – own and joined shares (with snapshots of joined ones)
//   POST /v1/shares/:id/ask         – ask a bot of a shared branch · GET /v1/asks/:id – its answer
//   DELETE /v1/shares/:id           – owner stops sharing / member leaves
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.HUB_DATA || '/data';
const FILE = join(DATA, 'hub.json');
const HUB_KEY = process.env.HUB_KEY || '';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_MINDS = Number(process.env.HUB_MAX_MINDS || 50);

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const rid = (p) => `${p}${randomBytes(9).toString('base64url')}`;
const now = () => new Date().toISOString();

// ── persistence ──
let db = { minds: {}, shares: {} };
try { if (existsSync(FILE)) db = { minds: {}, shares: {}, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch (e) { console.error('[hub] state unreadable, starting empty', e); }
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE + '.tmp', JSON.stringify(db)); renameSync(FILE + '.tmp', FILE); }, 300);
}

// ── in-memory job queues (jobs are short-lived; a restart only drops calls in flight) ──
const queues = new Map();   // mindId -> job[]
const pollers = new Map();  // mindId -> res (waiting long-poll)
const waiting = new Map();  // jobId -> { resolve, timer }
const asks = new Map();     // askId -> { status, reply, at, from, to }

function push(mindId, job) {
  const q = queues.get(mindId) ?? []; q.push(job); queues.set(mindId, q);
  const p = pollers.get(mindId);
  if (p) { pollers.delete(mindId); clearTimeout(p.timer); sendJson(p.res, 200, { jobs: queues.get(mindId).splice(0) }); }
}
function call(mindId, job, ms) {
  return new Promise((resolve) => {
    const id = rid('job_'); job.id = id;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ timeout: true }); }, ms);
    waiting.set(id, { resolve, timer });
    push(mindId, job);
  });
}
const online = (m) => m && Date.now() - Date.parse(m.lastSeen || 0) < 90_000;

// ── http helpers ──
function sendJson(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf8'); resolve(t ? JSON.parse(t) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function auth(req) {
  const id = String(req.headers['x-mind-id'] || ''), secret = String(req.headers['x-mind-secret'] || '');
  const m = db.minds[id];
  if (!m || !eq(m.secretHash, sha(secret))) return null;
  m.lastSeen = now();
  return { id, m };
}
function register(b, allowed) {
  const { mindId, secret, name, mcpToken } = b;
  if (!/^[\w-]{8,64}$/.test(mindId || '') || String(secret || '').length < 24) return { error: 'mindId/secret invalid' };
  const m = db.minds[mindId];
  if (m) { if (!eq(m.secretHash, sha(secret))) return { error: 'wrong secret' }; }
  else {
    if (!allowed) return { error: 'registration needs the hub key or an invite code' };
    if (Object.keys(db.minds).length >= MAX_MINDS) return { error: 'hub full' };
    db.minds[mindId] = { secretHash: sha(secret), createdAt: now() };
  }
  const mm = db.minds[mindId];
  if (name) mm.name = String(name).slice(0, 60);
  if (mcpToken) mm.mcpHash = sha(mcpToken);
  mm.lastSeen = now(); save();
  return { ok: true };
}
const shareView = (id, s, mindId) => ({
  id, title: s.title, rootId: s.rootId, owner: db.minds[s.owner]?.name ?? '?', own: s.owner === mindId, ownerOnline: online(db.minds[s.owner]),
  members: s.members.map((x) => db.minds[x]?.name ?? '?'), at: s.at, snapshot: s.owner === mindId ? undefined : s.snapshot,
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://hub');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/health') return sendJson(res, 200, { ok: true, service: 'mind-hub' });

    // Connector: POST /mcp/<token> → that Mind
    if (p.startsWith('/mcp/')) {
      if (req.method === 'GET') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const h = sha(p.slice(5));
      const entry = Object.entries(db.minds).find(([, m]) => m.mcpHash && eq(m.mcpHash, h));
      if (!entry) { res.writeHead(404); return res.end(); }
      const msg = await readBody(req);
      const isNote = !Array.isArray(msg) && (msg?.id === undefined || msg?.id === null);
      if (!online(entry[1])) {
        if (isNote) { res.writeHead(202); return res.end(); }
        return sendJson(res, 200, { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32000, message: 'Mind is offline (the Mac is asleep or Mind is not running).' } });
      }
      const r = await call(entry[0], { kind: 'mcp', msg }, 120_000);
      if (r.timeout) return sendJson(res, 200, { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32000, message: 'Mind did not answer in time.' } });
      if (!r.result) { res.writeHead(202); return res.end(); }
      return sendJson(res, 200, r.result);
    }

    if (!p.startsWith('/v1/')) { res.writeHead(404); return res.end(); }

    if (p === '/v1/hello' && req.method === 'POST') {
      const b = await readBody(req);
      const r = register(b, !!HUB_KEY && eq(sha(b.hubKey || ''), sha(HUB_KEY)));
      return sendJson(res, r.error ? 403 : 200, r);
    }
    if (p === '/v1/join' && req.method === 'POST') {
      const b = await readBody(req);
      const code = String(b.code || '').trim();
      const sid = Object.keys(db.shares).find((k) => db.shares[k].invites?.[sha(code)] && Date.parse(db.shares[k].invites[sha(code)]) > Date.now());
      if (!sid) return sendJson(res, 403, { error: 'invite code unknown or expired' });
      const r = register(b, true);
      if (r.error) return sendJson(res, 403, r);
      const s = db.shares[sid];
      delete s.invites[sha(code)];
      if (s.owner === b.mindId) return sendJson(res, 400, { error: 'that is your own share' });
      if (!s.members.includes(b.mindId)) s.members.push(b.mindId);
      save();
      return sendJson(res, 200, { ok: true, share: shareView(sid, s, b.mindId) });
    }

    const me = auth(req);
    if (!me) return sendJson(res, 401, { error: 'unknown mind' });

    if (p === '/v1/poll' && req.method === 'GET') {
      save();
      const q = queues.get(me.id);
      if (q?.length) return sendJson(res, 200, { jobs: q.splice(0) });
      const old = pollers.get(me.id); if (old) { clearTimeout(old.timer); sendJson(old.res, 200, { jobs: [] }); }
      const timer = setTimeout(() => { if (pollers.get(me.id)?.res === res) pollers.delete(me.id); sendJson(res, 200, { jobs: [] }); }, 25_000);
      pollers.set(me.id, { res, timer });
      req.on('close', () => { if (pollers.get(me.id)?.res === res) { clearTimeout(timer); pollers.delete(me.id); } });
      return;
    }
    if (p === '/v1/done' && req.method === 'POST') {
      const b = await readBody(req);
      const w = waiting.get(b.id);
      if (w) { waiting.delete(b.id); clearTimeout(w.timer); w.resolve({ result: b.result }); }
      return sendJson(res, 200, { ok: true });
    }

    // Shares
    if (p === '/v1/shares' && req.method === 'GET') {
      const list = Object.entries(db.shares).filter(([, s]) => s.owner === me.id || s.members.includes(me.id)).map(([id, s]) => shareView(id, s, me.id));
      return sendJson(res, 200, { shares: list });
    }
    if (p === '/v1/shares' && req.method === 'POST') {
      const b = await readBody(req);
      const existing = Object.entries(db.shares).find(([, s]) => s.owner === me.id && s.rootId === b.rootId);
      if (existing) return sendJson(res, 200, { id: existing[0] });
      if (Object.values(db.shares).filter((s) => s.owner === me.id).length >= 50) return sendJson(res, 400, { error: 'too many shares' });
      const id = rid('sh_');
      db.shares[id] = { owner: me.id, rootId: String(b.rootId || ''), title: String(b.title || '').slice(0, 120), members: [], invites: {}, snapshot: null, at: now() };
      save();
      return sendJson(res, 200, { id });
    }
    const sm = p.match(/^\/v1\/shares\/([\w-]+)(?:\/(snapshot|invite|ask))?$/);
    if (sm) {
      const s = db.shares[sm[1]];
      if (!s) return sendJson(res, 404, { error: 'no such share' });
      const owner = s.owner === me.id, member = s.members.includes(me.id);
      if (!owner && !member) return sendJson(res, 403, { error: 'not your share' });
      if (sm[2] === 'snapshot' && req.method === 'PUT') {
        if (!owner) return sendJson(res, 403, { error: 'owner only' });
        const b = await readBody(req);
        s.snapshot = b.snapshot ?? null; s.title = String(b.title || s.title).slice(0, 120); s.at = now(); save();
        return sendJson(res, 200, { ok: true });
      }
      if (sm[2] === 'invite' && req.method === 'POST') {
        if (!owner) return sendJson(res, 403, { error: 'owner only' });
        const code = `${randomBytes(3).toString('hex')}-${randomBytes(3).toString('hex')}`.toUpperCase();
        s.invites ??= {};
        for (const [k, v] of Object.entries(s.invites)) if (Date.parse(v) < Date.now()) delete s.invites[k];
        s.invites[sha(code)] = new Date(Date.now() + 7 * 864e5).toISOString(); save();
        return sendJson(res, 200, { code, expires: s.invites[sha(code)] });
      }
      if (sm[2] === 'ask' && req.method === 'POST') {
        if (!member) return sendJson(res, 403, { error: 'members ask, the owner works locally' });
        const b = await readBody(req);
        const askId = rid('ask_');
        asks.set(askId, { status: 'running', at: Date.now(), to: s.owner, from: me.id });
        call(s.owner, { kind: 'ask', share: sm[1], nodeId: String(b.nodeId || ''), text: String(b.text || '').slice(0, 20000), from: db.minds[me.id]?.name ?? 'Partner' }, 30 * 60_000)
          .then((r) => asks.set(askId, { ...asks.get(askId), status: r.timeout ? 'timeout' : 'done', reply: r.result?.reply ?? r.result?.error ?? '' }));
        return sendJson(res, 200, { askId, ownerOnline: online(db.minds[s.owner]) });
      }
      if (!sm[2] && req.method === 'DELETE') {
        if (owner) delete db.shares[sm[1]]; else s.members = s.members.filter((x) => x !== me.id);
        save();
        return sendJson(res, 200, { ok: true });
      }
    }
    const am = p.match(/^\/v1\/asks\/([\w-]+)$/);
    if (am && req.method === 'GET') {
      const a = asks.get(am[1]);
      if (!a || a.from !== me.id) return sendJson(res, 404, { error: 'no such question' });
      return sendJson(res, 200, { status: a.status, reply: a.reply ?? null });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 400, { error: String(e.message || e) });
  }
});

// Old answers are dropped after a day
setInterval(() => { for (const [k, a] of asks) if (Date.now() - a.at > 864e5) asks.delete(k); }, 3600_000).unref();
server.listen(PORT, () => console.log(`[hub] listening on ${PORT}, data ${FILE}, ${Object.keys(db.minds).length} minds, ${Object.keys(db.shares).length} shares`));
