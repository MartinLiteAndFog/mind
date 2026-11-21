// Mind ↔ hub: the Mac connects outbound to the hub (long-poll). Carries
//  1) the online connector (Claude/ChatGPT → hub → this Mind's MCP handler) – no tunnel or own domain needed,
//  2) shared branches: own branches are published as snapshots, branches shared by others are mirrored read-only,
//     and bots/owner can ask the bots of a shared branch.
import { randomBytes } from 'node:crypto';
import { readState } from './store.ts';
import { normalize } from '../core/io.ts';
import { starterState } from '../core/seed.ts';
import { nodeById, descendants, children } from '../core/graph.ts';
import { OWNER_ID, OWNER, tr } from '../core/i18n.ts';
import type { GraphState, GraphNode } from '../core/model.ts';
import { readSecrets, writeSecrets, connectorToken, handleMcp } from './mcp.ts';
import { mutate, startRun, listNodeFiles, hiddenFor, addMessage } from './bots.ts';

type HubCfg = { url: string; key?: string; mindId: string; secret: string; enabled: boolean; owned?: Record<string, string>; done?: string[] };
type Mail = { id: string; from: string; fromName: string; kind: 'ask' | 'answer'; share: string; nodeId: string; text: string; replyTo: string | null; ref: string | null; at: string };
type Remote = NonNullable<GraphNode['remote']>;

const G = globalThis as unknown as { __mindHub?: { gen: number; ok: boolean; err: string; lastPoll: string; shares: unknown[] } };
G.__mindHub ??= { gen: 0, ok: false, err: '', lastPoll: '', shares: [] };
const H = G.__mindHub;
const S = () => normalize(readState() ?? starterState());

