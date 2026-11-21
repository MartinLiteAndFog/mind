// Mind connector: MCP server (Streamable HTTP, JSON responses) for ChatGPT and claude.ai online.
// Reachable only under /mcp/<secret-key>. Acts on behalf of the owner (like `dg --as owner`).
import { OWNER_ID, OWNER, tr } from '../core/i18n.ts';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DATA_DIR, readState } from './store.ts';
import { dgCommand, startRun, instructionChain, searchText } from './bots.ts';
import { normalize } from '../core/io.ts';
import { starterState } from '../core/seed.ts';
import { nodeById } from '../core/graph.ts';

const SECRETS = join(DATA_DIR, 'secrets.json');

function readSecrets(): Record<string, any> { try { return JSON.parse(readFileSync(SECRETS, 'utf8')); } catch { return {}; } }
function writeSecrets(all: Record<string, any>) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(SECRETS, JSON.stringify(all, null, 2)); chmodSync(SECRETS, 0o600); }

export function connectorToken(): string {
  const all = readSecrets();
  if (!all.connector?.token) { all.connector = { ...(all.connector ?? {}), token: randomBytes(24).toString('hex') }; writeSecrets(all); }
  return all.connector.token;
}
export function rotateToken() { const all = readSecrets(); all.connector = { ...(all.connector ?? {}), token: randomBytes(24).toString('hex') }; writeSecrets(all); return all.connector.token; }

// ───────── Tunnel (cloudflared quick tunnel) ─────────
// The tunnel survives server reloads (code updates): state lives on a process global, otherwise every update gets a new address.
type TS = { proc: ChildProcess | null; url: string; err: string; port?: number; fails?: number; lastOk?: string; urlChangedAt?: string; prevUrl?: string; dog?: ReturnType<typeof setInterval> | null };
const G = globalThis as unknown as { __mindTunnel?: TS };
G.__mindTunnel ??= { proc: null, url: '', err: '' };
const T = G.__mindTunnel;
const fixedCfg = () => { const c = readSecrets().connector ?? {}; return c.cfToken && c.cfHost ? { token: String(c.cfToken), host: String(c.cfHost).replace(/^https?:\/\//, '').replace(/\/.*$/, '') } : null; };
export function tunnelStatus() {
  const enabled = !!readSecrets().connector?.enabled;
  const fx = fixedCfg();
  return { enabled, running: !!T.proc, url: T.url, error: T.err, mcpUrl: T.url ? `${T.url}/mcp/${connectorToken()}` : '', fixed: !!fx, fixedHost: fx?.host ?? '', lastOk: T.lastOk ?? '', fails: T.fails ?? 0, urlChangedAt: T.urlChangedAt ?? '' };
}
export function startTunnel(port: number) {
  T.port = port;
  watchdog();
  if (T.proc && T.proc.exitCode === null) return; // already running (also after a code update)
  T.err = ''; T.url = '';
  const bin = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find((p) => { try { readFileSync(p); return true; } catch { return false; } }) ?? 'cloudflared';
  const fx = fixedCfg();
  // fixed address: named Cloudflare tunnel (token + hostname from the Cloudflare dashboard); otherwise a quick tunnel with a changing address
  const argv = fx ? ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${port}`, '--token', fx.token] : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  const p = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  T.proc = p;
  const setUrl = (u: string) => { if (T.prevUrl && T.prevUrl !== u) T.urlChangedAt = new Date().toISOString(); T.prevUrl = u; T.url = u; };
  if (fx) setUrl(`https://${fx.host}`);
  const scan = (d: Buffer) => { if (fx) return; const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) setUrl(m[0]); };
  p.stdout?.on('data', scan); p.stderr?.on('data', scan);
  p.on('error', (e) => { T.err = tr(`cloudflared nicht startbar: ${e.message}`, `cloudflared cannot be started: ${e.message}`); T.proc = null; });
  p.on('close', (c) => { if (T.proc === p) { T.proc = null; T.url = ''; if (c) T.err = tr(`Tunnel beendet (${c})`, `Tunnel ended (${c})`); } });
}
export function stopTunnel() { T.proc?.kill('SIGTERM'); T.proc = null; T.url = ''; }
/** Watchdog: every 3 min check from outside (via Cloudflare back to us); 2 failures → restart the tunnel. */
async function checkTunnel() {
  if (!readSecrets().connector?.enabled || !T.port) return;
  if (!T.proc) { startTunnel(T.port); return; }
  if (!T.url) return;
  let ok = false;
  try {
    const r = await fetch(`${T.url}/mcp/${connectorToken()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }), signal: AbortSignal.timeout(15_000) });
    ok = r.status < 500;
  } catch { ok = false; }
  if (ok) { T.fails = 0; T.lastOk = new Date().toISOString(); return; }
  T.fails = (T.fails ?? 0) + 1;
  if (T.fails >= 2) { T.fails = 0; stopTunnel(); startTunnel(T.port); }
}
function watchdog() {
  if (T.dog) return;
  T.dog = setInterval(() => { checkTunnel().catch(() => {}); }, 180_000);
  setTimeout(() => checkTunnel().catch(() => {}), 20_000);
}
export function restartTunnel() { stopTunnel(); if (T.port) startTunnel(T.port); return tunnelStatus(); }
export function setFixedTunnel(cfToken: string, cfHost: string) {
  const all = readSecrets(); all.connector = { ...(all.connector ?? {}) };
  if (cfToken && cfHost) { all.connector.cfToken = cfToken.trim(); all.connector.cfHost = cfHost.trim(); } else { delete all.connector.cfToken; delete all.connector.cfHost; }
  writeSecrets(all);
  return restartTunnel();
}
export function setConnector(enabled: boolean, port: number) {
  const all = readSecrets(); all.connector = { ...(all.connector ?? {}), enabled }; writeSecrets(all);
  if (enabled) startTunnel(port); else stopTunnel();
  return tunnelStatus();
}

// ───────── Tools ─────────
const S = () => normalize(readState() ?? starterState());
const dg = async (cmd: string, args: string[] = [], node: string | null = null) =>
  (await dgCommand({ cmd, args, node, actor: OWNER_ID, as: OWNER_ID, mandate: OWNER_ID, thread: '', depth: 0 })).text;

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run: (a: any) => Promise<string> };
const str = (d: string) => ({ type: 'string', description: d });
/** Built per request so tr() sees the current language (normalize() sets it when the state is read). */
const buildTools = (): Tool[] => [
  { name: 'mind_tree', description: tr(`Ganzer Themenbaum von ${OWNER()}s Mind mit Knoten-IDs und Bots.`, `Whole topic tree of ${OWNER()}'s Mind with node ids and bots.`), inputSchema: { type: 'object', properties: {} }, run: () => dg('tree') },
  { name: 'mind_show', description: tr('Stand eines Knotens: Zusammenfassung, Kurzlage, offene Punkte, Unterknoten, Läufe, letzte Gespräche.', 'State of a node: summary, short status, open items, child nodes, runs, latest conversations.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID, z. B. strategien', 'Node id, e.g. strategies')) }, required: ['node'] }, run: (a) => dg('show', [a.node]) },
  { name: 'mind_brief', description: tr('Einstieg für einen Bot-Chat: Stand des Knotens plus Grundregeln und Arbeitsanweisungen (Chefs und eigene). Zu Beginn jedes Bot-Chats aufrufen.', 'Entry point for a bot chat: the node\'s state plus ground rules and work instructions (its bosses\' and its own). Call at the start of every bot chat.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID des Bots', 'Node id of the bot')) }, required: ['node'] },
    run: async (a) => `${await dg('show', [a.node])}\n\n## ${tr('Arbeitsanweisungen', 'Work instructions')}\n${instructionChain(S(), a.node)}` },
  { name: 'mind_search', description: tr('Volltextsuche über alle Knoten (Titel, Zusammenfassung, offene Punkte, Kurzlage, Anweisungen, Notizen) und Gespräche. Tolerant bei Schreibweise (Umlaute, Doppelbuchstaben); mehrere Wörter = alle müssen vorkommen. Vor dem Schreiben suchen, ob es schon einen passenden Knoten gibt.', 'Full-text search across all nodes (title, summary, open items, short status, instructions, notes) and conversations. Tolerant of spelling (umlauts, double letters); several words = all must match. Search before writing to see whether a fitting node already exists.'), inputSchema: { type: 'object', properties: { query: str(tr('Suchbegriff', 'Search term')) }, required: ['query'] },
    run: async (a) => searchText(String(a.query ?? '')) },
  { name: 'mind_messages', description: tr('Gesprächsverlauf eines Knotens/Bots in voller Länge (neueste zuletzt).', 'Full conversation history of a node/bot (newest last).'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), limit: { type: 'number', description: tr('Anzahl, Standard 12', 'Count, default 12') } }, required: ['node'] },
    run: async (a) => S().botMessages.filter((m) => m.to === a.node || m.from === a.node || m.about === a.node).slice(-(a.limit || 12))
      .map((m) => `[${m.at.slice(0, 16).replace('T', ' ')}] ${m.from} → ${m.to}${m.kind !== 'frage' ? ` (${m.kind})` : ''}: ${m.text}`).join('\n\n') || tr('Noch keine Gespräche.', 'No conversations yet.') },
  { name: 'mind_cockpit', description: tr(`${OWNER()}s Cockpit: wo er gebraucht wird (Human Blocker), „Bei OK“ jedes Bots, Autorun-Status. Guter Einstieg am Morgen.`, `${OWNER()}'s cockpit: where they are needed (human blockers), each bot's "On OK", autorun status. Good morning starting point.`), inputSchema: { type: 'object', properties: {} }, run: () => dg('cockpit') },
  { name: 'mind_ok', description: tr('OK geben: der Bot (scope self), die nächste Bot-Ebene darunter (next) oder alle Bots im Bereich (zone) führen ihr „Bei OK“ aus. Ohne node: ganze Karte.', 'Give OK: the bot (scope self), the next bot level below (next) or all bots in the zone (zone) carry out their "On OK". Without node: the whole map.'), inputSchema: { type: 'object', properties: { node: str(tr(`Knoten-ID (leer = ${OWNER()}/ganze Karte)`, `Node id (empty = ${OWNER()}/whole map)`)), scope: { type: 'string', enum: ['self', 'next', 'zone'] } } }, run: (a) => dg('sweep', [a.node ?? OWNER_ID, a.scope ?? (a.node ? 'self' : 'zone')]) },
  { name: 'mind_fill_ok', description: tr('Bots ohne „Bei OK“ legen ihren nächsten Schritt fest (kurzer Lauf, ändert sonst nichts).', 'Bots without an "On OK" set their next step (short run, changes nothing else).'), inputSchema: { type: 'object', properties: { node: str(tr('Bereich, leer = ganze Karte', 'Zone, empty = whole map')) } }, run: (a) => dg('fill-ok', a.node ? [a.node] : []) },
  { name: 'mind_set_ok', description: tr('„Bei OK werde ich …“ eines Bots setzen (max. 8 Wörter).', 'Set a bot\'s "On OK I will …" (max. 8 words).'), inputSchema: { type: 'object', properties: { node: str(tr('Bot-Knoten', 'Bot node')), text: str(tr('nächste Handlung', 'next action')) }, required: ['node', 'text'] }, run: (a) => dg('set-ok', [a.text], a.node) },
  { name: 'mind_blockers_refresh', description: tr(`Alle Bots kurz fragen, ob sie ${OWNER()} brauchen (setzen/aufheben ihre Blocker). Ergebnis danach mit mind_cockpit.`, `Briefly ask all bots whether they need ${OWNER()} (they set/clear their blockers). Then see the result with mind_cockpit.`), inputSchema: { type: 'object', properties: {} }, run: () => dg('blockers') },
  { name: 'mind_block', description: tr(`Human Blocker an einem Knoten setzen: was ${OWNER()} tun muss.`, `Set a human blocker on a node: what ${OWNER()} has to do.`), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), text: str(tr(`was ${OWNER()} tun muss`, `what ${OWNER()} has to do`)) }, required: ['node', 'text'] }, run: (a) => dg('block', [a.text], a.node) },
  { name: 'mind_unblock', description: tr('Human Blocker an einem Knoten aufheben (erledigt).', 'Clear the human blocker on a node (done).'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')) }, required: ['node'] }, run: (a) => dg('unblock', [], a.node) },
  { name: 'mind_autorun', description: tr(`Autorun ein/aus: gibt laufend OKs an alle Bots. idleHours = Stopp nach so vielen Stunden ohne ${OWNER()}s Aktivität (0 = unbegrenzt).`, `Autorun on/off: continuously gives OKs to all bots. idleHours = stop after this many hours without ${OWNER()}'s activity (0 = unlimited).`), inputSchema: { type: 'object', properties: { on: { type: 'boolean' }, idleHours: { type: 'number' } }, required: ['on'] }, run: (a) => dg('auto', [a.on ? 'on' : 'off', ...(a.idleHours !== undefined ? [String(a.idleHours)] : [])]) },
  { name: 'mind_decide', description: tr('Entscheidung mit Begründung an einem Knoten festhalten (kind: entscheidung | annahme | korrektur; Korrektur mit refers = ID der früheren).', 'Record a decision with its reasoning on a node (kind: entscheidung | annahme | korrektur, i.e. decision | assumption | correction; a correction uses refers = id of the earlier one).'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), decision: str(tr('Was entschieden wurde', 'What was decided')), why: str(tr('Begründung, mit Beleg', 'Reasoning, with evidence')), kind: { type: 'string', enum: ['entscheidung', 'annahme', 'korrektur'] }, refers: str(tr('ID einer früheren Entscheidung (bei Korrektur)', 'Id of an earlier decision (for a correction)')) }, required: ['node', 'decision', 'why'] }, run: (a) => dg('decide', [a.decision, a.why, ...(a.kind ? ['--kind', a.kind] : []), ...(a.refers ? ['--refers', a.refers] : [])], a.node) },
  { name: 'mind_decisions', description: tr('Entscheidungsverlauf eines Bereichs (Knoten und Unterknoten) mit IDs, Begründungen und Korrekturen – zum Prüfen früherer Entscheidungen.', 'Decision history of a zone (node and child nodes) with ids, reasoning and corrections – for reviewing earlier decisions.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')) }, required: ['node'] }, run: (a) => dg('decisions', [a.node]) },
  { name: 'mind_files', description: tr('Dateien im Ordner eines Knotens auflisten (Entwürfe, Berichte, CLAUDE.md der Bots …).', 'List the files in a node\'s folder (drafts, reports, the bots\' CLAUDE.md …).'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')) }, required: ['node'] }, run: (a) => dg('files', [a.node]) },
  { name: 'mind_read_file', description: tr('Eine Datei aus dem Ordner eines Knotens lesen (Textdateien, max. 200 KB), z. B. einen Mail-Entwurf eines Bots.', 'Read a file from a node\'s folder (text files, max. 200 KB), e.g. a bot\'s email draft.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), file: str(tr('Dateiname/Pfad aus mind_files', 'File name/path from mind_files')) }, required: ['node', 'file'] }, run: (a) => dg('read', [a.node, a.file]) },
  { name: 'mind_inbox', description: tr('Offene Fragen, die auf einen Chat (dich) warten.', 'Open questions waiting for a chat (you).'), inputSchema: { type: 'object', properties: {} }, run: () => dg('inbox') },
  { name: 'mind_task', description: tr('Vollständiger Auftrag zu einer offenen Inbox-Frage.', 'Full task for an open inbox question.'), inputSchema: { type: 'object', properties: { key: str(tr('Schlüssel aus mind_inbox', 'Key from mind_inbox')) }, required: ['key'] }, run: (a) => dg('task', [a.key]) },
  { name: 'mind_reply', description: tr(`Antwort auf eine Inbox-Frage abgeben – erscheint sofort bei ${OWNER()} in Mind.`, `Submit an answer to an inbox question – appears immediately for ${OWNER()} in Mind.`), inputSchema: { type: 'object', properties: { key: str(tr('Schlüssel', 'Key')), text: str(tr('Antwort', 'Answer')) }, required: ['key', 'text'] }, run: (a) => dg('reply', [a.key, a.text]) },
  { name: 'mind_set_summary', description: tr('Zusammenfassung eines Knotens ersetzen.', 'Replace a node\'s summary.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), text: str(tr('Neue Zusammenfassung', 'New summary')) }, required: ['node', 'text'] }, run: (a) => dg('set-summary', [a.text], a.node) },
  { name: 'mind_set_todos', description: tr('Kurzlage setzen: Punkte als "+Befund → To-do" (3×) und "-Befund → To-do" (2×), To-do mit Verb zuerst, je max. 8 Wörter.', 'Set the short status: items as "+finding → to-do" (3×) and "-finding → to-do" (2×), to-do starting with a verb, max. 8 words each.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), items: { type: 'array', items: { type: 'string' } } }, required: ['node', 'items'] }, run: (a) => dg('set-todos', a.items, a.node) },
  { name: 'mind_add_open', description: tr('Offenen Punkt ergänzen.', 'Add an open item.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), text: str(tr('Punkt', 'Item')) }, required: ['node', 'text'] }, run: (a) => dg('add-open', [a.text], a.node) },
  { name: 'mind_close_open', description: tr('Offenen Punkt Nr. (1-basiert) als erledigt schließen.', 'Close open item no. (1-based) as done.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), nr: { type: 'number' } }, required: ['node', 'nr'] }, run: (a) => dg('close-open', [String(a.nr)], a.node) },
  { name: 'mind_add_child', description: tr('Unterknoten anlegen.', 'Create a child node.'), inputSchema: { type: 'object', properties: { parent: str(tr('Eltern-Knoten-ID', 'Parent node id')), title: str(tr('Titel', 'Title')) }, required: ['parent', 'title'] }, run: (a) => dg('add-child', [a.title], a.parent) },
  { name: 'mind_move', description: tr('Zweig unter einen anderen Knoten verschieben.', 'Move a branch under another node.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), parent: str(tr('neuer Eltern-Knoten', 'new parent node')) }, required: ['node', 'parent'] }, run: (a) => dg('move', [a.node, a.parent]) },
  { name: 'mind_set_plane', description: tr(`Hauptast (direkt unter ${OWNER()}) auf eine Kreis-Ebene legen (1 = erste).`, `Put a main branch (directly under ${OWNER()}) on a circle plane (1 = first).`), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), plane: { type: 'number' } }, required: ['node', 'plane'] }, run: (a) => dg('set-plane', [String(a.plane)], a.node) },
  { name: 'mind_note', description: tr('Arbeitsschritt am Knoten protokollieren.', 'Log a work step on the node.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), text: str(tr('Notiz', 'Note')) }, required: ['node', 'text'] }, run: (a) => dg('note', [a.text], a.node) },
  { name: 'mind_set_instruction', description: tr('Arbeitsanweisung eines Bot-Bereichs ersetzen.', 'Replace the work instruction of a bot zone.'), inputSchema: { type: 'object', properties: { node: str(tr('Knoten-ID', 'Node id')), text: str(tr('Anweisung', 'Instruction')) }, required: ['node', 'text'] }, run: (a) => dg('set-instruction', [a.text], a.node) },
  { name: 'mind_ask_bot', description: tr('Einem Bot in Mind eine Frage/einen Auftrag geben (läuft im Hintergrund; Antwort später mit mind_messages lesen).', 'Give a bot in Mind a question/task (runs in the background; read the answer later with mind_messages).'), inputSchema: { type: 'object', properties: { bot: str(tr('Bot-Knoten-ID', 'Bot node id')), text: str(tr('Frage oder Auftrag', 'Question or task')) }, required: ['bot', 'text'] },
    run: async (a) => {
      if (!nodeById(S(), a.bot)?.isBot) return tr(`${a.bot} ist kein Bot.`, `${a.bot} is not a bot.`);
      const r = await startRun({ nodeId: a.bot, text: a.text, from: OWNER_ID, edgeId: null, depth: 0, via: 'text', viaConnector: true }, false);
      return tr(`Auftrag an ${a.bot} gestartet (${r.id}). Antwort in ein paar Sekunden bis Minuten über mind_messages.`, `Task started for ${a.bot} (${r.id}). Answer in a few seconds to minutes via mind_messages.`);
    } },
];

const instructions = () => tr(`Mind ist ${OWNER()}s Themenbaum mit Bots je Knoten (Quant, Strategien, Apps …). Lies zuerst mind_tree bzw. mind_show. Ändere nur, was ${OWNER()} verlangt; keine erfundenen Zahlen. Kurzlage im Format "+Befund → To-do".`, `Mind is ${OWNER()}'s topic tree with a bot per node (quant, strategies, apps …). Read mind_tree or mind_show first. Only change what ${OWNER()} asks for; no invented numbers. Short status in the format "+finding → to-do".`);

export async function handleMcp(msg: any): Promise<any | null> {
  if (Array.isArray(msg)) { const out = (await Promise.all(msg.map(handleMcp))).filter(Boolean); return out.length ? out : null; }
  const { id, method, params } = msg ?? {};
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (id === undefined || id === null) return null; // notification
  try {
    S(); // reading the state sets the current language/owner for tr()/OWNER()
    const TOOLS = buildTools();
    switch (method) {
      case 'initialize': return ok({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'Mind', version: '1.0.0' }, instructions: instructions() });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const t = TOOLS.find((x) => x.name === params?.name);
        if (!t) return ok({ content: [{ type: 'text', text: tr(`Unbekanntes Werkzeug ${params?.name}`, `Unknown tool ${params?.name}`) }], isError: true });
        const text = await t.run(params?.arguments ?? {});
        return ok({ content: [{ type: 'text', text }], isError: /^dg: /.test(text) });
      }
      case 'resources/list': return ok({ resources: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: tr(`Methode ${method} nicht unterstützt`, `Method ${method} not supported`) } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: String(e) } };
  }
}