function cfg(): HubCfg | null {
  const c = readSecrets().hub;
  return c?.url && c?.mindId && c?.secret ? c as HubCfg : null;
}
function saveCfg(patch: Partial<HubCfg>) {
  const all = readSecrets();
  all.hub = { ...(all.hub ?? {}), ...patch };
  writeSecrets(all);
  return all.hub as HubCfg;
}
const base = (c: HubCfg) => c.url.replace(/\/+$/, '');
async function api(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}) {
  const c = cfg(); if (!c) throw new Error(tr('Kein Hub eingerichtet.', 'No hub configured.'));
  const r = await fetch(base(c) + path, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-mind-id': c.mindId, 'x-mind-secret': c.secret },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `hub ${r.status}`);
  return j;
}
const hello = (c: HubCfg, extra: Record<string, unknown> = {}) => { S(); /* sets the owner name */ return { mindId: c.mindId, secret: c.secret, name: OWNER(), mcpToken: connectorToken(), ...extra }; };

export function hubStatus() {
  const c = cfg();
  return { configured: !!c, enabled: !!c?.enabled, url: c?.url ?? '', connected: H.ok, error: H.err, lastPoll: H.lastPoll,
    mcpUrl: c?.enabled ? `${c ? base(c) : ''}/mcp/${connectorToken()}` : '', shares: H.shares };
}

/** Connect to a hub. hubKey is needed for the first registration on a private hub (not when joining via invite). */
export async function setHub(url: string, hubKey = '', enabled = true) {
  const old = cfg();
  if (!/^https?:\/\/[^\s]+$/.test(url.trim())) throw new Error(tr('Hub-Adresse ungültig.', 'Invalid hub address.'));
  const c = saveCfg({ url: url.trim().replace(/\/+$/, ''), key: hubKey || old?.key, mindId: old?.mindId ?? `m${randomBytes(12).toString('hex')}`, secret: old?.secret ?? randomBytes(32).toString('hex'), enabled });
  if (enabled) {
    const r = await fetch(base(c) + '/v1/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hello(c, { hubKey: c.key })), signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { H.err = j.error ?? `hub ${r.status}`; throw new Error(H.err); }
  }
  startHub();
  return hubStatus();
}

// ───────── poll loop ─────────
export function startHub() {
  const gen = ++H.gen; // a newer loop (after reload) stops older ones
  const c = cfg();
  if (!c?.enabled) { H.ok = false; return; }
  let lastHello = 0;
  (async () => {
    while (H.gen === gen && cfg()?.enabled) {
      const cc = cfg()!;
      try {
        if (Date.now() - lastHello > 10 * 60_000) {
          await fetch(base(cc) + '/v1/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hello(cc, { hubKey: cc.key })), signal: AbortSignal.timeout(15_000) });
          lastHello = Date.now();
        }
        const j = await api('/v1/poll', { timeoutMs: 40_000 });
        H.ok = true; H.err = ''; H.lastPoll = new Date().toISOString();
        for (const job of j.jobs ?? []) void handleJob(job);
        for (const m of (j.mail ?? []) as Mail[]) void handleMail(m);
      } catch (e) {
        H.ok = false; H.err = String((e as Error).message ?? e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  // share sync
  const tick = async () => { if (H.gen !== gen) return; try { await syncShares(); } catch (e) { H.err = String((e as Error).message ?? e); } setTimeout(tick, 60_000); };
  setTimeout(tick, 3000);
}

async function done(id: string, result: unknown) {
  try { await api('/v1/done', { json: { id, result } }); } catch { /* hub restarted – the caller times out */ }
}

async function handleJob(job: { id: string; kind: string; msg?: unknown }) {
  if (job.kind === 'mcp') return done(job.id, await handleMcp(job.msg));
  if (job.kind === 'sync') return syncShares().catch(() => {});
}

// ───────── durable mail between Minds ─────────
const busy = new Set<string>();
const pendingAsks = new Map<string, (text: string) => void>(); // ref -> resolver of a waiting remoteRun
const ack = (ids: string[]) => api('/v1/ack', { json: { ids } }).catch(() => {});
function markDone(id: string) { const d = [...(cfg()?.done ?? []), id].slice(-300); saveCfg({ done: d }); }

async function handleMail(m: Mail) {
  if (busy.has(m.id)) return; // still working on it; the hub offers it again later
  if (cfg()?.done?.includes(m.id)) return ack([m.id]);
  busy.add(m.id);
  try {
    if (m.kind === 'ask') {
      let reply: string;
      try { reply = await answerPartner(m.share, m.nodeId, m.text, m.fromName); } catch (e) { reply = tr(`Fehler: ${(e as Error).message}`, `Error: ${(e as Error).message}`); }
      await api('/v1/mail', { json: { kind: 'answer', to: m.from, share: m.share, nodeId: m.nodeId, text: reply, replyTo: m.id, ref: m.ref } });
    } else {
      const wait = m.ref ? pendingAsks.get(m.ref) : undefined;
      if (wait) { pendingAsks.delete(m.ref!); wait(m.text); }
      else { // the question was asked before a restart: record the late answer here
        const nid = mid(m.share, m.nodeId);
        addMessage({ threadId: `thr-hub-${m.share}`, from: nid, to: OWNER_ID, text: m.text, edgeId: null, runId: m.replyTo ?? m.id, kind: 'antwort', via: 'bot', runtime: tr(`Mind von ${m.fromName}`, `${m.fromName}'s Mind`), about: nid });
        mutate((s) => { const n = nodeById(s, nid); if (n) n.lastWorkedAt = new Date().toISOString(); });
      }
    }
    markDone(m.id); await ack([m.id]);
  } finally { busy.delete(m.id); }
}

// ───────── shares: own side ─────────
const ownedRoot = (shareId: string) => Object.entries(cfg()?.owned ?? {}).find(([, v]) => v === shareId)?.[0] ?? null;

/** Publish a branch; returns a one-time invite code (valid 7 days). */
export async function shareBranch(rootId: string): Promise<{ code: string; expires: string; shareId: string }> {
  const s = S(); const n = nodeById(s, rootId);
  if (!n) throw new Error(tr(`Knoten ${rootId} gibt es nicht.`, `Node ${rootId} does not exist.`));
  if (rootId === OWNER_ID) throw new Error(tr('Das Zentrum kann nicht geteilt werden – teile einen Ast.', 'The centre cannot be shared – share a branch.'));
  if (n.remote) throw new Error(tr('Ein gespiegelter Ast kann nicht weitergeteilt werden.', 'A mirrored branch cannot be shared on.'));
  if (n.private || hiddenFor(s, '__partner__', rootId)) throw new Error(tr('Dieser Ast ist privat oder liegt in einem privaten Ast.', 'This branch is private or inside a private branch.'));
  const { id } = await api('/v1/shares', { json: { rootId, title: n.title } });
  saveCfg({ owned: { ...(cfg()?.owned ?? {}), [rootId]: id } });
  await pushSnapshot(rootId, id);
  const inv = await api(`/v1/shares/${id}/invite`, { json: {} }); // a one-time link for someone not yet connected
  mutate((st) => { const x = nodeById(st, rootId); if (x) x.sharedAs = id; });
  return { code: inv.code, expires: inv.expires, shareId: id };
}

export async function unshareBranch(rootId: string) {
  const id = cfg()?.owned?.[rootId];
  if (!id) throw new Error(tr('Dieser Ast ist nicht geteilt.', 'This branch is not shared.'));
  await api(`/v1/shares/${id}`, { method: 'DELETE' });
  const owned = { ...(cfg()?.owned ?? {}) }; delete owned[rootId]; saveCfg({ owned });
  mutate((st) => { const x = nodeById(st, rootId); if (x) delete x.sharedAs; });
}

/** Snapshot of a shared branch: structure, status, decisions, recent conversations, file names – no private sub-branches. */
function snapshotOf(s: GraphState, rootId: string) {
  const ids = [rootId, ...descendants(s, rootId)].filter((id) => !hiddenFor(s, '__partner__', id) && !nodeById(s, id)?.remote);
  const set = new Set(ids);
  const title = (id: string) => (id === OWNER_ID ? OWNER() : id.startsWith('partner:') ? id.slice(8) : nodeById(s, id)?.title ?? id);
  return {
    rootId, owner: OWNER(), at: new Date().toISOString(),
    nodes: ids.map((id) => {
      const n = nodeById(s, id)!;
      const parent = s.edges.find((e) => e.primary && e.to === id)?.from ?? null;
      return {
        id, parent: id === rootId ? null : parent, title: n.title, type: n.type, summary: n.summary, openPoints: n.openPoints,
        todos: n.todos ? { pos: n.todos.pos, neg: n.todos.neg } : null, okNext: n.okNext?.text ?? null, bot: !!n.isBot,
        files: listNodeFiles(id).map((f) => f.path).filter((f) => !/^(CLAUDE|AGENTS)\.md$/.test(f)).slice(0, 40),
        msgs: s.botMessages.filter((m) => m.to === id || m.from === id).slice(-6).map((m) => ({ at: m.at, from: title(m.from), text: m.text.slice(0, 1500) })),
      };
    }),
    decisions: s.decisions.filter((d) => set.has(d.nodeId)).slice(-30).map((d) => ({ nodeId: d.nodeId, date: d.date, kind: d.kind, content: d.content, rationale: d.rationale })),
  };
}
async function pushSnapshot(rootId: string, shareId: string) {
  const s = S(); const n = nodeById(s, rootId);
  if (!n) return;
  await api(`/v1/shares/${shareId}/snapshot`, { method: 'PUT', json: { title: n.title, snapshot: snapshotOf(s, rootId) } });
}

/** A partner asks a bot of one of our shared branches. Runs like a connector call: own node folder only, no sending. */
async function answerPartner(shareId: string, nodeId: string, text: string, from: string): Promise<string> {
  const rootId = ownedRoot(shareId);
  if (!rootId) throw new Error('share not found');
  const s = S();
  const inShare = nodeId === rootId || descendants(s, rootId).includes(nodeId);
  if (!inShare || hiddenFor(s, '__partner__', nodeId)) throw new Error(tr('Dieser Knoten gehört nicht zum geteilten Ast.', 'This node is not part of the shared branch.'));
  // nearest bot at or above the node, but inside the shared branch
  let bot: string | null = nodeId;
  while (bot && !nodeById(s, bot)?.isBot) { bot = bot === rootId ? null : s.edges.find((e) => e.primary && e.to === bot)?.from ?? null; }
  if (!bot) throw new Error(tr('In diesem geteilten Ast arbeitet kein Bot.', 'No bot works in this shared branch.'));
  const r = await startRun({ nodeId: bot, text, from: `partner:${from}`, edgeId: null, depth: 1, via: 'bot', about: nodeId !== bot ? nodeId : null, viaConnector: true }, true);
  return r.reply ?? r.error ?? '';
}

// ───────── shares: partner side (mirror) ─────────
const mid = (shareId: string, id: string) => `x${shareId.replace(/^sh_/, '').slice(0, 8)}-${id}`;

export async function joinShare(code: string) {
  const c = cfg(); if (!c) throw new Error(tr('Erst einen Hub verbinden (Regeln → Hub).', 'Connect a hub first (Rules → Hub).'));
  const r = await fetch(base(c) + '/v1/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hello(c, { code })), signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `hub ${r.status}`);
  if (!c.enabled) saveCfg({ enabled: true });
  startHub();
  await syncShares();
  return j.share as { id: string; title: string; owner: string };
}

export async function leaveShare(shareId: string) {
  await api(`/v1/shares/${shareId}`, { method: 'DELETE' });
  await syncShares();
}

export async function syncShares() {
  const c = cfg(); if (!c?.enabled) return;
  for (const [rootId, id] of Object.entries(c.owned ?? {})) { try { await pushSnapshot(rootId, id); } catch { /* next round */ } }
  const { shares } = await api('/v1/shares');
  H.shares = shares.map((x: Record<string, unknown>) => ({ ...x, snapshot: undefined }));
  const joined = (shares as { id: string; own: boolean; owner: string; ownerOnline: boolean; title: string; snapshot: ReturnType<typeof snapshotOf> | null }[]).filter((x) => !x.own);
  mutate((s) => {
    // drop mirrors that are gone, then rebuild the current ones
    const keep = new Set(joined.map((x) => x.id));
    const stale = s.nodes.filter((n) => n.remote && !keep.has(n.remote.share)).map((n) => n.id);
    for (const j of joined) if (j.snapshot) stale.push(...s.nodes.filter((n) => n.remote?.share === j.id).map((n) => n.id));
    const gone = new Set(stale);
    s.nodes = s.nodes.filter((n) => !gone.has(n.id));
    s.edges = s.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    for (const j of joined) {
      const snap = j.snapshot; if (!snap) continue;
      for (const sn of snap.nodes) {
        const remote: Remote = { share: j.id, origin: j.owner, origId: sn.id, bot: sn.bot, online: j.ownerOnline, at: snap.at, files: sn.files, msgs: sn.msgs };
        s.nodes.push({
          id: mid(j.id, sn.id), title: sn.parent ? sn.title : tr(`${sn.title} (von ${j.owner})`, `${sn.title} (from ${j.owner})`), type: sn.type, summary: sn.summary,
          openPoints: sn.openPoints ?? [], sourceIds: [], lastWorkedAt: snap.at, createdAt: snap.at,
          ...(sn.todos ? { todos: { ...sn.todos, at: snap.at, by: j.owner } } : {}),
          ...(sn.okNext ? { okNext: { text: sn.okNext, at: snap.at, by: j.owner } } : {}),
          remote,
        });
        const parent = sn.parent ? mid(j.id, sn.parent) : OWNER_ID;
        s.edges.push({ id: `${parent}>${mid(j.id, sn.id)}`, from: parent, to: mid(j.id, sn.id), type: 'GETEILT', sourceIds: [], primary: true });
      }
    }
  });
}

/** Ask the bot of a mirrored node (partner side). The question is stored at the hub until the other Mind picks it up;
 *  resolves with the answer, or after 30 min with null (the answer is then recorded whenever it arrives). */
export async function askRemote(nodeId: string, text: string, onWait: () => void = () => {}): Promise<string | null> {
  const s = S(); const n = nodeById(s, nodeId);
  if (!n?.remote) throw new Error('not a mirrored node');
  const ref = `r${randomBytes(8).toString('hex')}`;
  const got = new Promise<string>((res) => pendingAsks.set(ref, res));
  const r = await api('/v1/mail', { json: { kind: 'ask', share: n.remote.share, nodeId: n.remote.origId, text, ref } });
  if (!r.online) onWait();
  const late = new Promise<null>((res) => setTimeout(() => { pendingAsks.delete(ref); res(null); }, 30 * 60_000));
  return Promise.race([got, late]);
}

// ───────── connections ─────────
export async function connectLink() {
  const r = await api('/v1/connect-invite', { json: {} });
  return { link: `${base(cfg()!)}#${r.code}`, expires: r.expires as string };
}
export async function contacts(): Promise<{ id: string; name: string; online: boolean }[]> {
  return (await api('/v1/contacts')).contacts;
}
export async function removeContact(id: string) { await api(`/v1/contacts/${id}`, { method: 'DELETE' }); await syncShares(); }

/** Accept a link from another Mind: a connection link (…#C…) or a share invitation (…#CODE). */
export async function acceptLink(input: string) {
  const [u, code] = input.includes('#') ? input.trim().split('#') : ['', input.trim()];
  if (!code) throw new Error(tr('Link fehlt.', 'Link missing.'));
  if (u && hubStatus().url !== u.replace(/\/+$/, '')) await setHub(u, '', false);
  if (!code.startsWith('C')) return { share: await joinShare(code) };
  const c = cfg(); if (!c) throw new Error(tr('Kein Hub.', 'No hub.'));
  const r = await fetch(base(c) + '/v1/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hello(c, { code })), signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `hub ${r.status}`);
  if (!c.enabled) saveCfg({ enabled: true });
  startHub(); await syncShares();
  return { peer: j.peer as { id: string; name: string } };
}

/** Share a branch with connections (replaces the member list). */
export async function shareWith(rootId: string, mindIds: string[]) {
  let id = cfg()?.owned?.[rootId];
  if (!id && mindIds.length) id = (await shareBranch(rootId)).shareId;
  if (!id) return;
  const { shares } = await api('/v1/shares');
  const cur: string[] = shares.find((x: { id: string }) => x.id === id)?.memberIds ?? [];
  for (const m of mindIds) if (!cur.includes(m)) await api(`/v1/shares/${id}/members`, { json: { mindId: m } });
  for (const m of cur) if (!mindIds.includes(m)) await api(`/v1/shares/${id}/members/${m}`, { method: 'DELETE' });
  if (!mindIds.length) await unshareBranch(rootId);
  await syncShares();
}

export const isMirror = (s: GraphState, id: string) => !!nodeById(s, id)?.remote;
export const mirrorChildren = (s: GraphState, id: string) => children(s, id).filter((c) => !!nodeById(s, c)?.remote);
