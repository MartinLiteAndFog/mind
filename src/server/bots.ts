// Bot runtime: runs a node bot as a local agent process (claude / codex / test).
// Bots work in data/nodes/<id>/ (own CLAUDE.md / AGENTS.md) and change the graph only via `dg`.
import { askRemote, shareBranch, unshareBranch, leaveShare, hubStatus, setHub, syncShares, connectLink, contacts, removeContact, acceptLink, shareWith } from './hub.ts';
import { OWNER_ID, OWNER_ALIASES, ownerIdOf, isOwnerId, tr, OWNER } from '../core/i18n.ts';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { zepEnabled, personEnsure, personAdd, personContext, personDelete, parseTalk, legacyDelete } from './zep.ts';
import { DATA_DIR, readState, writeState } from './store.ts';
import { normalize } from '../core/io.ts';
import { starterState } from '../core/seed.ts';
import { nodeById, children, ancestors, descendants, addChild, touch, runsUnder, fmtEur, fmtPct, removeBranch, restoreBranch } from '../core/graph.ts';
import { now, defaultUpdatePrompt, DEFAULT_OK_POOL, okDay, planeName, type GraphState, type BotMessage, type BotMember } from '../core/model.ts';

export const NODES_DIR = process.env.DG_BOT_HOME ?? join(DATA_DIR, 'nodes');
/** Quant repo for the "read" access level (read-only commands). */
const REPO_DIR = process.env.DG_REPO_DIR ?? '';
/** Access level "read": whole home folder read-only (writing stays limited to the bot folder). */
const HOME_DIR = process.env.DG_READ_ROOT ?? (process.env.HOME ?? '/');
/** App code (live installation) that bots may work on on behalf of the owner. */
const APP_CODE = process.env.DG_APP_DIR ?? resolve(DATA_DIR, '..', 'app');
const BIN_DIR = join(DATA_DIR, 'bin');
const MAX_DEPTH = 3; // max. chain: bot asks bot asks bot
export const updatePromptOf = (s: GraphState) => s.updatePrompt?.trim() || defaultUpdatePrompt();
const TIMEOUT_MS = Number(process.env.DG_BOT_TIMEOUT_MIN ?? 45) * 60_000; // Opus sometimes needs > 6 min for larger tasks

/** Reader-facing labels for stored data values (the stored values themselves stay German). */
const kindLabel = (k: string) => tr(k, ({ vorschlag: 'proposal', antwort: 'answer', fehler: 'error', frage: 'question' } as Record<string, string>)[k] ?? k);
const decLabel = (k: string) => tr(k, ({ entscheidung: 'decision', annahme: 'assumption', korrektur: 'correction' } as Record<string, string>)[k] ?? k);
const statusLabel = (k: string) => tr(k, ({ 'läuft': 'running', fertig: 'done', fehlgeschlagen: 'failed' } as Record<string, string>)[k] ?? k);

export type Runtime = 'claude' | 'codex' | 'test' | 'chat';

export interface RunInfo {
  id: string; nodeId: string; from: string; threadId: string; edgeId: string | null; depth: number;
  status: 'läuft' | 'fertig' | 'fehlgeschlagen'; runtime: Runtime; model: string; startedAt: string; endedAt?: string;
  reply?: string; error?: string;
  steps: { at: string; text: string }[];
}

export const runs = new Map<string, RunInfo>();
const procs = new Map<string, Set<import('node:child_process').ChildProcess>>();
const cancelled = new Set<string>();

/** New conversation section: the bot summarizes (in CLAUDE.md), then a fresh session starts. */
export async function newSection(nodeId: string): Promise<RunInfo | null> {
  const s = normalize(readState() ?? starterState());
  const n = nodeById(s, nodeId);
  if (!n?.isBot) return null;
  const run = await startRun({ nodeId, from: OWNER_ID, edgeId: null, depth: 0, via: 'vorlage',
    text: tr('Schließe den aktuellen Gesprächsabschnitt ab: Schreibe in deine CLAUDE.md unter „## Gesprächsabschnitte“ eine Zusammenfassung (5–8 Stichpunkte: Ergebnisse, Entscheidungen, offene Fragen). Aktualisiere die Kurzlage, falls nötig. Antworte kurz.', 'Close the current conversation section: write a summary in your CLAUDE.md under "## Conversation sections" (5–8 bullet points: results, decisions, open questions). Update the short status if needed. Answer briefly.') }, true);
  mutate((st) => {
    const pr = nodeById(st, nodeId)?.agentProfile;
    if (pr) { pr.session = null; pr.section = (pr.section ?? 1) + 1; }
    touch(st, nodeId, 'bot', tr('Neuer Gesprächsabschnitt begonnen.', 'New conversation section started.'));
  });
  return run;
}

export async function updateBot(nodeId: string): Promise<RunInfo | null> {
  const s = normalize(readState() ?? starterState());
  if (!nodeById(s, nodeId)?.isBot) return null;
  return startRun({ nodeId, text: updatePromptOf(s), from: OWNER_ID, edgeId: null, depth: 0, via: 'vorlage', update: true }, false);
}

export function cancelRun(runId: string): boolean {
  const info = runs.get(runId);
  if (!info || info.status !== 'läuft') return false;
  cancelled.add(runId);
  for (const p of procs.get(runId) ?? []) p.kill('SIGTERM');
  for (const [k, c] of chatPending) if (k.startsWith(runId)) { chatPending.delete(k); rmSync(join(INBOX_DIR, `${k}.md`), { force: true }); rmSync(join(INBOX_DIR, `${k}.json`), { force: true }); c.resolve(tr('(abgebrochen)', '(cancelled)')); }
  return true;
}

/** Clean up orphaned chat questions: the bot no longer has a chat model, is no longer a bot, or the node is gone. */
export function sweepOrphanChats(): number {
  let n = 0;
  try {
    const raw = readState(); if (!raw) return 0; const st = normalize(raw);
    for (const [k, c] of [...chatPending]) {
      const node = nodeById(st, c.nodeId);
      const hasChat = !!node?.isBot && (node.agentProfile?.members ?? []).some((m) => m.runtime === 'chat');
      if (!hasChat) n += discardPending({ key: k });
    }
  } catch { /* state not readable right now – next pass */ }
  return n;
}
{ const g = globalThis as unknown as { __mindOrphanSweep?: ReturnType<typeof setInterval> }; if (g.__mindOrphanSweep) clearInterval(g.__mindOrphanSweep); g.__mindOrphanSweep = setInterval(sweepOrphanChats, 60_000); }

/** Discard pending chat questions (one by key or all of a bot), including ones resumed after a server restart. */
export function discardPending(opts: { key?: string; nodeId?: string }): number {
  let n = 0;
  for (const [k, c] of [...chatPending]) {
    if (opts.key ? k !== opts.key : c.nodeId !== opts.nodeId) continue;
    chatPending.delete(k); rmSync(join(INBOX_DIR, `${k}.md`), { force: true }); rmSync(join(INBOX_DIR, `${k}.json`), { force: true });
    const rid0 = k.replace(/-(v\d+|k)$/, '');
    cancelled.add(rid0);
    c.resolve(tr('(verworfen – nicht beantwortet)', '(discarded – not answered)'));
    n++;
  }
  return n;
}

/** Open questions to the "chat" runtime (normal chat via Desktop Commander). */
interface ChatPending { key: string; nodeId: string; threadId: string; depth: number; readonly: boolean; prompt: string; createdAt: string; resolve: (t: string) => void }
export const chatPending = new Map<string, ChatPending>();
export const INBOX_DIR = join(DATA_DIR, 'inbox');

interface ChatMeta { key: string; nodeId: string; threadId: string; depth: number; readonly: boolean; prompt: string; createdAt: string; from: string; edgeId: string | null; runId: string }

/** After a server restart: resume open chat questions from data/inbox (the answer is then booked directly). */
export function restoreInbox() {
  if (!existsSync(INBOX_DIR)) return;
  for (const f of readdirSync(INBOX_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const m: ChatMeta = JSON.parse(readFileSync(join(INBOX_DIR, f), 'utf8'));
      if (chatPending.has(m.key)) continue;
      chatPending.set(m.key, {
        ...m,
        resolve: (text: string) => mutate((st) => {
          st.botMessages.push({ id: rid('msg'), at: now(), threadId: m.threadId, from: m.nodeId, to: m.from, text, edgeId: m.edgeId, runId: m.runId, kind: m.readonly ? 'vorschlag' : 'antwort', via: 'bot', runtime: 'chat' });
          touch(st, m.nodeId, 'bot', tr(`Chat-Antwort zu ${m.key} (nach Neustart) verbucht.`, `Chat answer to ${m.key} booked (after restart).`), m.runId);
        }),
      });
    } catch { /* ignore broken file */ }
  }
}
let apiBase = 'http://127.0.0.1:5181';
export function setApiBase(b: string) { apiBase = b; }

/** Read–modify–write of the state; serialized since it is synchronous in the single server process. */
export function mutate<T>(fn: (s: GraphState) => T): T {
  const s = normalize(readState() ?? starterState());
  const out = fn(s);
  writeState(s, null);
  return out;
}

export function nodeDir(id: string) { return join(NODES_DIR, id.replace(/[^\w\-]/g, '_')); }

const rid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function runtimeFor(s: GraphState, nodeId: string): { runtime: Runtime; model: string } {
  const p = nodeById(s, nodeId)?.agentProfile;
  const prov = (p?.provider ?? '').toLowerCase();
  const env = (process.env.DG_BOT_RUNTIME ?? 'chat') as Runtime; // default: Claude Desktop via inbox (no API call)
  const runtime: Runtime = prov.startsWith('chat') ? 'chat' : prov.startsWith('test') ? 'test' : prov.startsWith('openai') || prov.startsWith('codex') ? 'codex' : prov.startsWith('anthropic') || prov.startsWith('claude') ? 'claude' : env;
  const m = p?.model && p.model !== 'unbestimmt' ? p.model.split(' ')[0] : '';
  return { runtime, model: m || (runtime === 'claude' ? 'haiku' : '') };
}

/** Models of a bot; the first is the chair. */
export function membersFor(s: GraphState, nodeId: string): BotMember[] {
  const ms = nodeById(s, nodeId)?.agentProfile?.members?.filter((m) => m.runtime) ?? [];
  if (ms.length) return ms.map((m) => ({ runtime: m.runtime, model: m.model || (m.runtime === 'claude' ? 'haiku' : '') }));
  const p = nodeById(s, nodeId)?.agentProfile;
  if (!p?.provider && !process.env.DG_BOT_RUNTIME) return [{ runtime: 'claude', model: 'sonnet' }]; // default: Sonnet · fast (subscription)
  const { runtime, model } = runtimeFor(s, nodeId);
  return [{ runtime, model }];
}

const label = (m: BotMember) => `${m.runtime}${m.model ? '/' + m.model : ''}${m.chatModel ? ' · ' + m.chatModel : ''}`;

const rootOf = (s: GraphState) => s.nodes.find((n) => !s.edges.some((e) => e.primary && e.to === n.id))!.id;
/** OK budget: daily quota (root = the owner's pool) and what is still free today. */
export function okQuota(s: GraphState, id: string) { return id === rootOf(s) ? (s.okPool ?? DEFAULT_OK_POOL) : (nodeById(s, id)?.okBudget ?? 0); }
export function okLeft(s: GraphState, id: string) { const u = nodeById(s, id)?.okUsed; return okQuota(s, id) - (u?.day === okDay() ? u.n : 0); }
/** Bots whose nearest bot chief is id. */
export function subBots(s: GraphState, id: string) { return s.nodes.filter((n) => n.isBot && n.id !== id && chefOfNode(s, n.id) === id).map((n) => n.id); }
/** Search normalization: lowercase, umlauts/ß resolved, double letters collapsed (Hausmann = Haussmann). */
const snorm = (x: string) => x.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9@.]+/g, ' ').replace(/([a-z])\1+/g, '$1');
/** Full-text search over nodes (title, summary, open points, short status, instruction, history) and conversations; all words must occur. */
export function searchText(query: string, s: GraphState = normalize(readState() ?? starterState()), hidden: (id: string) => boolean = () => false): string {
  const words = snorm(query).split(' ').filter((w) => w.length > 1);
  if (!words.length) return tr('Suchbegriff fehlt.', 'Search term missing.');
  const snip = (raw: string) => { const flat = raw.replace(/\s+/g, ' '); const low = snorm(flat); const i = low.indexOf(words[0]); const k = i < 0 ? 0 : Math.max(0, Math.round((i / Math.max(1, low.length)) * flat.length) - 80); return (k ? '…' : '') + flat.slice(k, k + 260); };
  const hits: string[] = [];
  for (const n of s.nodes) {
    if (hidden(n.id)) continue;
    const notes = s.log.filter((l) => l.nodeId === n.id && !/^(Lauf|Run) /.test(l.text)).map((l) => l.text);
    const hay = [n.title, n.summary, ...n.openPoints, ...(n.todos?.pos ?? []), ...(n.todos?.neg ?? []), n.instruction?.text ?? '', n.okNext?.text ?? '', n.blocker?.text ?? '', ...notes].join(' \n ');
    const low = snorm(hay);
    if (words.every((w) => low.includes(w))) hits.push(tr(`Knoten „${n.title}“ (\`${n.id}\`): ${snip(hay)}`, `Node "${n.title}" (\`${n.id}\`): ${snip(hay)}`));
  }
  for (const m of s.botMessages) { if ([m.from, m.to, m.about].some((x) => x && x !== OWNER_ID && nodeById(s, x) && hidden(x))) continue; const low = snorm(m.text); if (words.every((w) => low.includes(w))) hits.push(tr(`Gespräch ${m.from} → ${m.to} (${m.at.slice(0, 10)}): ${snip(m.text)}`, `Conversation ${m.from} → ${m.to} (${m.at.slice(0, 10)}): ${snip(m.text)}`)); }
  return hits.length ? tr(`${hits.length} Treffer${hits.length > 30 ? ' (erste 30)' : ''}:\n${hits.slice(0, 30).map((h) => `- ${h}`).join('\n')}\n\nDetails: dg show <knoten-id>`, `${hits.length} hit${hits.length === 1 ? '' : 's'}${hits.length > 30 ? ' (first 30)' : ''}:\n${hits.slice(0, 30).map((h) => `- ${h}`).join('\n')}\n\nDetails: dg show <node-id>`) : tr('Keine Treffer.', 'No hits.');
}

/** Files in a node's folder (recursive, without hidden ones), readable for bots and chats. */
export function nodeFiles(id: string): string {
  const dir = nodeDir(id);
  if (!existsSync(dir)) return tr('Kein Ordner für diesen Knoten.', 'No folder for this node.');
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { if (f.startsWith('.') || out.length >= 300) continue; const p = join(d, f); const st = statSync(p); if (st.isDirectory()) walk(p); else out.push(`- ${relative(dir, p)} (${st.size < 1024 ? st.size + ' B' : Math.round(st.size / 1024) + ' KB'}, ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')})`); } };
  walk(dir);
  return out.length ? tr(`${out.join('\n')}\n\nLesen: dg read <knoten> <datei>`, `${out.join('\n')}\n\nRead: dg read <node> <file>`) : tr('Ordner ist leer.', 'Folder is empty.');
}
/** Structured file list of a node folder (for the UI). */
export function listNodeFiles(id: string): { path: string; size: number; at: string }[] {
  const dir = nodeDir(id);
  if (!existsSync(dir)) return [];
  const out: { path: string; size: number; at: string }[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { if (f.startsWith('.') || out.length >= 300) continue; const p = join(d, f); const st = statSync(p); if (st.isDirectory()) walk(p); else out.push({ path: relative(dir, p), size: st.size, at: st.mtime.toISOString() }); } };
  walk(dir);
  return out.sort((x, y) => y.at.localeCompare(x.at));
}
/** Read one file from a node folder (only inside the folder, max. 200 KB). */
export function readNodeFile(id: string, rel: string): { ok: boolean; text: string } {
  const dir = resolve(nodeDir(id));
  const p = resolve(dir, rel || '');
  if (!rel || (p !== dir && !p.startsWith(dir + '/'))) return { ok: false, text: tr('Pfad muss im Ordner des Knotens liegen (siehe dg files <knoten>).', 'Path must lie inside the node folder (see dg files <node>).') };
  if (!existsSync(p) || statSync(p).isDirectory()) return { ok: false, text: tr(`Datei ${rel} gibt es nicht (dg files ${id}).`, `File ${rel} does not exist (dg files ${id}).`) };
  const buf = readFileSync(p);
  if (buf.subarray(0, 4096).includes(0)) return { ok: false, text: tr('Binärdatei – nicht als Text lesbar.', 'Binary file – not readable as text.') };
  const t = buf.toString('utf8');
  return { ok: true, text: t.length > 200_000 ? t.slice(0, 200_000) + tr('\n\n[… gekürzt bei 200 KB]', '\n\n[… truncated at 200 KB]') : t };
}

/** Resolve a file in a node folder (only inside the folder). */
export function nodeFilePath(id: string, rel: string): string | null {
  const dir = resolve(nodeDir(id));
  const p = resolve(dir, rel || '');
  return rel && p.startsWith(dir + '/') ? p : null;
}
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function mdToHtml(t: string): string {
  const e = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inl = (x: string) => e(x).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
  let out = '', list = false;
  for (const l of t.split('\n')) {
    const h = l.match(/^(#{1,6})\s+(.*)$/), li = l.match(/^\s*[-*]\s+(.*)$/);
    if (!li && list) { out += '</ul>'; list = false; }
    if (h) out += `<h${h[1].length}>${inl(h[2])}</h${h[1].length}>`;
    else if (li) { if (!list) { out += '<ul>'; list = true; } out += `<li>${inl(li[1])}</li>`; }
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) out += '<hr>';
    else if (l.trim()) out += `<p>${inl(l)}</p>`;
  }
  if (list) out += '</ul>';
  return `<!doctype html><meta charset="utf-8"><style>body{font:11pt/1.5 -apple-system,Helvetica,Arial,sans-serif;margin:18mm;color:#222}h1,h2,h3{line-height:1.2}code{background:#f2f2f2;padding:0 3px}</style>${out}`;
}
/** Render HTML/Markdown/SVG from a node folder as PDF into the same folder via headless Chrome. */
export async function renderPdf(id: string, rel: string, outRel?: string): Promise<{ ok: boolean; text: string }> {
  const src = nodeFilePath(id, rel);
  if (!src || !existsSync(src)) return { ok: false, text: tr(`Datei ${rel} gibt es nicht im Ordner von ${id} (dg files ${id}).`, `File ${rel} does not exist in the folder of ${id} (dg files ${id}).`) };
  if (!/\.(html?|md|svg|txt)$/i.test(src)) return { ok: false, text: tr('dg pdf kann .html, .md, .svg und .txt rendern.', 'dg pdf can render .html, .md, .svg and .txt.') };
  if (!existsSync(CHROME)) return { ok: false, text: tr('Google Chrome fehlt – ohne Chrome kein PDF.', 'Google Chrome is missing – no PDF without Chrome.') };
  const out = nodeFilePath(id, outRel || rel.replace(/\.[^.\/]+$/, '') + '.pdf');
  if (!out || !/\.pdf$/i.test(out)) return { ok: false, text: tr('Ziel muss eine .pdf im Knotenordner sein.', 'Target must be a .pdf inside the node folder.') };
  let page = src;
  const tmp = join(tmpdir(), `mind-pdf-${Date.now().toString(36)}`); mkdirSync(tmp, { recursive: true });
  if (/\.(md|txt)$/i.test(src)) { const raw = readFileSync(src, 'utf8'); page = join(resolve(src, '..'), `.mindpdf-${Date.now().toString(36)}.html`); writeFileSync(page, /\.md$/i.test(src) ? mdToHtml(raw) : mdToHtml('') + `<pre style="white-space:pre-wrap">${raw.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`); }
  const before = existsSync(out) ? statSync(out).mtimeMs : 0;
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-pdf-header-footer', `--user-data-dir=${tmp}`, '--virtual-time-budget=8000', `--print-to-pdf=${out}`, 'file://' + page], { stdio: 'ignore' });
  // Chrome does not always quit in headless mode – wait for a finished, stable PDF, then kill it.
  let last = -1, ok = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (existsSync(out) && statSync(out).mtimeMs > before) { const sz = statSync(out).size; if (sz > 0 && sz === last) { ok = true; break; } last = sz; }
    if (ch.exitCode !== null && !(existsSync(out) && statSync(out).mtimeMs > before)) break;
  }
  try { ch.kill('SIGKILL'); } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }); if (page !== src) rmSync(page, { force: true }); } catch { /* */ }
  if (!ok) return { ok: false, text: tr('PDF-Erzeugung fehlgeschlagen (Chrome hat kein PDF geschrieben).', 'PDF creation failed (Chrome did not write a PDF).') };
  const r = relative(resolve(nodeDir(id)), out);
  return { ok: true, text: tr(`ok: PDF erstellt: ${r} (${Math.round(statSync(out).size / 1024)} KB). ${OWNER()} sieht es im Knotenfenster unter „Dateien“ (Klick öffnet/lädt herunter).`, `ok: PDF created: ${r} (${Math.round(statSync(out).size / 1024)} KB). ${OWNER()} sees it in the node window under "Files" (click opens/downloads).`) };
}

/** Read "Bei OK werde ich …" / "On OK I will …" from the last line of a reply. */
export function extractOk(reply: string): string | null {
  const m = [...reply.matchAll(/(?:bei ok werde ich|on ok i will)\s*[:：]?\s*(.+)$/gim)].at(-1);
  if (!m) return null;
  const t = m[1].replace(/[*_`„“"]/g, '').replace(/\s*\(?\.{3}\)?\s*/g, ' ').replace(/[.\s]+$/, '').trim();
  return t && t.length <= 160 ? t : null;
}

function chefOfNode(s: GraphState, id: string): string | null {
  for (const a of ancestors(s, id).reverse()) if (nodeById(s, a)?.isBot) return a;
  return null;
}

/** Work instructions of the chief chain (top → bottom) plus the node's own. */
export function instructionChain(s: GraphState, id: string): string {
  const chain: string[] = [];
  let c = chefOfNode(s, id);
  while (c) { chain.unshift(c); c = chefOfNode(s, c); }
  const parts = chain.map((x) => nodeById(s, x)!).filter((n) => n.instruction?.text)
    .map((n) => tr(`### Arbeitsanweisung von „${n.title}“ (\`${n.id}\`, Chef-Ebene)\n${n.instruction!.text}`, `### Work instruction from "${n.title}" (\`${n.id}\`, chief level)\n${n.instruction!.text}`));
  if (s.globalInstruction?.trim()) parts.unshift(tr(`### Grundregeln (für alle Bots)\n${s.globalInstruction.trim()}`, `### Ground rules (for all bots)\n${s.globalInstruction.trim()}`));
  const own = nodeById(s, id)?.instruction?.text;
  parts.push(own ? tr(`### Deine Arbeitsanweisung\n${own}`, `### Your work instruction\n${own}`) : tr('### Deine Arbeitsanweisung\n(noch keine – lege eine an)', '### Your work instruction\n(none yet – create one)'));
  return parts.join('\n\n');
}

function nodeContext(s: GraphState, id: string): string {
  const n = nodeById(s, id)!;
  const path = [...ancestors(s, id), id].map((x) => nodeById(s, x)?.title ?? x).join(' › ');
  const kids = children(s, id).map((c) => `- ${nodeById(s, c)?.title} (\`${c}\`)${nodeById(s, c)?.isBot ? ' · Bot' : ''}`).join('\n') || tr('- keine', '- none');
  const runs = runsUnder(s, id).map((r) => `- ${nodeById(s, r.nodeId)?.title} (\`${r.nodeId}\`): ${tr(`${r.periodStart ?? '?'} – ${r.periodEnd ?? '?'}, Start ${r.config.startCapitalEur ?? '?'} €, Ende ${fmtEur(r.metrics.finalWealthEur.value)}, Max-DD ${fmtPct(r.metrics.maxDrawdownPct.value)}, Pool ${r.config.botPool ?? 'offen'}, Hebel ${r.config.leverage ?? 'offen'}, Beleg ${r.evidence}`, `${r.periodStart ?? '?'} – ${r.periodEnd ?? '?'}, start ${r.config.startCapitalEur ?? '?'} €, end ${fmtEur(r.metrics.finalWealthEur.value)}, max DD ${fmtPct(r.metrics.maxDrawdownPct.value)}, pool ${r.config.botPool ?? 'open'}, leverage ${r.config.leverage ?? 'open'}, evidence ${r.evidence}`)}`).join('\n');
  const td = n.todos ? `\n\nTo-dos (${tr('Stand', 'as of')} ${n.todos.at.slice(0, 10)}):\n${n.todos.pos.map((t) => `+ ${t}`).join('\n')}\n${n.todos.neg.map((t) => `- ${t}`).join('\n')}` : '';
  const ins = n.instruction?.text ? tr(`\nArbeitsanweisung: vorhanden (Stand ${n.instruction.at.slice(0, 10)}, \`dg instruction\`)`, `\nWork instruction: present (as of ${n.instruction.at.slice(0, 10)}, \`dg instruction\`)`) : '';
  const notes = s.log.filter((l) => l.nodeId === id && !/^(Lauf|Run) |Modell im Chat|Model in chat/.test(l.text)).slice(-5).map((l) => `- ${l.at.slice(0, 16).replace('T', ' ')} ${l.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
  const decs = s.decisions.filter((d) => d.nodeId === id).slice(-5).map((d) => `- ${d.id} · ${d.date ?? '?'} · ${decLabel(d.kind)}: ${d.content}${d.rationale ? tr(` – weil ${d.rationale.slice(0, 200)}`, ` – because ${d.rationale.slice(0, 200)}`) : ''}`).join('\n');
  const bl = n.blocker ? tr(`\nHuman Blocker (seit ${n.blocker.at.slice(0, 10)}): ${n.blocker.text}`, `\nHuman Blocker (since ${n.blocker.at.slice(0, 10)}): ${n.blocker.text}`) : '';
  return tr(`Pfad: ${path}\nTyp: ${n.type}${ins}${bl}${td}\n\nStand:\n${n.summary || '(leer)'}\n\nOffene Punkte:\n${n.openPoints.map((p, i) => `${i + 1}. ${p}`).join('\n') || '- keine'}\n\nUnterknoten:\n${kids}${decs ? `\n\nEntscheidungen (neueste):\n${decs}` : ''}${notes ? `\n\nVerlauf (neueste Notizen):\n${notes}` : ''}${runs ? `\n\nLäufe (inkl. Unterknoten):\n${runs}` : ''}`,
    `Path: ${path}\nType: ${n.type}${ins}${bl}${td}\n\nStatus:\n${n.summary || '(empty)'}\n\nOpen points:\n${n.openPoints.map((p, i) => `${i + 1}. ${p}`).join('\n') || '- none'}\n\nChild nodes:\n${kids}${decs ? `\n\nDecisions (latest):\n${decs}` : ''}${notes ? `\n\nHistory (latest notes):\n${notes}` : ''}${runs ? `\n\nRuns (incl. child nodes):\n${runs}` : ''}`);
}

/** Initial contents of a node folder. Existing files modified by the bot stay untouched. */
export function ensureNodeFolder(s: GraphState, id: string): string {
  const dir = nodeDir(id);
  mkdirSync(dir, { recursive: true });
  const n = nodeById(s, id)!;
  const proto = tr(`# Bot „${n.title}“ (\`${id}\`)

Du bist der Bot dieses Knotens im Quant-Entscheidungsgraphen von ${OWNER()}. Dein Arbeitsordner ist dieser Ordner.
Diese Datei gehört dir: ergänze sie mit deiner Rolle, deinen Arbeitsregeln und dem, was du dir merken willst.

## Werkzeug \`dg\` (einzige Schreibschnittstelle zum Graphen)

- \`dg show [knoten]\` – Stand, offene Punkte, Unterknoten, letzte Gespräche
- \`dg tree\` – ganzer Themenbaum mit Bots
- \`dg messages <knoten> [anzahl]\` – Gespräche eines Knotens in voller Länge (dg show kürzt)
- \`dg files <knoten>\` / \`dg read <knoten> <datei>\` – Dateien im Ordner eines Knotens auflisten / lesen (z. B. Entwürfe anderer Bots)
- \`dg pdf <datei.html|.md|.svg> [ziel.pdf]\` – PDF aus einer Datei in deinem Ordner rendern (Chrome, lokal). Bilder/Karten als <img>/<svg> in die HTML einbetten. ${OWNER()} sieht und lädt PDFs im Knotenfenster unter „Dateien“. Kein Renderer-Freigabe nötig.
- \`dg search "<begriffe>"\` – Volltextsuche über alle Knoten, Notizen und Gespräche (tolerant bei Schreibweise)
- \`dg set-summary "<text>" [--node id]\` – Zusammenfassung ersetzen
- \`dg set-title "<titel>" [--node id]\`
- \`dg add-open "<punkt>" [--node id]\` / \`dg close-open <nr> [--node id]\`
- \`dg add-child "<titel>" [--node id]\` – Unterknoten anlegen
- \`dg move <knoten> <neuer-eltern-knoten>\` – Zweig verschieben
- \`dg remove <knoten>\` / \`dg restore [id]\` – Ast entfernen (Papierkorb) bzw. zurückholen – nur im Auftrag von ${OWNER()}
- \`dg set-plane <nr> [--node id]\` – Hauptast (direkt unter ${OWNER()}) auf Kreis-Ebene legen: Work (1), Live (2), …
- \`dg note "<text>" [--node id]\` – Arbeitsschritt protokollieren
- \`dg set-todos "+<Befund> → <To-do>" … "-<Befund> → <To-do>" [--node id]\` – Kurzlage: 3 positive (Chance ausbauen) und 2 negative (Problem beheben), stichpunktartig: Befund max. 8 Wörter, To-do mit Verb zuerst, max. 8 Wörter
- \`dg folder <knoten>\` – Arbeitsordner eines Unterknotens (dort darfst du CLAUDE.md/AGENTS.md anlegen)
- \`dg make-bot <knoten>\` – Knoten zum Bot machen (nur im Auftrag von ${OWNER()})
- \`dg bots\` – alle Bots
- \`dg instruction [knoten|chef]\` / \`dg set-instruction "<text>" [--node id]\` – Arbeitsanweisung lesen/pflegen (gilt für den Bereich nach unten)
- \`dg update <unterbot>\` – Aktualisieren eines Unter-Bots anstoßen (läuft im Hintergrund)
- \`dg ask <bot-knoten> "<frage>"\` – einen anderen Bot fragen und auf seine Antwort warten
- \`dg request "<was und warum>"\` – etwas außerhalb deines Reichs anfragen: dein Chef entscheidet oder reicht weiter bis ${OWNER()}
- \`dg set-ok "<nächste Handlung, max. 8 Wörter>"\` – dein „Bei OK werde ich …“ festlegen (wird auch aus der letzten Antwortzeile gelesen)
- \`dg block "<was du von ${OWNER()} brauchst>"\` / \`dg unblock\` – Human Blocker setzen/aufheben (${OWNER()} sieht alle Blocker im Cockpit)
- \`dg decide "<Entscheidung>" "<Begründung>" [--kind annahme|korrektur] [--refers <id>]\` – Entscheidung mit Begründung festhalten (Korrektur verweist auf die frühere)
- \`dg decisions [knoten]\` – Entscheidungsverlauf des Bereichs (mit IDs)
- \`dg oks\` – deine Unter-Bots: was sie bei OK tun würden, ihr OK-Budget; dein eigenes Budget
- \`dg ok <unterbot>\` – einem Unter-Bot OK geben (kostet 1 aus deinem Tages-Budget, er führt sein „Bei OK“ aus)
- \`dg budget <unterbot> <n>\` – einem Unter-Bot ein Tages-OK-Budget zuteilen (Summe ≤ deinem eigenen)

Reich: dieser Knoten, seine Unterknoten und die Arbeitsordner des Asts – dort alles (Bash, Python, Code, PDFs). Außerhalb nur über \`dg request\` an den Chef.

## Regeln

- Ändere nur, was die Nachricht verlangt oder was sich aus belegten Quellen ergibt. Keine erfundenen Zahlen.
- Deine letzte Ausgabe ist die Antwort, die ${OWNER()} bzw. der fragende Bot sieht: knapp, deutsch, mit dem was du geändert hast.
`, `# Bot "${n.title}" (\`${id}\`)

You are the bot of this node in ${OWNER()}'s quant decision graph. Your working folder is this folder.
This file belongs to you: extend it with your role, your working rules and whatever you want to remember.

## Tool \`dg\` (the only write interface to the graph)

- \`dg show [node]\` – status, open points, child nodes, latest conversations
- \`dg tree\` – the whole topic tree with bots
- \`dg messages <node> [count]\` – conversations of a node in full length (dg show truncates)
- \`dg files <node>\` / \`dg read <node> <file>\` – list / read files in a node's folder (e.g. drafts of other bots)
- \`dg pdf <file.html|.md|.svg> [target.pdf]\` – render a PDF from a file in your folder (Chrome, local). Embed images/maps as <img>/<svg> in the HTML. ${OWNER()} sees and downloads PDFs in the node window under "Files". No renderer approval needed.
- \`dg search "<terms>"\` – full-text search over all nodes, notes and conversations (tolerant of spelling)
- \`dg set-summary "<text>" [--node id]\` – replace the summary
- \`dg set-title "<title>" [--node id]\`
- \`dg add-open "<point>" [--node id]\` / \`dg close-open <nr> [--node id]\`
- \`dg add-child "<title>" [--node id]\` – create a child node
- \`dg move <node> <new-parent-node>\` – move a branch
- \`dg remove <node>\` / \`dg restore [id]\` – remove a branch (trash) or bring it back – only on behalf of ${OWNER()}
- \`dg set-plane <nr> [--node id]\` – put a main branch (directly under ${OWNER()}) on a circle plane: Work (1), Live (2), …
- \`dg note "<text>" [--node id]\` – log a work step
- \`dg set-todos "+<finding> → <to-do>" … "-<finding> → <to-do>" [--node id]\` – short status: 3 positive (build on an opportunity) and 2 negative (fix a problem), in bullet style: finding max. 8 words, to-do with a verb first, max. 8 words
- \`dg folder <node>\` – working folder of a child node (you may create CLAUDE.md/AGENTS.md there)
- \`dg make-bot <node>\` – turn a node into a bot (only on behalf of ${OWNER()})
- \`dg bots\` – all bots
- \`dg instruction [node|chief]\` / \`dg set-instruction "<text>" [--node id]\` – read/maintain the work instruction (applies to the area below)
- \`dg update <subbot>\` – trigger an update of a sub-bot (runs in the background)
- \`dg ask <bot-node> "<question>"\` – ask another bot and wait for its answer
- \`dg request "<what and why>"\` – request something outside your realm: your chief decides or passes it on up to ${OWNER()}
- \`dg set-ok "<next action, max. 8 words>"\` – set your "On OK I will …" (is also read from the last line of your answer)
- \`dg block "<what you need from ${OWNER()}>"\` / \`dg unblock\` – set/clear a Human Blocker (${OWNER()} sees all blockers in the cockpit)
- \`dg decide "<decision>" "<rationale>" [--kind annahme|korrektur] [--refers <id>]\` – record a decision with rationale (a correction refers to the earlier one)
- \`dg decisions [node]\` – decision history of the area (with IDs)
- \`dg oks\` – your sub-bots: what they would do on OK, their OK budget; your own budget
- \`dg ok <subbot>\` – give a sub-bot the OK (costs 1 of your daily budget, it carries out its "On OK")
- \`dg budget <subbot> <n>\` – allot a sub-bot a daily OK budget (sum ≤ your own)

Realm: this node, its child nodes and the working folders of the branch – everything there (Bash, Python, code, PDFs). Outside only via \`dg request\` to the chief.

## Rules

- Only change what the message asks for or what follows from documented sources. No invented numbers.
- Your last output is the answer that ${OWNER()} or the asking bot sees: brief, in English, with what you changed.
`);
  if (!existsSync(join(dir, 'CLAUDE.md'))) writeFileSync(join(dir, 'CLAUDE.md'), proto);
  if (!existsSync(join(dir, 'AGENTS.md'))) writeFileSync(join(dir, 'AGENTS.md'), tr('Siehe CLAUDE.md in diesem Ordner – gleiche Regeln für alle Anbieter.\n', 'See CLAUDE.md in this folder – same rules for all providers.\n'));
  return dir;
}

export function ensureBin() {
  mkdirSync(BIN_DIR, { recursive: true });
  const dg = join(BIN_DIR, 'dg');
  writeFileSync(dg, `#!/usr/bin/env node
${tr('// dg – Graphwerkzeug für Knoten-Bots (spricht mit der lokalen App-API)', '// dg – graph tool for node bots (talks to the local app API)')}
const api = process.env.DG_API || '${apiBase}';
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const node = flag('--node');
const run = flag('--run');
const as = flag('--as');
const [cmd, ...rest] = args;
fetch(api + '/api/dg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  cmd, args: rest, node, run, as, actor: process.env.DG_NODE, thread: process.env.DG_THREAD, depth: Number(process.env.DG_DEPTH || 0), readonly: process.env.DG_READONLY === '1', mandate: process.env.DG_MANDATE || null,
}) }).then(async (r) => { const t = await r.text(); (r.ok ? process.stdout : process.stderr).write(t.endsWith('\\n') ? t : t + '\\n'); process.exit(r.ok ? 0 : 1); })
  .catch((e) => { console.error('${tr('dg: App-API nicht erreichbar (', 'dg: app API not reachable (')}' + api + '): ' + e.message); process.exit(2); });
`);
  chmodSync(dg, 0o755);
  writeChatGuide();
}

/** Guide for a normal chat (Claude.ai / ChatGPT Desktop) with Desktop Commander. */
export function writeChatGuide() {
  const dg = join(BIN_DIR, 'dg');
  writeFileSync(join(DATA_DIR, 'CHAT.md'), tr(`# Mind über einen normalen Chat bedienen

Du bist ${OWNER()}s Assistent für Mind, die lokale Karte (Themenbaum mit Bots). Du arbeitest über **Desktop Commander**
(start_process) mit dem Werkzeug \`${dg}\`. Die App läuft unter ${apiBase}. Keine API-Kosten: du bist der Bot.

## 1. Offene Fragen an Chat-Bots abarbeiten

1. \`${dg} inbox\` – listet offene Fragen (Schlüssel, Bot-Knoten, Kurztext).
2. \`${dg} task <schlüssel>\` – vollständiger Auftrag mit Knotenstand.
3. Arbeiten im Namen dieses Bots: \`${dg} --run <schlüssel> <befehl>\`
   (z. B. \`show\`, \`add-open "…"\`, \`set-summary "…"\`, \`add-child "…"\`, \`note "…"\`, \`ask <bot> "…"\`).
   Die Datei CLAUDE.md/AGENTS.md des Bots liegt in ${NODES_DIR}/<knoten>/ und darf gepflegt werden.
4. \`${dg} reply <schlüssel> "<antwort>"\` – Antwort erscheint sofort in der Karte.

Vorschlagsrunden (mehrere Modelle) sind nur lesend: Änderungen nur vorschlagen, nicht ausführen.

## 2. Direkt mit ${OWNER()} am Graphen arbeiten

- \`${dg} --as ${OWNER_ID} tree\` – ganzer Baum mit Bots
- \`${dg} --as ${OWNER_ID} show <knoten>\`
- \`${dg} --as ${OWNER_ID} set-summary "…" --node <knoten>\` · \`add-open\` · \`close-open <nr>\` · \`add-child\` · \`note\`
- \`${dg} --as ${OWNER_ID} ask <bot-knoten> "…"\` – einen Bot fragen (läuft mit dessen eingestelltem Modell)

## 3. Cockpit, OKs und Blocker (als ${OWNER()})

- \`${dg} --as ${OWNER_ID} cockpit\` – wo ${OWNER()} gebraucht wird (Human Blocker), „Bei OK“ aller Bots, Autorun
- \`${dg} --as ${OWNER_ID} ok <bot>\` – einem Bot OK geben (er führt sein „Bei OK“ aus)
- \`${dg} --as ${OWNER_ID} sweep [knoten] [self|next|zone]\` – OK-Kaskade (ohne Knoten: ganze Karte)
- \`${dg} --as ${OWNER_ID} fill-ok\` – Bots ohne „Bei OK“ legen es fest
- \`${dg} --as ${OWNER_ID} blockers\` – alle Bots melden, ob sie ${OWNER()} brauchen
- \`${dg} --as ${OWNER_ID} auto on [stunden]\` / \`auto off\` – Autorun (OKs laufend, stoppt nach Stunden ohne Aktivität; 0 = unbegrenzt)

Jede Antwort als Bot endet mit der Zeile „Bei OK werde ich: <max. 8 Wörter>“. Brauchst du ${OWNER()}: \`--run <schlüssel> block "<was er tun muss>"\`.

## Regeln

- Nur ändern, was ${OWNER()} oder der Auftrag verlangt; keine erfundenen Zahlen. Belege nennen.
- Antworten knapp und auf Deutsch, mit dem was geändert wurde.
`, `# Operating Mind through a normal chat

You are ${OWNER()}'s assistant for Mind, the local map (topic tree with bots). You work through **Desktop Commander**
(start_process) with the tool \`${dg}\`. The app runs at ${apiBase}. No API costs: you are the bot.

## 1. Work through open questions to chat bots

1. \`${dg} inbox\` – lists open questions (key, bot node, short text).
2. \`${dg} task <key>\` – full task with node status.
3. Work on behalf of this bot: \`${dg} --run <key> <command>\`
   (e.g. \`show\`, \`add-open "…"\`, \`set-summary "…"\`, \`add-child "…"\`, \`note "…"\`, \`ask <bot> "…"\`).
   The bot's CLAUDE.md/AGENTS.md lives in ${NODES_DIR}/<node>/ and may be maintained.
4. \`${dg} reply <key> "<answer>"\` – the answer appears in the map immediately.

Proposal rounds (several models) are read-only: only propose changes, do not execute them.

## 2. Work on the graph directly with ${OWNER()}

- \`${dg} --as ${OWNER_ID} tree\` – whole tree with bots
- \`${dg} --as ${OWNER_ID} show <node>\`
- \`${dg} --as ${OWNER_ID} set-summary "…" --node <node>\` · \`add-open\` · \`close-open <nr>\` · \`add-child\` · \`note\`
- \`${dg} --as ${OWNER_ID} ask <bot-node> "…"\` – ask a bot (runs with its configured model)

## 3. Cockpit, OKs and blockers (as ${OWNER()})

- \`${dg} --as ${OWNER_ID} cockpit\` – where ${OWNER()} is needed (Human Blocker), "On OK" of all bots, autorun
- \`${dg} --as ${OWNER_ID} ok <bot>\` – give a bot the OK (it carries out its "On OK")
- \`${dg} --as ${OWNER_ID} sweep [node] [self|next|zone]\` – OK cascade (without a node: the whole map)
- \`${dg} --as ${OWNER_ID} fill-ok\` – bots without an "On OK" set one
- \`${dg} --as ${OWNER_ID} blockers\` – all bots report whether they need ${OWNER()}
- \`${dg} --as ${OWNER_ID} auto on [hours]\` / \`auto off\` – autorun (OKs continuously, stops after hours without activity; 0 = unlimited)

Every answer as a bot ends with the line "On OK I will: <max. 8 words>". If you need ${OWNER()}: \`--run <key> block "<what they need to do>"\`.

## Rules

- Only change what ${OWNER()} or the task asks for; no invented numbers. Cite sources.
- Keep answers brief and in English, with what was changed.
`));
}

// ───────── dg commands ─────────

const noNodeMsg = (id: string) => tr(`dg: Knoten ${id} gibt es nicht.`, `dg: node ${id} does not exist.`);

function canEdit(s: GraphState, actor: string, target: string) {
  return actor === target || descendants(s, actor).includes(target);
}

// ───────── Realm: where a bot may work ─────────

const HOME = process.env.HOME ?? '/';
const expandHome = (p: string) => resolve(p.trim().replace(/^~(?=\/|$)/, HOME));
const realOr = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** Does id lie in a private branch the actor does not belong to? (The owner sees everything.) */
export function hiddenFor(s: GraphState, actor: string | null, id: string): boolean {
  if (!actor || actor === rootOf(s)) return false;
  for (const p of [id, ...ancestors(s, id)]) {
    if (nodeById(s, p)?.private && p !== actor && !descendants(s, p).includes(actor)) return true;
  }
  return false;
}

/** Working folders of a node: its own and those inherited from all ancestors. */
export function workDirsOf(s: GraphState, id: string): string[] {
  return [...new Set([...ancestors(s, id), id].flatMap((x) => nodeById(s, x)?.workDirs ?? []).filter((d) => d.trim()).map((d) => realOr(expandHome(d))))];
}

/** Realm = own node folder + folders of all child nodes + working folders. */
export function reichOf(s: GraphState, id: string, withWorkDirs = true): { nodes: string[]; work: string[]; read: string[] } {
  // read grants (own and inherited), never into a private branch the bot does not belong to
  const grants = withWorkDirs ? [...new Set([...ancestors(s, id), id].flatMap((x) => nodeById(s, x)?.readGrants ?? []))].filter((g) => nodeById(s, g) && !hiddenFor(s, id, g)) : [];
  const read = grants.flatMap((g) => [g, ...descendants(s, g)].filter((x) => !hiddenFor(s, id, x))).map((x) => realOr(resolve(nodeDir(x))));
  return { nodes: [id, ...descendants(s, id)].map((x) => realOr(resolve(nodeDir(x)))), work: withWorkDirs ? workDirsOf(s, id) : [], read: [...new Set(read)] };
}

/** Block everything under root except the allowed paths (and their parent folders as passage). */
function denyAround(root: string, allow: string[]): string[] {
  if (!existsSync(root)) return [];
  const inside = allow.filter((a) => a === root || a.startsWith(root + '/'));
  if (!inside.length) return [root];
  if (inside.includes(root)) return [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return []; }
  return entries.flatMap((f) => denyAround(join(root, f), inside));
}

/** Paths a bot may neither read nor write (personal folders, Mind data, other nodes, keys). */
export function readDenies(allow: string[]): string[] {
  const roots = [resolve(DATA_DIR, '..'), join(HOME, 'Downloads'), join(HOME, 'Documents'), join(HOME, 'Desktop'), join(HOME, 'Pictures'), join(HOME, 'Movies'),
    join(HOME, 'Library', 'Mail'), join(HOME, 'Library', 'Messages'), join(HOME, 'Library', 'Mobile Documents'), join(HOME, '.ssh'), join(HOME, '.aws'), join(HOME, '.gnupg')]
    .map(realOr);
  const ok = [...allow, realOr(BIN_DIR)];
  return [...new Set(roots.flatMap((r) => denyAround(r, ok)))];
}

export async function dgCommand(body: { cmd: string; args: string[]; node: string | null; actor: string; thread: string; depth: number; readonly?: boolean; run?: string | null; as?: string | null; mandate?: string | null }): Promise<{ code: number; text: string }> {
  // still accept older names of the owner (see OWNER_ALIASES)
  body.actor = ownerIdOf(body.actor ?? ''); if (body.as) body.as = ownerIdOf(body.as); if (body.node) body.node = ownerIdOf(body.node);
  if (body.mandate && isOwnerId(body.mandate)) body.mandate = OWNER_ID;
  body.args = (body.args ?? []).map((x) => (OWNER_ALIASES.includes(x) ? OWNER_ID : x));
  const { cmd, args } = body;
  // chat inbox: usable without bot context
  if (cmd === 'inbox') {
    if (!chatPending.size) return { code: 200, text: tr('Inbox leer – keine offenen Fragen an Chat-Bots.', 'Inbox empty – no open questions to chat bots.') };
    return { code: 200, text: [...chatPending.values()].map((p) => `- ${p.key} · Bot ${p.nodeId}${p.readonly ? tr(' · Vorschlagsrunde (nur lesen)', ' · proposal round (read-only)') : ''} · ${tr('seit', 'since')} ${p.createdAt.slice(11, 16)}\n  ${p.prompt.split(/(?:Nachricht von|Message from) /)[1]?.split(/\n\n(?:Arbeite mit|Work with)/)[0].replace(/\s+/g, ' ').slice(0, 160) ?? ''}`).join('\n') + tr('\n\nDetails: dg task <key> · Antwort: dg reply <key> "<text>" · Änderungen im Namen des Bots: dg --run <key> <befehl>', '\n\nDetails: dg task <key> · Answer: dg reply <key> "<text>" · Changes on behalf of the bot: dg --run <key> <command>') };
  }
  if (cmd === 'task') {
    const p = chatPending.get(args[0] ?? '');
    if (p && args[1] === 'online') {
      const prompt = p.prompt.replace(/(?:Arbeite mit dem Werkzeug|Work with the tool) `dg`[^\n]*/, tr('Du hast hier keinen Zugriff auf lokale Werkzeuge. Antworte mit Text; nötige Änderungen am Knoten (Zusammenfassung, offene Punkte, Unterknoten) als kurze Liste vorschlagen.', 'You have no access to local tools here. Answer with text; propose necessary changes to the node (summary, open points, child nodes) as a short list.'));
      return { code: 200, text: `${prompt}${p.readonly ? tr('\n\n(Vorschlagsrunde: nur Vorschläge.)', '\n\n(Proposal round: proposals only.)') : ''}` };
    }
    return p ? { code: 200, text: tr(`${p.prompt}\n\n---\nDu arbeitest als Bot \`${p.nodeId}\`. Änderungen: dg --run ${p.key} <befehl> (z. B. dg --run ${p.key} add-open "…").${p.readonly ? ' Vorschlagsrunde: nur lesen, Änderungen nur vorschlagen.' : ''}\nAntwort: dg reply ${p.key} "<antwort>"`, `${p.prompt}\n\n---\nYou work as bot \`${p.nodeId}\`. Changes: dg --run ${p.key} <command> (e.g. dg --run ${p.key} add-open "…").${p.readonly ? ' Proposal round: read-only, only propose changes.' : ''}\nAnswer: dg reply ${p.key} "<answer>"`) } : { code: 404, text: tr(`dg: keine offene Frage ${args[0]}. Siehe dg inbox.`, `dg: no open question ${args[0]}. See dg inbox.`) };
  }
  if (cmd === 'reply') {
    const p = chatPending.get(args[0] ?? '');
    const text = args.slice(1).join(' ').trim();
    if (!p) return { code: 404, text: tr(`dg: keine offene Frage ${args[0]} (schon beantwortet oder Server neu gestartet).`, `dg: no open question ${args[0]} (already answered or server restarted).`) };
    if (!text) return { code: 400, text: tr('dg reply <key> "<antwort>"', 'dg reply <key> "<answer>"') };
    chatPending.delete(p.key);
    rmSync(join(INBOX_DIR, `${p.key}.md`), { force: true });
    rmSync(join(INBOX_DIR, `${p.key}.json`), { force: true });
    p.resolve(text);
    return { code: 200, text: tr(`ok: Antwort für ${p.key} übergeben.`, `ok: answer for ${p.key} handed over.`) };
  }
  let actor = body.actor;
  if (body.run) {
    const p = chatPending.get(body.run);
    if (!p) return { code: 404, text: tr(`dg: keine offene Frage ${body.run}.`, `dg: no open question ${body.run}.`) };
    actor = p.nodeId; body.thread = p.threadId; body.depth = p.depth; body.readonly = p.readonly;
  } else if (body.as) actor = body.as; // e.g. --as owner: the owner's chat works directly on the graph
  if (body.readonly && !['show', 'tree', 'bots', 'oks', 'cockpit', 'search', 'decisions', 'messages', 'files', 'read'].includes(cmd)) {
    return { code: 403, text: tr(`dg: Vorschlagsrunde – ${cmd} ist hier nicht erlaubt. Beschreibe die gewünschte Änderung (inkl. dg-Befehl) in deiner Antwort; der Vorsitz setzt den Konsens um.`, `dg: proposal round – ${cmd} is not allowed here. Describe the desired change (incl. dg command) in your answer; the chair implements the consensus.`) };
  }
  const s0 = normalize(readState() ?? starterState());
  if (!actor || !nodeById(s0, actor)) return { code: 400, text: tr('dg: unbekannter Bot (DG_NODE fehlt).', 'dg: unknown bot (DG_NODE missing).') };
  const target = body.node ?? actor;
  if (!nodeById(s0, target)) return { code: 404, text: noNodeMsg(target) };
  const text = args.join(' ').trim();
  const mandate = body.mandate === OWNER_ID;
  const write = (fn: (s: GraphState) => string) => {
    if (nodeById(s0, target)?.remote) return { code: 403, text: tr(`dg: ${target} ist ein gespiegelter Ast aus einem anderen Mind – nur lesen; Fragen mit dg ask ${target} "…".`, `dg: ${target} is a mirrored branch from another Mind – read only; ask with dg ask ${target} "…".`) };
    if (!mandate && !canEdit(s0, actor, target)) return { code: 403, text: tr(`dg: ${actor} darf ${target} nicht bearbeiten – nutze dg ask.`, `dg: ${actor} may not edit ${target} – use dg ask.`) };
    return { code: 200, text: mutate(fn) };
  };
  // private branches: invisible to bots outside – as if they did not exist
  const hid = (id: string) => !mandate && hiddenFor(s0, actor, id);
  const gone = (id: string) => ({ code: 404, text: noNodeMsg(id) });
  if (hid(target)) return gone(target);
  switch (cmd) {
    case 'show': {
      const id = args[0] ?? target;
      if (hid(id)) return gone(id);
      if (!nodeById(s0, id)) return { code: 404, text: noNodeMsg(id) };
      const msgs = s0.botMessages.filter((m) => m.to === id || m.from === id).slice(-6)
        .map((m) => `- ${m.from} → ${m.to}: ${m.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
      return { code: 200, text: tr(`# ${nodeById(s0, id)!.title} (\`${id}\`)\n${nodeContext(s0, id)}\n\nLetzte Gespräche (gekürzt – voll: dg messages ${id}):\n${msgs || '- keine'}\n\nDateien im Knotenordner: dg files ${id}`, `# ${nodeById(s0, id)!.title} (\`${id}\`)\n${nodeContext(s0, id)}\n\nLatest conversations (truncated – full: dg messages ${id}):\n${msgs || '- none'}\n\nFiles in the node folder: dg files ${id}`) };
    }
    case 'tree': {
      const lines: string[] = [];
      const walk = (id: string, d: number) => { if (hid(id)) return; const n = nodeById(s0, id)!; lines.push(`${'  '.repeat(d)}- ${n.title} (\`${id}\`)${n.isBot ? ' [Bot]' : ''}${d === 1 && n.plane ? ` [${tr('Ebene', 'Plane')} ${planeName(s0, n.plane)}]` : ''}`); children(s0, id).forEach((c) => walk(c, d + 1)); };
      walk(s0.nodes.find((n) => !s0.edges.some((e) => e.primary && e.to === n.id))!.id, 0);
      return { code: 200, text: lines.join('\n') };
    }
    case 'bots': return { code: 200, text: s0.nodes.filter((n) => n.isBot && !hid(n.id)).map((n) => `- ${n.title} (\`${n.id}\`)`).join('\n') || tr('keine Bots', 'no bots') };
    case 'folder': {
      const id = args[0] ?? target;
      if (!nodeById(s0, id)) return { code: 404, text: noNodeMsg(id) };
      if (!mandate && !canEdit(s0, actor, id)) return { code: 403, text: tr(`dg: kein Schreibrecht auf ${id}.`, `dg: no write permission on ${id}.`) };
      return { code: 200, text: ensureNodeFolder(s0, id) };
    }
    case 'set-summary': return write((s) => { nodeById(s, target)!.summary = text; touch(s, target, 'bot', tr(`${actor}: Zusammenfassung aktualisiert.`, `${actor}: summary updated.`)); return tr('ok: Zusammenfassung gesetzt', 'ok: summary set'); });
    case 'set-title': return write((s) => { nodeById(s, target)!.title = text; touch(s, target, 'bot', tr(`${actor}: Titel → „${text}“.`, `${actor}: title → "${text}".`)); return tr('ok: Titel gesetzt', 'ok: title set'); });
    case 'add-open': return write((s) => { nodeById(s, target)!.openPoints.push(text); touch(s, target, 'bot', tr(`${actor}: offener Punkt „${text}“.`, `${actor}: open point "${text}".`)); return tr('ok: offener Punkt ergänzt', 'ok: open point added'); });
    case 'close-open': return write((s) => {
      const n = nodeById(s, target)!; const k = Number(args[0]) - 1;
      if (!(k >= 0 && k < n.openPoints.length)) return tr(`fehler: Punkt ${args[0]} existiert nicht (1–${n.openPoints.length})`, `error: point ${args[0]} does not exist (1–${n.openPoints.length})`);
      const [p] = n.openPoints.splice(k, 1); touch(s, target, 'bot', tr(`${actor}: offenen Punkt erledigt „${p}“.`, `${actor}: open point done "${p}".`)); return tr(`ok: erledigt „${p}“`, `ok: done "${p}"`);
    });
    case 'add-child': return write((s) => { const c = addChild(s, target, text); touch(s, c.id, 'bot', tr(`von ${nodeById(s, actor)?.title ?? actor} angelegt`, `created by ${nodeById(s, actor)?.title ?? actor}`)); return tr(`ok: Unterknoten ${c.id}`, `ok: child node ${c.id}`); });
    case 'note': return write((s) => { touch(s, target, 'bot', `${actor}: ${text}`); return tr('ok: notiert', 'ok: noted'); });
    case 'set-plane': return write((s) => {
      const nm = (args[0] ?? '').toLowerCase(); const byName = [0, 1, 2, 3, 4, 5].find((i) => planeName(s, i).toLowerCase() === nm);
      const k = byName ?? Number(args[0]) - 1;
      if (!(Number.isInteger(k) && k >= 0 && k < 50)) return tr('fehler: Ebene als Name (Work, Live) oder Zahl ab 1 angeben', 'error: give the plane as a name (Work, Live) or a number from 1');
      const rootId = s.nodes.find((n) => !s.edges.some((e) => e.primary && e.to === n.id))!.id;
      let top = target;
      for (let p = s.edges.find((e) => e.primary && e.to === top); p && p.from !== rootId; p = s.edges.find((e) => e.primary && e.to === top)) top = p.from;
      if (top === rootId) return tr(`fehler: ${OWNER()} selbst liegt auf allen Ebenen`, `error: ${OWNER()} sits on all planes`);
      const n = nodeById(s, top)!; if (k) n.plane = k; else delete n.plane;
      touch(s, top, 'bot', tr(`${actor}: Hauptast „${n.title}“ auf Ebene ${planeName(s, k)}.`, `${actor}: main branch "${n.title}" on plane ${planeName(s, k)}.`)); return tr(`ok: ${top} liegt auf Ebene ${planeName(s, k)}`, `ok: ${top} is on plane ${planeName(s, k)}`);
    });
    case 'instruction': {
      const id = args[0] === 'chef' ? chefOfNode(s0, target) : (args[0] ?? target);
      if (!id) return { code: 200, text: tr('Kein Chef-Bot über diesem Knoten.', 'No chief bot above this node.') };
      const n = nodeById(s0, id);
      if (!n || hid(id)) return { code: 404, text: noNodeMsg(id) };
      return { code: 200, text: n.instruction?.text ? tr(`# Arbeitsanweisung ${n.title} (Stand ${n.instruction.at.slice(0, 10)}, von ${n.instruction.by})\n${n.instruction.text}`, `# Work instruction ${n.title} (as of ${n.instruction.at.slice(0, 10)}, by ${n.instruction.by})\n${n.instruction.text}`) : tr(`(${n.title} hat noch keine Arbeitsanweisung)`, `(${n.title} has no work instruction yet)`) };
    }
    case 'set-instruction': return write((s) => { nodeById(s, target)!.instruction = { text, at: now(), by: actor }; touch(s, target, 'bot', tr(`${actor}: Arbeitsanweisung aktualisiert.`, `${actor}: work instruction updated.`)); return tr('ok: Arbeitsanweisung gesetzt', 'ok: work instruction set'); });
    case 'update': {
      const to = args[0];
      if (!to || !nodeById(s0, to)?.isBot) return { code: 400, text: tr('dg update <bot-knoten>', 'dg update <bot-node>') };
      if (!descendants(s0, actor).includes(to) && actor !== OWNER_ID) return { code: 403, text: tr(`dg: ${to} ist kein Unterbereich von ${actor}.`, `dg: ${to} is not a sub-area of ${actor}.`) };
      if (body.depth >= MAX_DEPTH) return { code: 429, text: tr(`dg: maximale Tiefe (${MAX_DEPTH}) erreicht – ${to} nicht angestoßen.`, `dg: maximum depth (${MAX_DEPTH}) reached – ${to} not triggered.`) };
      const r = await startRun({ nodeId: to, text: updatePromptOf(s0), from: actor, threadId: body.thread, edgeId: null, depth: body.depth + 1, via: 'vorlage', update: true }, false);
      return { code: 200, text: tr(`ok: Aktualisieren von ${to} gestartet (${r.id}), läuft im Hintergrund.`, `ok: update of ${to} started (${r.id}), running in the background.`) };
    }
    case 'move': {
      // dg move <node> <new-parent-node>
      const [node, parent] = args;
      if (!node || !parent) return { code: 400, text: tr('dg move <knoten> <neuer-eltern-knoten>', 'dg move <node> <new-parent-node>') };
      if (!nodeById(s0, node) || !nodeById(s0, parent)) return { code: 404, text: tr('dg: Knoten oder Ziel gibt es nicht.', 'dg: node or target does not exist.') };
      if (node === parent || descendants(s0, node).includes(parent)) return { code: 400, text: tr('dg: Ziel liegt im verschobenen Zweig – das ergäbe einen Kreis.', 'dg: target lies inside the moved branch – that would create a cycle.') };
      if (!ancestors(s0, node).length) return { code: 400, text: tr('dg: das Zentrum kann nicht verschoben werden.', 'dg: the center cannot be moved.') };
      if (!mandate && !(canEdit(s0, actor, node) && canEdit(s0, actor, parent))) return { code: 403, text: tr(`dg: ${actor} darf ${node} nicht nach ${parent} verschieben (nur im Auftrag von ${OWNER()} oder im eigenen Bereich).`, `dg: ${actor} may not move ${node} to ${parent} (only on behalf of ${OWNER()} or within its own area).`) };
      return { code: 200, text: mutate((s) => {
        const e = s.edges.find((x) => x.primary && x.to === node)!;
        const old = e.from;
        e.from = parent; e.id = `${parent}>${node}`;
        touch(s, node, 'bot', tr(`${actor}: Zweig von ${old} nach ${parent} verschoben.`, `${actor}: branch moved from ${old} to ${parent}.`));
        touch(s, parent, 'bot', tr(`${actor}: Zweig ${node} hierher verschoben.`, `${actor}: branch ${node} moved here.`));
        return tr(`ok: ${node} hängt jetzt unter ${parent} (vorher ${old})`, `ok: ${node} now hangs under ${parent} (before: ${old})`);
      }) };
    }
    case 'set-todos': {
      const items = args.map((x) => x.trim()).filter(Boolean);
      const pos = items.filter((x) => x.startsWith('+')).map((x) => x.slice(1).trim());
      const neg = items.filter((x) => /^[-−]/.test(x)).map((x) => x.slice(1).trim());
      if (!pos.length && !neg.length) return { code: 400, text: tr('dg set-todos "+positiv" "+…" "-negativ" "-…"', 'dg set-todos "+positive" "+…" "-negative" "-…"') };
      return write((s) => { nodeById(s, target)!.todos = { pos: pos.slice(0, 5), neg: neg.slice(0, 5), at: now(), by: actor }; touch(s, target, 'bot', tr(`${actor}: Kurzlage aktualisiert (${pos.length}+/${neg.length}−).`, `${actor}: short status updated (${pos.length}+/${neg.length}−).`)); return tr(`ok: ${pos.length} positive, ${neg.length} negative To-dos`, `ok: ${pos.length} positive, ${neg.length} negative to-dos`); });
    }
    case 'set-ok': return write((s) => { if (!text) return tr('fehler: Text fehlt', 'error: text missing'); nodeById(s, target)!.okNext = { text: text.slice(0, 160), at: now(), by: actor }; return tr(`ok: Bei OK → ${text}`, `ok: On OK → ${text}`); });
    case 'block': return write((s) => { if (!text) return tr(`fehler: kurz sagen, was ${OWNER()} tun muss`, `error: say briefly what ${OWNER()} needs to do`); nodeById(s, target)!.blocker = { text: text.slice(0, 600), at: now(), by: actor }; touch(s, target, 'bot', `${actor}: Human Blocker – ${text}`); return tr(`ok: Blocker gesetzt – ${OWNER()} sieht ihn im Cockpit`, `ok: blocker set – ${OWNER()} sees it in the cockpit`); });
    case 'unblock': return write((s) => { const n = nodeById(s, target)!; if (!n.blocker) return tr('ok: kein Blocker gesetzt', 'ok: no blocker set'); delete n.blocker; touch(s, target, 'bot', tr(`${actor}: Blocker aufgehoben.`, `${actor}: blocker cleared.`)); return tr('ok: Blocker aufgehoben', 'ok: blocker cleared'); });
    case 'oks': {
      const me = target;
      const subs = mandate && me === rootOf(s0) ? s0.nodes.filter((n) => n.isBot && n.id !== me).map((n) => n.id) : subBots(s0, me);
      const lines = subs.map((id) => { const n = nodeById(s0, id)!; return tr(`- ${n.title} (\`${id}\`): Bei OK → ${n.okNext?.text ?? '(nichts festgelegt)'} · Budget ${okLeft(s0, id)}/${okQuota(s0, id)} heute${n.blocker ? ` · BLOCKER: ${n.blocker.text}` : ''}`, `- ${n.title} (\`${id}\`): On OK → ${n.okNext?.text ?? '(nothing set)'} · budget ${okLeft(s0, id)}/${okQuota(s0, id)} today${n.blocker ? ` · BLOCKER: ${n.blocker.text}` : ''}`); });
      return { code: 200, text: tr(`Dein OK-Budget heute: ${okLeft(s0, me)} von ${okQuota(s0, me)}\n${lines.join('\n') || '- keine Unter-Bots'}`, `Your OK budget today: ${okLeft(s0, me)} of ${okQuota(s0, me)}\n${lines.join('\n') || '- no sub-bots'}`) };
    }
    case 'budget': {
      const to = args[0]; const n = Math.floor(Number(args[1]));
      if (!to || !(n >= 0)) return { code: 400, text: tr('dg budget <unterbot> <n>', 'dg budget <subbot> <n>') };
      if (!nodeById(s0, to)?.isBot) return { code: 400, text: tr(`dg: ${to} ist kein Bot.`, `dg: ${to} is not a bot.`) };
      if (!mandate && chefOfNode(s0, to) !== actor) return { code: 403, text: tr(`dg: ${to} ist nicht dein Unter-Bot.`, `dg: ${to} is not your sub-bot.`) };
      if (!mandate) {
        const others = subBots(s0, actor).filter((x) => x !== to).reduce((a, x) => a + (nodeById(s0, x)?.okBudget ?? 0), 0);
        if (others + n > okQuota(s0, actor)) return { code: 400, text: tr(`dg: zu viel – dein Budget ${okQuota(s0, actor)}, schon verteilt ${others}.`, `dg: too much – your budget ${okQuota(s0, actor)}, already distributed ${others}.`) };
      }
      return { code: 200, text: mutate((s) => { nodeById(s, to)!.okBudget = n; touch(s, to, 'bot', tr(`${actor}: OK-Budget ${n}/Tag.`, `${actor}: OK budget ${n}/day.`)); return tr(`ok: ${to} hat ${n} OKs/Tag`, `ok: ${to} has ${n} OKs/day`); }) };
    }
    case 'ok': {
      const to = args[0];
      if (!to || !nodeById(s0, to)?.isBot) return { code: 400, text: tr('dg ok <unterbot>', 'dg ok <subbot>') };
      if (!mandate && chefOfNode(s0, to) !== actor) return { code: 403, text: tr(`dg: ${to} ist nicht dein Unter-Bot – OK gibt nur sein Chef.`, `dg: ${to} is not your sub-bot – only its chief gives the OK.`) };
      if (!nodeById(s0, to)!.okNext) return { code: 400, text: tr(`dg: ${to} hat kein „Bei OK“ festgelegt.`, `dg: ${to} has no "On OK" set.`) };
      if (!mandate && okLeft(s0, actor) < 1) return { code: 429, text: tr(`dg: dein OK-Budget für heute ist aufgebraucht (${okQuota(s0, actor)}).`, `dg: your OK budget for today is used up (${okQuota(s0, actor)}).`) };
      if (body.depth >= MAX_DEPTH) return { code: 429, text: tr(`dg: maximale Gesprächstiefe (${MAX_DEPTH}) erreicht.`, `dg: maximum conversation depth (${MAX_DEPTH}) reached.`) };
      if (!mandate) mutate((s) => { const a0 = nodeById(s, actor)!; const d = okDay(); a0.okUsed = { day: d, n: (a0.okUsed?.day === d ? a0.okUsed.n : 0) + 1 }; });
      const r = await startRun({ nodeId: to, text: 'OK', from: mandate ? OWNER_ID : actor, threadId: null, edgeId: null, depth: body.depth + 1, via: 'bot' }, false);
      return { code: 200, text: tr(`ok: ${to} führt aus „${nodeById(s0, to)!.okNext!.text}“ (Lauf ${r.id}). Budget übrig: ${mandate ? '–' : okLeft(s0, actor) - 1}`, `ok: ${to} carries out "${nodeById(s0, to)!.okNext!.text}" (run ${r.id}). Budget left: ${mandate ? '–' : okLeft(s0, actor) - 1}`) };
    }
    case 'cockpit': return { code: 200, text: cockpitText() };
    case 'files': { const id = args[0] ?? target; if (hid(id)) return gone(id); if (!nodeById(s0, id)) return { code: 404, text: noNodeMsg(id) }; return { code: 200, text: nodeFiles(id) }; }
    case 'pdf': {
      const [id, src, outp] = args.length > 1 && nodeById(s0, args[0]) ? args : [target, ...args];
      if (!src) return { code: 400, text: tr('dg pdf [<knoten>] <datei.html|.md|.svg> [ziel.pdf]', 'dg pdf [<node>] <file.html|.md|.svg> [target.pdf]') };
      if (id !== actor && !mandate) return { code: 403, text: tr(`dg: PDFs nur im eigenen Ordner (${actor}) – fremde Dateien vorher mit dg read lesen und bei dir ablegen.`, `dg: PDFs only in your own folder (${actor}) – read foreign files with dg read first and save them in your folder.`) };
      const r = await renderPdf(id, src, outp);
      if (r.ok) mutate((s) => touch(s, id, 'datei', tr(`${actor}: PDF ${src.replace(/\.[^.]+$/, '')}.pdf erstellt`, `${actor}: PDF ${src.replace(/\.[^.]+$/, '')}.pdf created`)));
      return { code: r.ok ? 200 : 500, text: r.text };
    }
    case 'read': {
      const [id, ...rp] = args.length > 1 ? args : [target, ...args];
      if (hid(id)) return gone(id);
      if (!nodeById(s0, id)) return { code: 404, text: noNodeMsg(id) };
      const r = readNodeFile(id, rp.join(' '));
      return { code: r.ok ? 200 : 400, text: r.text };
    }
    case 'messages': {
      const id = args[0] ?? target; const n = Math.min(50, Number(args[1]) || 10);
      if (hid(id)) return gone(id);
      if (!nodeById(s0, id)) return { code: 404, text: noNodeMsg(id) };
      return { code: 200, text: s0.botMessages.filter((m) => m.to === id || m.from === id || m.about === id).slice(-n).map((m) => `[${m.at.slice(0, 16).replace('T', ' ')}] ${m.from} → ${m.to}${m.kind !== 'frage' ? ` (${kindLabel(m.kind)})` : ''}:\n${m.text}`).join('\n\n---\n\n') || tr('Noch keine Gespräche.', 'No conversations yet.') };
    }
    case 'decide': {
      const a2 = [...args]; const opt = (f: string) => { const i = a2.indexOf(f); if (i < 0) return null; const v = a2[i + 1]; a2.splice(i, 2); return v ?? null; };
      const kind = (opt('--kind') ?? 'entscheidung') as 'entscheidung' | 'korrektur' | 'annahme';
      const refers = opt('--refers');
      const [content, ...why] = a2;
      if (!content) return { code: 400, text: tr('dg decide "<Entscheidung>" "<Begründung>" [--kind annahme|korrektur] [--refers <id>]', 'dg decide "<decision>" "<rationale>" [--kind annahme|korrektur] [--refers <id>]') };
      if (!['entscheidung', 'korrektur', 'annahme'].includes(kind)) return { code: 400, text: 'dg: --kind entscheidung|korrektur|annahme' };
      if (refers && !s0.decisions.some((d) => d.id === refers)) return { code: 400, text: tr(`dg: Entscheidung ${refers} gibt es nicht (dg decisions).`, `dg: decision ${refers} does not exist (dg decisions).`) };
      return write((s) => {
        const id = `dec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        s.decisions.push({ id, nodeId: target, date: now().slice(0, 10), kind, content: content.slice(0, 600), rationale: why.join(' ').trim().slice(0, 1200) || null, sourceIds: [], refersTo: refers, affectedNodeIds: [], by: actor, at: now() });
        touch(s, target, 'entscheidung', `${actor}: ${tr(kind === 'korrektur' ? 'Korrektur' : kind === 'annahme' ? 'Annahme' : 'Entscheidung', kind === 'korrektur' ? 'Correction' : kind === 'annahme' ? 'Assumption' : 'Decision')} – ${content.slice(0, 160)}`);
        return tr(`ok: ${kind} festgehalten (${id})`, `ok: ${decLabel(kind)} recorded (${id})`);
      });
    }
    case 'decisions': {
      const id = args[0] ?? target;
      if (hid(id)) return gone(id);
      if (!nodeById(s0, id)) return { code: 404, text: noNodeMsg(id) };
      const area = new Set([id, ...descendants(s0, id)].filter((x) => !hid(x)));
      const list = s0.decisions.filter((d) => area.has(d.nodeId));
      const superseded = new Set(s0.decisions.filter((d) => d.refersTo).map((d) => d.refersTo!));
      return { code: 200, text: list.map((d) => `- ${d.id} · ${d.date ?? '?'} · ${decLabel(d.kind)}${superseded.has(d.id) ? tr(' (überholt)', ' (superseded)') : ''} · ${nodeById(s0, d.nodeId)?.title ?? d.nodeId}: ${d.content}${d.rationale ? `\n  ${tr('Begründung', 'Rationale')}: ${d.rationale}` : ''}${d.refersTo ? `\n  ${tr('bezieht sich auf', 'refers to')}: ${d.refersTo}` : ''}`).join('\n') || tr('Noch keine Entscheidungen in diesem Bereich.', 'No decisions in this area yet.') };
    }
    case 'remove': case 'restore': {
      if (!mandate) return { code: 403, text: tr(`dg: ${cmd} nur im Auftrag von ${OWNER()}.`, `dg: ${cmd} only on behalf of ${OWNER()}.`) };
      if (cmd === 'restore') { if (!args[0]) return { code: 200, text: (s0.trash ?? []).map((t) => `- ${t.id}: ${t.title} (${t.nodes.length} ${tr('Knoten', 'nodes')}, ${t.at.slice(0, 16)})`).join('\n') || tr('Papierkorb leer.', 'Trash is empty.') }; return { code: 200, text: mutate((s) => restoreBranch(s, args[0]) ? tr('ok: wiederhergestellt', 'ok: restored') : tr('fehler: nicht im Papierkorb', 'error: not in the trash')) }; }
      const id = args[0] ?? target;
      return { code: 200, text: mutate((s) => removeBranch(s, id, actor) ? tr(`ok: Ast ${id} entfernt (Papierkorb: dg restore)`, `ok: branch ${id} removed (trash: dg restore)`) : tr('fehler: nicht gefunden oder Wurzel', 'error: not found or root')) };
    }
    case 'search': return { code: 200, text: searchText(text, s0, hid) };
    case 'make-bot': {
      // like "create agent" in the cockpit (mkbot), but via dg – only on behalf of the owner
      if (!mandate) return { code: 403, text: tr(`dg: ${cmd} nur im Auftrag von ${OWNER()}.`, `dg: ${cmd} only on behalf of ${OWNER()}.`) };
      const id = args[0] ?? target;
      if (!nodeById(s0, id)) return { code: 404, text: noNodeMsg(id) };
      if (nodeById(s0, id)!.isBot) return { code: 200, text: tr(`ok: ${id} ist schon ein Bot`, `ok: ${id} is already a bot`) };
      ensureNodeFolder(s0, id);
      return { code: 200, text: mutate((s) => { nodeById(s, id)!.isBot = true; touch(s, id, 'bot', tr(`${actor}: Agent angelegt (dg make-bot).`, `${actor}: agent created (dg make-bot).`)); return tr(`ok: ${id} ist jetzt ein Bot`, `ok: ${id} is now a bot`); }) };
    }
    case 'sweep': case 'fill-ok': case 'blockers': case 'auto': {
      if (!mandate) return { code: 403, text: tr(`dg: ${cmd} darf nur ${OWNER()} auslösen (--as ${OWNER_ID}).`, `dg: ${cmd} may only be triggered by ${OWNER()} (--as ${OWNER_ID}).`) };
      const rid0 = rootOf(s0);
      if (cmd === 'auto') { const on = (args[0] ?? '').toLowerCase(); if (!['on', 'an', 'off', 'aus'].includes(on)) return { code: 400, text: tr('dg auto on|off [stunden ohne Aktivität, 0 = unbegrenzt]', 'dg auto on|off [hours without activity, 0 = unlimited]') }; const st = setAuto(on === 'on' || on === 'an', rid0, args[1] !== undefined ? Number(args[1]) : undefined); return { code: 200, text: st.on ? tr(`Autorun läuft (stoppt nach ${st.idleHours || '∞'} h ohne Aktivität).`, `Autorun is running (stops after ${st.idleHours || '∞'} h without activity).`) : tr(`Autorun aus – ${st.oks} OKs gegeben.`, `Autorun off – ${st.oks} OKs given.`) }; }
      if (cmd === 'fill-ok') { const r = fillOk(args[0] ?? rid0); return { code: 200, text: tr(`„Bei OK“ wird festgelegt von: ${r.started.join(', ') || 'niemandem (alle haben eins oder arbeiten)'}`, `"On OK" is being set by: ${r.started.join(', ') || 'nobody (all have one or are working)'}`) }; }
      if (cmd === 'blockers') { const r = blockerSweep(args[0] ?? rid0); return { code: 200, text: tr(`Blocker-Abfrage an: ${r.started.join(', ') || 'niemanden frei'} – Ergebnis später mit dg cockpit.`, `Blocker query sent to: ${r.started.join(', ') || 'nobody free'} – result later with dg cockpit.`) }; }
      const node = args[0] ?? rid0; const scope = (args[1] ?? (node === rid0 ? 'zone' : 'self')) as 'self' | 'next' | 'zone';
      if (!['self', 'next', 'zone'].includes(scope)) return { code: 400, text: tr('dg sweep [knoten] [self|next|zone]', 'dg sweep [node] [self|next|zone]') };
      const r = okCascade(node, scope);
      return { code: 200, text: tr(`OK an: ${r.started.join(', ') || 'niemanden'}${r.skipped.length ? ` · übersprungen (kein „Bei OK“ oder beschäftigt): ${r.skipped.join(', ')}` : ''}`, `OK to: ${r.started.join(', ') || 'nobody'}${r.skipped.length ? ` · skipped (no "On OK" or busy): ${r.skipped.join(', ')}` : ''}`) };
    }
    case 'owner': case 'rules': case 'set-rules': case 'lang': case 'set-model': case 'setup-done': {
      // setup (owner only): name, ground rules, language, models, completion
      const ownerOnly = { code: 403, text: tr('dg: nur der Besitzer (--as owner).', 'dg: owner only (--as owner).') };
      if (cmd === 'rules') return { code: 200, text: s0.globalInstruction?.trim() || tr('(keine Grundregeln)', '(no ground rules)') };
      if (!mandate) return ownerOnly;
      if (cmd === 'owner') {
        if (!text) return { code: 400, text: 'dg owner "<name>"' };
        return { code: 200, text: mutate((s) => { nodeById(s, OWNER_ID)!.title = text.slice(0, 60); touch(s, OWNER_ID, 'bot', tr(`Besitzer heißt jetzt ${text}.`, `Owner is now ${text}.`)); return `ok: ${text}`; }) };
      }
      if (cmd === 'set-rules') {
        if (!text) return { code: 400, text: 'dg set-rules "<rules, one per line>"' };
        return { code: 200, text: mutate((s) => { s.globalInstruction = text.replace(/\\n/g, '\n'); touch(s, OWNER_ID, 'bot', tr('Grundregeln aktualisiert.', 'Ground rules updated.')); return 'ok'; }) };
      }
      if (cmd === 'lang') {
        const l = args[0]; if (l !== 'de' && l !== 'en') return { code: 400, text: 'dg lang de|en' };
        return { code: 200, text: mutate((s) => { s.lang = l; return `ok: ${l}`; }) };
      }
      if (cmd === 'set-model') {
        // dg set-model <bot> claude:sonnet [codex] … – first model = chair
        const [bot, ...ms] = args;
        const n0 = bot && nodeById(s0, bot);
        const members = ms.map((m) => { const [runtime, model = ''] = m.split(':'); return { runtime, model } as BotMember; });
        if (!n0 || !members.length || members.some((m) => !['claude', 'codex', 'chat', 'test'].includes(m.runtime))) return { code: 400, text: tr('dg set-model <bot> claude:sonnet|claude:opus|claude:haiku|claude:fable|codex [weitere …]', 'dg set-model <bot> claude:sonnet|claude:opus|claude:haiku|claude:fable|codex [more …]') };
        return { code: 200, text: mutate((s) => { const n = nodeById(s, bot)!; n.isBot = true; n.agentProfile = { ...(n.agentProfile ?? { name: `Bot ${n.title}`, provider: '', model: '', workdir: '', allowedSourceIds: [], instructions: '' }), members }; ensureNodeFolder(s, bot); return `ok: ${bot} → ${ms.join(' + ')}`; }) };
      }
      return { code: 200, text: mutate((s) => { s.setup = { done: true, at: now() }; return tr('ok: Einrichtung abgeschlossen', 'ok: setup complete'); }) };
    }
    case 'hub': case 'share': case 'unshare': case 'join': case 'leave': case 'shares': case 'connect': case 'contacts': case 'share-with': case 'disconnect': {
      // Cooperation between Minds through the hub (owner only)
      if (!mandate) return { code: 403, text: tr('dg: nur der Besitzer (--as owner).', 'dg: owner only (--as owner).') };
      try {
        if (cmd === 'hub') {
          if (args[0]) { const st = await setHub(args[0], args[1] ?? ''); return { code: 200, text: tr(`ok: verbunden mit ${st.url}. Connector-Adresse: ${st.mcpUrl}`, `ok: connected to ${st.url}. Connector address: ${st.mcpUrl}`) }; }
          const st = hubStatus();
          return { code: 200, text: st.configured ? `${st.url} · ${st.connected ? tr('verbunden', 'connected') : tr('nicht verbunden', 'not connected')}${st.error ? ` (${st.error})` : ''}\nConnector: ${st.mcpUrl}` : tr('Kein Hub. dg hub <url> [hub-key]', 'No hub. dg hub <url> [hub-key]') };
        }
        if (cmd === 'connect') { const r = await connectLink(); return { code: 200, text: tr(`Verbindungslink (einmalig, 7 Tage) – an die andere Person schicken, sie fügt ihn in ihrem Mind unter Regeln → Hub ein:\n${r.link}`, `Connection link (single use, 7 days) – send it to the other person, they paste it in their Mind under Rules → Hub:\n${r.link}`) }; }
        if (cmd === 'contacts') { const l = await contacts(); return { code: 200, text: l.map((x) => `- ${x.name} (\`${x.id}\`)${x.online ? ' · online' : ''}`).join('\n') || tr('Noch keine Verbindungen. dg connect', 'No connections yet. dg connect') }; }
        if (cmd === 'disconnect') { if (!args[0]) return { code: 400, text: 'dg disconnect <mind-id>' }; await removeContact(args[0]); return { code: 200, text: 'ok' }; }
        if (cmd === 'share-with') { const [id, ...who] = args; if (!id) return { code: 400, text: 'dg share-with <knoten> <mind-id …>' }; await shareWith(id, who); return { code: 200, text: who.length ? tr(`ok: „${nodeById(s0, id)?.title}“ geteilt mit ${who.length} Verbindung(en)`, `ok: "${nodeById(s0, id)?.title}" shared with ${who.length} connection(s)`) : tr('ok: nicht mehr geteilt', 'ok: no longer shared') }; }
        if (cmd === 'share') { const id = args[0] ?? target; const r = await shareBranch(id); const inv = `${hubStatus().url.replace(/\/+$/, '')}#${r.code}`; return { code: 200, text: tr(`ok: „${nodeById(s0, id)?.title}“ ist geteilt. Einladung (einmalig, 7 Tage) – an die andere Person schicken, sie gibt sie in ihrem Mind ein:\n${inv}`, `ok: "${nodeById(s0, id)?.title}" is shared. Invitation (single use, 7 days) – send it to the other person, they enter it in their Mind:\n${inv}`) }; }
        if (cmd === 'unshare') { await unshareBranch(args[0] ?? target); return { code: 200, text: tr('ok: nicht mehr geteilt', 'ok: no longer shared') }; }
        if (cmd === 'join') {
          if (!args[0]) return { code: 400, text: 'dg join <link>' };
          const r = await acceptLink(args.join(''));
          return { code: 200, text: r.peer ? tr(`ok: verbunden mit ${r.peer.name}. Ihr könnt jetzt Äste miteinander teilen (⋯ → Teilen mit …).`, `ok: connected with ${r.peer.name}. You can now share branches with each other (⋯ → Share with …).`) : tr(`ok: „${r.share!.title}“ von ${r.share!.owner} erscheint jetzt in deiner Karte.`, `ok: "${r.share!.title}" from ${r.share!.owner} now appears in your map.`) };
        }
        if (cmd === 'leave') { const n = nodeById(s0, args[0] ?? target); if (!n?.remote) return { code: 400, text: tr('dg leave <gespiegelter-knoten>', 'dg leave <mirrored-node>') }; await leaveShare(n.remote.share); return { code: 200, text: 'ok' }; }
        await syncShares();
        const st = hubStatus() as { shares: { title: string; own: boolean; owner: string; members: string[]; ownerOnline: boolean }[] };
        return { code: 200, text: st.shares.map((x) => x.own ? tr(`- geteilt: ${x.title} · mit ${x.members.join(', ') || 'noch niemandem'}`, `- shared: ${x.title} · with ${x.members.join(', ') || 'nobody yet'}`) : tr(`- von ${x.owner}: ${x.title}${x.ownerOnline ? '' : ' (offline)'}`, `- from ${x.owner}: ${x.title}${x.ownerOnline ? '' : ' (offline)'}`)).join('\n') || tr('Keine geteilten Äste.', 'No shared branches.') };
      } catch (e) { return { code: 400, text: `dg: ${(e as Error).message}` }; }
    }
    case 'zep': {
      // dg zep on "<Name>" (owner) · talk <file> · note "<text>" · ask · reset (owner) – memory of the person this node stands for
      const sub = args[0] ?? 'ask'; const rest = args.slice(1);
      const n = nodeById(s0, target)!;
      if (!zepEnabled()) return { code: 400, text: tr('dg: ZEP_API_KEY fehlt beim Mind-Server.', 'dg: ZEP_API_KEY missing on the Mind server.') };
      if (!mandate && !canEdit(s0, actor, target)) return { code: 403, text: tr(`dg: kein Zugriff auf das Gedächtnis von ${n.title}.`, `dg: no access to the memory of ${n.title}.`) };
      try {
        if (sub === 'on') {
          if (!mandate) return { code: 403, text: tr(`dg: Gedächtnis einschalten nur ${OWNER()}.`, `dg: only ${OWNER()} switches memory on.`) };
          const name = rest.join(' ').trim() || n.title.replace(/\s*\(.*\)\s*$/, '');
          await personEnsure(target, name);
          mutate((s) => { const x = nodeById(s, target)!; x.memory = { name, since: now() }; touch(s, target, 'bot', tr(`Gedächtnis (Zep) für ${name} eingeschaltet.`, `Memory (Zep) for ${name} switched on.`)); });
          return { code: 200, text: tr(`ok: ${n.title} hat jetzt ein Gedächtnis für ${name}.`, `ok: ${n.title} now has a memory for ${name}.`) };
        }
        if (!n.memory) return { code: 400, text: tr(`dg: ${n.title} hat kein Gedächtnis – ${OWNER()} schaltet es mit dg zep on "<Name>" ein.`, `dg: ${n.title} has no memory – ${OWNER()} switches it on with dg zep on "<name>".`) };
        if (sub === 'talk') {
          const r = readNodeFile(target, rest.join(' '));
          if (!r.ok) return { code: 400, text: r.text };
          const msgs = parseTalk(r.text, n.memory.name, OWNER());
          if (!msgs.length) return { code: 400, text: tr('dg: keine Zeilen „Name: …“ gefunden.', 'dg: no lines "Name: …" found.') };
          const persons = msgs.filter((m) => m.role === 'user').length;
          await personAdd(target, n.memory.name, msgs);
          mutate((s) => touch(s, target, 'datei', tr(`${actor}: Gespräch ${rest.join(' ')} ins Gedächtnis übernommen (${msgs.length} Aussagen, ${persons} von ${n.memory!.name}).`, `${actor}: conversation ${rest.join(' ')} added to memory (${msgs.length} statements, ${persons} by ${n.memory!.name}).`)));
          return { code: 200, text: tr(`ok: ${msgs.length} Aussagen gespeichert (${persons} von ${n.memory.name}, ${msgs.length - persons} von anderen).`, `ok: ${msgs.length} statements stored (${persons} by ${n.memory.name}, ${msgs.length - persons} by others).`) };
        }
        if (sub === 'note') {
          const t = rest.join(' ').trim(); if (!t) return { code: 400, text: 'dg zep note "<text>"' };
          await personAdd(target, n.memory.name, [{ role: 'assistant', name: tr(`${OWNER()} (Notiz)`, `${OWNER()} (note)`), content: t.slice(0, 4000) }]);
          return { code: 200, text: tr('ok: Notiz im Gedächtnis', 'ok: note stored in memory') };
        }
        if (sub === 'reset') {
          if (!mandate) return { code: 403, text: tr(`dg: nur ${OWNER()}.`, `dg: only ${OWNER()}.`) };
          await personDelete(target).catch(() => {}); await personEnsure(target, n.memory.name);
          return { code: 200, text: tr(`ok: Gedächtnis von ${n.memory.name} geleert.`, `ok: memory of ${n.memory.name} cleared.`) };
        }
        const c = await personContext(target);
        return { code: 200, text: c || tr('(Gedächtnis noch leer)', '(memory still empty)') };
      } catch (e) { return { code: 502, text: `dg: Zep – ${(e as Error).message}` }; }
    }
    case 'reich': {
      // dg reich [node] – show realm · owner only: dg reich <node> --dirs "~/a,~/b" | --dirs - · --privat an|aus
      const a2 = [...args]; const opt = (f: string) => { const i = a2.indexOf(f); if (i < 0) return null; const v = a2[i + 1]; a2.splice(i, 2); return v ?? ''; };
      const dirs = opt('--dirs'); const priv = opt('--privat') ?? opt('--private'); const rd = opt('--read');
      const id = a2[0] ?? target;
      if (!nodeById(s0, id) || hid(id)) return gone(id);
      if (rd !== null) {
        if (!mandate) return { code: 403, text: tr(`dg: Lesefreigaben vergibt nur ${OWNER()} – frag mit dg request.`, `dg: read grants are given by ${OWNER()} only – ask with dg request.`) };
        const l = rd === '-' ? [] : rd.split(',').map((x) => x.trim()).filter(Boolean);
        const bad = l.find((x) => !nodeById(s0, x)); if (bad) return gone(bad);
        mutate((s) => { const n = nodeById(s, id)!; if (l.length) n.readGrants = l; else delete n.readGrants; touch(s, id, 'bot', tr(`${actor}: Lesefreigabe ${l.join(', ') || 'entfernt'}.`, `${actor}: read grant ${l.join(', ') || 'removed'}.`)); });
      }
      if (dirs !== null || priv !== null) {
        if (!mandate) return { code: 403, text: tr(`dg: Arbeitsordner und privat stellt nur ${OWNER()} ein – frag mit dg request.`, `dg: working folders and private are set by ${OWNER()} only – ask with dg request.`) };
        mutate((s) => { const n = nodeById(s, id)!; if (dirs !== null) { const l = dirs === '-' ? [] : dirs.split(',').map((x) => x.trim()).filter(Boolean); if (l.length) n.workDirs = l; else delete n.workDirs; } if (priv !== null) { if (/^(an|on|ja|1)$/i.test(priv)) n.private = true; else delete n.private; } touch(s, id, 'bot', tr(`${actor}: Reich angepasst (${(n.workDirs ?? []).join(', ') || 'keine Arbeitsordner'}${n.private ? ' · privat' : ''}).`, `${actor}: realm adjusted (${(n.workDirs ?? []).join(', ') || 'no working folders'}${n.private ? ' · private' : ''}).`)); return ''; });
      }
      const s1 = normalize(readState() ?? starterState()); const r = reichOf(s1, id); const n = nodeById(s1, id)!;
      if (r.read.length) return { code: 200, text: tr(`Reich von ${n.title}: ${r.nodes.length} Knotenordner · Arbeitsordner: ${r.work.join(', ') || 'keine'} · Lesefreigabe: ${(n.readGrants ?? []).join(', ') || 'geerbt'} (${r.read.length} Ordner, nur lesen)`, `Realm of ${n.title}: ${r.nodes.length} node folders · working folders: ${r.work.join(', ') || 'none'} · read grant: ${(n.readGrants ?? []).join(', ') || 'inherited'} (${r.read.length} folders, read only)`) };
      return { code: 200, text: tr(`Reich von ${n.title}${n.private ? ' (privat)' : ''}:\n- Knotenordner: ${r.nodes.length} (eigener + Unterknoten)\n- Arbeitsordner: ${r.work.join(', ') || 'keine'}${n.workDirs?.length ? `\n- davon eigene: ${n.workDirs.join(', ')}` : ''}`, `Realm of ${n.title}${n.private ? ' (private)' : ''}:\n- Node folders: ${r.nodes.length} (own + child nodes)\n- Working folders: ${r.work.join(', ') || 'none'}${n.workDirs?.length ? `\n- of which own: ${n.workDirs.join(', ')}` : ''}`) };
    }
    case 'request': {
      // request upward: the chief decides within their realm or passes it on; at the very top it lands with the owner (cockpit)
      if (!text) return { code: 400, text: tr('dg request "<was du außerhalb deines Reichs brauchst und warum>"', 'dg request "<what you need outside your realm and why>"') };
      const chef = chefOfNode(s0, actor);
      const me = nodeById(s0, actor)!;
      if (!chef || chef === rootOf(s0) || body.depth >= MAX_DEPTH) {
        mutate((s) => { const n = nodeById(s, actor)!; const t = tr(`Anfrage: ${text}`, `Request: ${text}`); n.blocker = { text: (n.blocker ? `${n.blocker.text} · ${t}` : t).slice(0, 600), at: now(), by: actor }; touch(s, actor, 'bot', tr(`${actor}: Anfrage an ${OWNER()} – ${text}`, `${actor}: request to ${OWNER()} – ${text}`)); });
        return { code: 200, text: tr(`ok: Anfrage liegt bei ${OWNER()} im Cockpit. Arbeite am Rest weiter; die Antwort kommt als neue Nachricht.`, `ok: the request is with ${OWNER()} in the cockpit. Keep working on the rest; the answer arrives as a new message.`) };
      }
      const r = await startRun({ nodeId: chef, from: actor, threadId: body.thread, edgeId: null, depth: body.depth + 1, via: 'bot',
        text: tr(`Anfrage deines Unter-Bots „${me.title}“ (\`${actor}\`) – liegt außerhalb seines Reichs:\n${text}\n\nLiegt es in deinem Reich (dein Knoten, deine Unterknoten, deine Arbeitsordner), entscheide selbst: erledige es oder lehne begründet ab. Liegt es auch außerhalb deines Reichs, reiche es mit \`dg request "…"\` an deinen Chef weiter. Antworte knapp, was entschieden bzw. erledigt ist.`, `Request from your sub-bot "${me.title}" (\`${actor}\`) – it lies outside its realm:\n${text}\n\nIf it lies within your realm (your node, your child nodes, your working folders), decide yourself: do it or decline with a reason. If it also lies outside your realm, pass it on to your chief with \`dg request "…"\`. Answer briefly what was decided or done.`) }, true);
      return { code: r.status === 'fertig' ? 200 : 500, text: r.reply ?? r.error ?? '' };
    }
    case 'ask': {
      const to = args[0];
      const q = args.slice(1).join(' ').trim();
      if (!to || !q) return { code: 400, text: tr('dg ask <bot-knoten> "<frage>"', 'dg ask <bot-node> "<question>"') };
      if ((!nodeById(s0, to)?.isBot && !nodeById(s0, to)?.remote) || hid(to)) return { code: 400, text: tr(`dg: ${to} ist kein Bot.`, `dg: ${to} is not a bot.`) };
      if (to === actor) return { code: 400, text: tr('dg: nicht sich selbst fragen.', 'dg: do not ask yourself.') };
      if (body.depth >= MAX_DEPTH) return { code: 429, text: tr(`dg: maximale Gesprächstiefe (${MAX_DEPTH}) erreicht.`, `dg: maximum conversation depth (${MAX_DEPTH}) reached.`) };
      const r = await startRun({ nodeId: to, text: q, from: actor, threadId: body.thread, edgeId: null, depth: body.depth + 1, via: 'bot' }, true);
      return { code: r.status === 'fertig' ? 200 : 500, text: r.reply ?? r.error ?? '' };
    }
    default: return { code: 400, text: tr(`dg: unbekannter Befehl ${cmd}. Befehle: zep hub connect contacts disconnect share-with share unshare join leave shares owner rules set-rules lang set-model setup-done reich request show tree search messages files read bots folder set-summary set-title add-open close-open add-child move set-plane note set-todos instruction set-instruction update ask set-ok oks ok budget block unblock cockpit sweep fill-ok blockers auto remove restore decide decisions`, `dg: unknown command ${cmd}. Commands: zep hub connect contacts disconnect share-with share unshare join leave shares owner rules set-rules lang set-model setup-done reich request show tree search messages files read bots folder set-summary set-title add-open close-open add-child move set-plane note set-todos instruction set-instruction update ask set-ok oks ok budget block unblock cockpit sweep fill-ok blockers auto remove restore decide decisions`) };
  }
}

// ───────── Runs ─────────

export function addMessage(m: Omit<BotMessage, 'id' | 'at'>) {
  mutate((s) => { s.botMessages.push({ ...m, id: rid('msg'), at: now() }); });
}

function buildPrompt(s: GraphState, nodeId: string, from: string, text: string, about: string | null = null, history = true): string {
  const n = nodeById(s, nodeId)!;
  const sender = from === OWNER_ID ? OWNER() : from.startsWith('partner:') ? tr(`${from.slice(8)} aus einem anderen Mind (Partner, geteilter Ast – gib nur Auskunft zu diesem Ast, sende nichts nach außen)`, `${from.slice(8)} from another Mind (partner, shared branch – only give information about this branch, send nothing outside)`) : tr(`Bot „${nodeById(s, from)?.title}“ (\`${from}\`)`, `Bot "${nodeById(s, from)?.title}" (\`${from}\`)`);
  const ab = about && about !== nodeId ? nodeById(s, about) : null;
  const sec = n.agentProfile?.section ?? 1;
  const hist = history ? s.botMessages.filter((m) => (m.to === nodeId || m.from === nodeId) && (m.section ?? 1) === sec).slice(-8)
    .map((m) => `- ${m.from === OWNER_ID ? OWNER() : m.from === nodeId ? tr('Du', 'You') : m.from}${m.about ? ` (${tr('zu', 'about')} ${m.about})` : ''}: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n') : '';
  return tr(`Du bist der Bot für den Knoten „${n.title}“ (\`${nodeId}\`). Lies zuerst CLAUDE.md in deinem Ordner.

Aktueller Knotenstand:
${nodeContext(s, nodeId)}
${ab ? `\nDie Nachricht betrifft deinen Unterknoten „${ab.title}“ (\`${ab.id}\`), der keinen eigenen Bot hat – du bist zuständig. Änderungen dort mit \`--node ${ab.id}\`.\n${nodeContext(s, ab.id)}\n` : ''}${hist ? `\nBisheriges Gespräch (dieser Abschnitt):\n${hist}\n` : ''}
Nachricht von ${sender}:
${text}

Wenn die Nachricht mit dem Knotenstand oben beantwortbar ist, antworte direkt, ohne Werkzeuge. Sonst arbeite mit dem Werkzeug \`dg\` (Bash). Wenn sich durch deine Arbeit die Lage des Knotens ändert, aktualisiere am Ende die Kurzlage mit \`dg set-todos\` – stichpunktartig \"+Befund → To-do\" (3×) und \"-Befund → To-do\" (2×), To-do mit Verb zuerst, je max. 8 Wörter. Antworte am Ende in wenigen Sätzen auf Deutsch, inkl. was du geändert hast.`, `You are the bot for the node "${n.title}" (\`${nodeId}\`). First read CLAUDE.md in your folder.

Current node status:
${nodeContext(s, nodeId)}
${ab ? `\nThe message concerns your child node "${ab.title}" (\`${ab.id}\`), which has no bot of its own – you are responsible. Make changes there with \`--node ${ab.id}\`.\n${nodeContext(s, ab.id)}\n` : ''}${hist ? `\nConversation so far (this section):\n${hist}\n` : ''}
Message from ${sender}:
${text}

If the message can be answered from the node status above, answer directly, without tools. Otherwise work with the tool \`dg\` (Bash). If your work changes the situation of the node, update the short status at the end with \`dg set-todos\` – in bullet style "+finding → to-do" (3×) and "-finding → to-do" (2×), to-do with a verb first, max. 8 words each. Finish with a few sentences in English, incl. what you changed.`);
}

/**
 * Environment without inherited credentials: no API keys, no base URL/session of the launching Claude session.
 * That way claude/codex use only their own subscription login (claude.ai Max / ChatGPT account).
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE|OPENAI_API_KEY|OPENAI_BASE_URL|AZURE_OPENAI)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function toolStep(name: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => String(p ?? '').split('/').pop();
  switch (name) {
    case 'Bash': return `$ ${String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 140)}`;
    case 'Read': return tr(`Liest ${base(input.file_path)}`, `Reads ${base(input.file_path)}`);
    case 'Write': return tr(`Schreibt ${base(input.file_path)}`, `Writes ${base(input.file_path)}`);
    case 'Edit': return tr(`Bearbeitet ${base(input.file_path)}`, `Edits ${base(input.file_path)}`);
    case 'Glob': return tr(`Sucht Dateien ${String(input.pattern ?? '')}`, `Finds files ${String(input.pattern ?? '')}`);
    case 'Grep': return tr(`Durchsucht nach „${String(input.pattern ?? '').slice(0, 40)}“`, `Searches for "${String(input.pattern ?? '').slice(0, 40)}"`);
    default: return `${name} …`;
  }
}

let authCache: { at: number; ok: boolean; info: string } | null = null;
/** Claude runs only with a subscription login (claude.ai), never via API key. */
function claudeSubscriptionOk(): Promise<{ ok: boolean; info: string }> {
  if (authCache && Date.now() - authCache.at < 5 * 60_000) return Promise.resolve(authCache);
  return new Promise((resolve) => {
    const p = spawn('claude', ['auth', 'status'], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({ ok: false, info: tr('claude nicht installiert', 'claude not installed') }));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const ok = j.loggedIn && j.authMethod === 'claude.ai' && !!j.subscriptionType;
        authCache = { at: Date.now(), ok, info: ok ? tr(`Abo ${j.subscriptionType}`, `Subscription ${j.subscriptionType}`) : tr(`Login: ${j.authMethod ?? 'keiner'}`, `Login: ${j.authMethod ?? 'none'}`) };
      } catch { authCache = { at: Date.now(), ok: false, info: tr('Login-Status unbekannt', 'login status unknown') }; }
      resolve(authCache);
    });
  });
}

export async function spawnRuntime(rt: Runtime, model: string, cwd: string, prompt: string, env: NodeJS.ProcessEnv, onStep: (t: string) => void = () => {}, onSession: (id: string) => void = () => {}): Promise<string> {
  if (rt === 'claude') {
    const a = await claudeSubscriptionOk();
    if (!a.ok) throw new Error(tr(`Claude Code ist nicht mit einem Abo angemeldet (${a.info}) – kein API-Lauf. Im Terminal: claude auth login (claude.ai-Konto wählen).`, `Claude Code is not signed in with a subscription (${a.info}) – no API run. In the terminal: claude auth login (choose the claude.ai account).`));
  }
  return spawnRuntimeInner(rt, model, cwd, prompt, env, onStep, onSession);
}

function spawnRuntimeInner(rt: Runtime, model: string, cwd: string, prompt: string, env: NodeJS.ProcessEnv, onStep: (t: string) => void, onSession: (id: string) => void = () => {}): Promise<string> {
  if (rt === 'chat') {
    return new Promise((resolve) => {
      const key = env.DG_RUN!;
      mkdirSync(INBOX_DIR, { recursive: true });
      const p: ChatPending = { key, nodeId: env.DG_NODE!, threadId: env.DG_THREAD!, depth: Number(env.DG_DEPTH ?? 0), readonly: env.DG_READONLY === '1', prompt, createdAt: now(), resolve };
      chatPending.set(key, p);
      writeFileSync(join(INBOX_DIR, `${key}.json`), JSON.stringify({ key, nodeId: p.nodeId, threadId: p.threadId, depth: p.depth, readonly: p.readonly, prompt, createdAt: p.createdAt, from: env.DG_FROM, edgeId: env.DG_EDGE || null, runId: env.DG_RUNID }, null, 2));
      writeFileSync(join(INBOX_DIR, `${key}.md`), tr(`${prompt}\n\n---\nBot: ${p.nodeId} · Ordner: ${cwd}\nÄnderungen: ${join(BIN_DIR, 'dg')} --run ${key} <befehl>\nAntwort: ${join(BIN_DIR, 'dg')} reply ${key} "<antwort>"\n`, `${prompt}\n\n---\nBot: ${p.nodeId} · Folder: ${cwd}\nChanges: ${join(BIN_DIR, 'dg')} --run ${key} <command>\nAnswer: ${join(BIN_DIR, 'dg')} reply ${key} "<answer>"\n`));
    });
  }
  return new Promise((resolve, reject) => {
    let cmd: string; let argv: string[]; let lastFile: string | null = null;
    const ro = env.DG_READONLY === '1';
    const effort = env.DG_EFFORT || 'low';
    // realm: writing only here (sandbox), foreign/personal folders not even readable
    const reich: { nodes: string[]; work: string[] } = env.DG_REICH ? JSON.parse(env.DG_REICH) : { nodes: [cwd], work: [] };
    const denies: string[] = env.DG_DENY ? JSON.parse(env.DG_DENY) : [];
    const writable = [...new Set([...reich.nodes, ...reich.work])];
    if (rt === 'claude') {
      cmd = 'claude';
      const rule = (p: string) => `//${p.replace(/^\//, '')}/**`;
      // web, Google accounts (via your claude.ai account): read/draft for everyone; sending only with OK or permanent permission
      const mailOk = env.DG_MAIL === '1';
      const outward = ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward', 'mcp__claude_ai_Google_Drive__share_file',
        'mcp__claude_ai_Google_Calendar__create_event', 'mcp__claude_ai_Google_Calendar__update_event', 'mcp__claude_ai_Google_Calendar__delete_event', 'mcp__claude_ai_Google_Calendar__respond_to_event'];
      const neverTools = ['mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__claude_ai_Gmail__delete_draft', 'mcp__claude_ai_Gmail__delete_label',
        'mcp__claude_ai_Google_Drive__trash_file', 'mcp__claude_ai_Railway', 'mcp__claude_ai_Mind'];
      const webTools = ['WebSearch', 'WebFetch', 'mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Drive', 'mcp__claude_ai_Google_Docs', 'mcp__claude_ai_Google_Sheets', 'mcp__claude_ai_Google_Calendar'];
      const deny = [...neverTools, ...(mailOk ? [] : outward), ...denies.flatMap((d) => [`Read(${rule(d)})`, `Edit(${rule(d)})`])];
      // Bash runs in the sandbox: free within the realm (Python, Node, git, tests …), no writing outside, blocked folders not readable
      const settings = { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowLocalBinding: true, allowedDomains: ['*'] }, filesystem: { denyRead: denies } } };
      const tools = ['Bash', 'Read', 'Glob', 'Grep', ...webTools, ...(ro ? [] : writable.map((d) => `Edit(${rule(d)})`))];
      argv = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
        // lean: no global plugins/hooks/skills; the node's CLAUDE.md still applies
        '--setting-sources', 'project', '--disable-slash-commands', '--effort', effort,
        ...writable.flatMap((d) => ['--add-dir', d]), '--settings', JSON.stringify(settings),
        '--permission-mode', 'dontAsk', '--allowedTools', ...tools,
        '--disallowedTools', ...deny, ...(ro ? ['Write', 'Edit'] : []), ...(model ? ['--model', model] : []), ...(env.DG_SESSION ? ['--resume', env.DG_SESSION] : [])];
    } else if (rt === 'codex') {
      lastFile = join(tmpdir(), `dg-codex-${Date.now()}.txt`);
      cmd = 'codex';
      argv = ['exec', '--json', '--skip-git-repo-check', '-c', `model_reasoning_effort=${({ low: 'low', medium: 'medium' } as Record<string, string>)[effort] ?? 'high'}`,
        // Codex: writing only in the realm (workspace-write), web on; Codex cannot block reading
        ...(ro ? ['-s', 'read-only'] : ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']), '-C', cwd, ...writable.filter((d) => d !== cwd).flatMap((d) => ['--add-dir', d]), '--output-last-message', lastFile, ...(model ? ['-m', model] : []), prompt];
    } else {
      cmd = process.execPath;
      argv = [join(BIN_DIR, 'testbot.mjs'), prompt];
    }
    const p = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const rid0 = env.DG_RUNID ?? '';
    if (!procs.has(rid0)) procs.set(rid0, new Set());
    procs.get(rid0)!.add(p);
    let out = ''; let err = ''; let buf = ''; let final: { text: string; error: boolean } | null = null; let fatal = '';
    // live steps from the JSON stream (Claude stream-json / Codex --json)
    const onLine = (line: string) => {
      let j: any;
      try { j = JSON.parse(line); } catch { return; }
      if (rt === 'claude') {
        if (j.session_id && (j.type === 'system' || j.type === 'result')) onSession(String(j.session_id));
        if (j.type === 'result') { final = { text: String(j.result ?? ''), error: !!j.is_error }; return; }
        if (j.type === 'assistant') for (const c of j.message?.content ?? []) {
          if (c.type === 'thinking') onStep(tr('Denkt nach …', 'Thinking …'));
          else if (c.type === 'text' && c.text?.trim()) onStep(`💬 ${c.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
          else if (c.type === 'tool_use') onStep(toolStep(c.name, c.input ?? {}));
        }
      } else if (rt === 'codex') {
        const errText = j.type === 'error' || j.type === 'turn.failed' ? String(j.message ?? j.error?.message ?? line) : '';
        if (errText && /usage limit|rate limit|not supported|requires a newer/i.test(errText)) { fatal = errText.slice(0, 400); p.kill('SIGTERM'); return; }
        const it = j.item ?? j.msg ?? {};
        const t = it.type ?? j.type;
        if (/reasoning/.test(t)) onStep(tr('Denkt nach …', 'Thinking …'));
        else if (/command/.test(t) && (it.command || it.cmd)) onStep(`$ ${String(it.command ?? it.cmd).replace(/^.*-lc\s+/, '').slice(0, 140)}`);
        else if (/agent_message/.test(t) && it.text) onStep(`💬 ${String(it.text).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    };
    p.stdout.on('data', (d) => {
      out += d;
      if (rt === 'test') { String(d).split('\n').filter(Boolean).forEach((l) => onStep(l.slice(0, 160))); return; }
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(onLine);
    });
    p.stderr.on('data', (d) => {
      err += d;
      // Codex reports quota/version errors on stderr and then repeats endlessly – abort immediately
      if (rt === 'codex' && !fatal) { const m = String(d).match(/ERROR: (.*(usage limit|not supported|requires a newer).*)/i); if (m) { fatal = m[1].slice(0, 400); p.kill('SIGTERM'); } }
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(tr(`${cmd} nicht startbar: ${e.message}`, `${cmd} cannot be started: ${e.message}`))); });
    p.on('close', (code) => {
      clearTimeout(timer);
      procs.get(rid0)?.delete(p);
      if (cancelled.has(rid0)) return reject(new Error(tr('Von dir abgebrochen.', 'Cancelled by you.')));
      if (fatal) return reject(new Error(`ChatGPT/Codex: ${fatal}`));
      if (timedOut) return reject(new Error(tr(`Zeitlimit von ${TIMEOUT_MS / 60_000} min erreicht – Lauf abgebrochen. Letzter Schritt siehe „Schritte“.`, `Time limit of ${TIMEOUT_MS / 60_000} min reached – run cancelled. See "Steps" for the last step.`)));
      if (rt === 'claude') {
        if (buf.trim()) onLine(buf);
        const f = final as { text: string; error: boolean } | null;
        if (!f) return reject(new Error((err || out || tr(`claude beendet mit ${code}`, `claude exited with ${code}`)).slice(-600)));
        return f.error ? reject(new Error(f.text || tr('Claude-Fehler', 'Claude error'))) : resolve(f.text.trim());
      }
      if (rt === 'codex') {
        const t = lastFile && existsSync(lastFile) ? readFileSync(lastFile, 'utf8').trim() : '';
        if (lastFile) rmSync(lastFile, { force: true });
        return code === 0 && t ? resolve(t) : reject(new Error((err || out).split('\n').filter((l) => /error/i.test(l)).slice(-2).join(' ').slice(-600) || tr(`codex beendet mit ${code}`, `codex exited with ${code}`)));
      }
      return code === 0 ? resolve(out.trim()) : reject(new Error((err || out).slice(-600)));
    });
  });
}

/** Question to the bot of a mirrored branch: goes through the hub to the other Mind; the answer is recorded here. */
function remoteRun(a: { nodeId: string; text: string; from: string; threadId?: string | null; edgeId: string | null; depth: number; via: BotMessage['via']; about?: string | null }, origin: string, wait: boolean): Promise<RunInfo> {
  const info: RunInfo = { id: rid('run'), nodeId: a.nodeId, from: a.from, threadId: a.threadId || rid('thr'), edgeId: a.edgeId, depth: a.depth, status: 'läuft', runtime: 'chat', model: tr(`Mind von ${origin}`, `${origin}'s Mind`), startedAt: now(), steps: [] };
  runs.set(info.id, info);
  addMessage({ threadId: info.threadId, from: a.from, to: a.nodeId, text: a.text, edgeId: a.edgeId, runId: info.id, kind: 'frage', via: a.via, about: a.nodeId });
  const done = askRemote(a.nodeId, a.text, () => info.steps.push({ at: now(), text: tr(`${origin}s Mind ist gerade offline – die Frage wartet beim Hub.`, `${origin}'s Mind is offline right now – the question waits at the hub.`) }))
    .then((r) => { info.status = 'fertig'; info.reply = r ?? ''; })
    .catch((e: Error) => { info.status = 'fehlgeschlagen'; info.error = e.message; })
    .finally(() => {
      info.endedAt = now();
      // no answer within 30 min: it is recorded later, whenever the other Mind answers
      if (info.status === 'fertig' && !info.reply) { info.reply = tr(`Die Antwort von ${origin} kommt nach – sie erscheint hier, sobald sein Mind geantwortet hat.`, `The answer from ${origin} will follow – it appears here once their Mind has answered.`); return; }
      addMessage({ threadId: info.threadId, from: a.nodeId, to: a.from, text: info.reply ?? tr(`Fehler: ${info.error}`, `Error: ${info.error}`), edgeId: a.edgeId, runId: info.id, kind: info.status === 'fertig' ? 'antwort' : 'fehler', via: 'bot', runtime: info.model, about: a.nodeId });
    });
  return wait ? done.then(() => info) : Promise.resolve(info);
}

export async function startRun(
  a: { nodeId: string; text: string; from: string; threadId?: string | null; edgeId: string | null; depth: number; via: BotMessage['via']; about?: string | null; newSection?: boolean; update?: boolean; viaConnector?: boolean; brief?: boolean },
  wait: boolean,
): Promise<RunInfo> {
  ensureBin();
  const s = normalize(readState() ?? starterState());
  const node = nodeById(s, a.nodeId);
  if (!node) throw new Error(tr(`Knoten ${a.nodeId} fehlt`, `Node ${a.nodeId} is missing`));
  if (node.remote) return remoteRun(a, node.remote.origin, wait);
  const members = membersFor(s, a.nodeId);
  const chair = members[0];
  const info: RunInfo = {
    id: rid('run'), nodeId: a.nodeId, from: a.from, threadId: a.threadId || rid('thr'), edgeId: a.edgeId, depth: a.depth,
    status: 'läuft', runtime: chair.runtime, model: members.length > 1 ? members.map(label).join(' + ') : chair.model, startedAt: now(), steps: [],
  };
  const step = (prefix: string) => (t: string) => {
    const last = info.steps.at(-1);
    if (last && last.text === prefix + t) return;
    info.steps.push({ at: now(), text: prefix + t });
    if (info.steps.length > 60) info.steps.splice(0, info.steps.length - 60);
  };
  runs.set(info.id, info);
  const dir = ensureNodeFolder(s, a.nodeId);
  const prof = node.agentProfile;
  const section = prof?.section ?? 1;
  // memory: continue the Claude session per bot (single model, Claude only) until the section gets long
  const SECTION_MAX = 25;
  const resumable = members.length === 1 && chair.runtime === 'claude' && a.from === OWNER_ID;
  const session = resumable && prof?.session?.id ? prof.session : null;
  const rollover = !!session && session.runs + 1 >= SECTION_MAX;
  addMessage({ threadId: info.threadId, from: a.from, to: a.nodeId, text: a.text, edgeId: a.edgeId, runId: info.id, kind: 'frage', via: a.via, about: a.about ?? null, section });
  const env = (readonly: boolean) => ({
    ...cleanEnv(), PATH: `${BIN_DIR}:${process.env.PATH}`, DG_API: apiBase, DG_NODE: a.nodeId, DG_THREAD: info.threadId,
    DG_DEPTH: String(a.depth), DG_READONLY: readonly ? '1' : '0', DG_FROM: a.from, DG_EDGE: a.edgeId ?? '', DG_RUNID: info.id,
    DG_EFFORT: node.agentProfile?.effort ?? 'low', DG_REICH: JSON.stringify(reich), DG_DENY: JSON.stringify(denies), DG_MANDATE: mandate ? OWNER_ID : '', DG_MAIL: mailAllowed ? '1' : '',
  });
  // direct order from the owner: may change anything in the graph and work on the app code.
  const mandate = a.from === OWNER_ID;
  // realm: own node + child nodes + (inherited) working folders. Via the online connector only the own folder.
  const reich = a.viaConnector ? { nodes: [realOr(resolve(dir))], work: [] as string[], read: [] as string[] } : reichOf(s, a.nodeId);
  const denies = readDenies([...reich.nodes, ...reich.work, ...reich.read]);
  const readNote = reich.read.length ? tr(`\nLesefreigabe (nur lesen, nicht schreiben): ${reich.read.map((d) => `\`${d}\``).join(', ')}.`, `\nRead grant (read only, no writing): ${reich.read.map((d) => `\`${d}\``).join(', ')}.`) : '';
  const subIds = descendants(s, a.nodeId);
  const accessNote = tr(`## Dein Reich (hier darfst du alles)
Dein Knoten${subIds.length ? ` und alle ${subIds.length} Unterknoten (${subIds.slice(0, 8).map((x) => `\`${x}\``).join(', ')}${subIds.length > 8 ? ', …' : ''})` : ''} mit ihren Ordnern unter ${NODES_DIR}${reich.work.length ? `, dazu die Arbeitsordner ${reich.work.map((d) => `\`${d}\``).join(', ')}` : ''}.
Dort arbeitest du mit allen Werkzeugen und ohne Rückfrage: Bash, Python, Node, git (commit, push), Tests, Dateien anlegen und ändern, PDFs (\`dg pdf\`), Web-Recherche. Bash läuft in einer Sandbox: Außerhalb deines Reichs ist Schreiben technisch gesperrt; persönliche Ordner (Downloads, Dokumente, Desktop), Mind-Daten und die Ordner fremder Knoten sind auch fürs Lesen gesperrt.
Andere Bereiche siehst du nur über \`dg show\` / \`dg read\` (private Äste gar nicht). Brauchst du etwas außerhalb deines Reichs (dort ändern, einen Ordner, einen Zugang): \`dg request "<was und warum>"\` – dein Chef entscheidet oder reicht es weiter, notfalls bis ${OWNER()}. Versuche nie, die Sandbox zu umgehen.
Token sparen: Lies nur, was du für diese Aufgabe wirklich brauchst. Kein vorsorgliches Durchsuchen von Baum, Repos oder Ordnern.`, `## Your realm (you may do anything here)
Your node${subIds.length ? ` and all ${subIds.length} child nodes (${subIds.slice(0, 8).map((x) => `\`${x}\``).join(', ')}${subIds.length > 8 ? ', …' : ''})` : ''} with their folders under ${NODES_DIR}${reich.work.length ? `, plus the working folders ${reich.work.map((d) => `\`${d}\``).join(', ')}` : ''}.
There you work with all tools and without asking: Bash, Python, Node, git (commit, push), tests, creating and changing files, PDFs (\`dg pdf\`), web research. Bash runs in a sandbox: outside your realm writing is technically blocked; personal folders (Downloads, Documents, Desktop), Mind data and the folders of other nodes are blocked for reading too.
You see other areas only via \`dg show\` / \`dg read\` (private branches not at all). If you need something outside your realm (change something there, a folder, an access): \`dg request "<what and why>"\` – your chief decides or passes it on, if necessary up to ${OWNER()}. Never try to circumvent the sandbox.
Save tokens: read only what you really need for this task. No precautionary searching of the tree, repos or folders.`);
  const closing = rollover
    ? tr('\n\nDieser Gesprächsabschnitt ist lang geworden: Schreibe nach deiner Antwort in deine CLAUDE.md unter „## Gesprächsabschnitte“ eine Zusammenfassung dieses Abschnitts (5–8 Stichpunkte: Ergebnisse, Entscheidungen, offene Fragen). Danach beginnt ein neuer Abschnitt.', '\n\nThis conversation section has gotten long: after your answer, write a summary of this section in your CLAUDE.md under "## Conversation sections" (5–8 bullet points: results, decisions, open questions). After that a new section begins.')
    : '';
  // with a resumed session the bot already knows the conversation – no history needed in the prompt
  const instr = a.update ? tr(`\n\n## Arbeitsanweisungen\n${instructionChain(s, a.nodeId)}`, `\n\n## Work instructions\n${instructionChain(s, a.nodeId)}`)
    : s.globalInstruction?.trim() ? tr(`\n\n## Grundregeln (für alle Bots)\n${s.globalInstruction.trim()}`, `\n\n## Ground rules (for all bots)\n${s.globalInstruction.trim()}`) : '';
  const isOk = /^\s*ok[.!]?\s*$/i.test(a.text);
  // sending (mail, sharing Drive, invitations): permanently allowed or this run is an OK from the owner/chief
  const mailAllowed = node.agentProfile?.mailSend === 'immer' || (isOk && !a.viaConnector);
  const giver = a.from === OWNER_ID ? OWNER() : a.from.startsWith('partner:') ? a.from.slice(8) : tr(`deinem Chef „${nodeById(s, a.from)?.title ?? a.from}“`, `your chief "${nodeById(s, a.from)?.title ?? a.from}"`);
  const askText = a.brief ? tr(`Kurze Rückfrage von ${OWNER()} aus seinem Cockpit zu deinem „Bei OK“ („${node.okNext?.text ?? '–'}“):\n${a.text}\n\nAntworte knapp in 1–2 kurzen Sätzen, ohne Überschriften. Führe nichts aus, außer ${OWNER()} erlaubt es ausdrücklich in dieser Rückfrage. Ändert sich dadurch dein nächster Schritt, ende mit der neuen Zeile „Bei OK werde ich: …“.`, `Short follow-up question from ${OWNER()} in their cockpit about your "On OK" ("${node.okNext?.text ?? '–'}"):\n${a.text}\n\nAnswer briefly in 1–2 short sentences, without headings. Do not execute anything unless ${OWNER()} explicitly allows it in this follow-up. If your next step changes as a result, end with the new line "On OK I will: …".`) : isOk ? tr(`OK – Freigabe von ${giver}. Führe jetzt deine angekündigte nächste Handlung aus: „${node.okNext?.text ?? '(nicht festgelegt – wähle den nächsten sinnvollen Schritt deines Bereichs)'}“. Höre danach nicht auf: Arbeite die Folgeschritte, die sich daraus ergeben und keine Freigabe brauchen, gleich mit ab, bis das Arbeitspaket fertig ist oder du an eine echte Grenze kommst. Danach kurz berichten, was erledigt ist.`, `OK – approval from ${giver}. Now carry out your announced next action: "${node.okNext?.text ?? '(not set – choose the next sensible step of your area)'}". Do not stop there: also work through the follow-up steps that result from it and need no approval, until the work package is done or you hit a real boundary. Then briefly report what is done.`) : a.text;
  const subs = subBots(s, a.nodeId);
  const okInfo = subs.length ? tr(` Dein OK-Budget heute: ${okLeft(s, a.nodeId)} von ${okQuota(s, a.nodeId)}. Unter-Bots und ihr „Bei OK“: \`dg oks\`; Freigabe: \`dg ok <bot>\` (nur wenn es sich lohnt); Budget verteilen: \`dg budget <bot> <n>\`.`, ` Your OK budget today: ${okLeft(s, a.nodeId)} of ${okQuota(s, a.nodeId)}. Sub-bots and their "On OK": \`dg oks\`; approval: \`dg ok <bot>\` (only when worthwhile); distribute budget: \`dg budget <bot> <n>\`.`) : '';
  const mailNote = mailAllowed ? (node.agentProfile?.mailSend === 'immer' ? tr('E-Mails senden ist für dich dauerhaft erlaubt – sorgfältig, nur was zu deinem Auftrag gehört.', 'Sending e-mails is permanently allowed for you – carefully, only what belongs to your task.') : tr('Mit diesem OK darfst du genau die im „Bei OK“ angekündigten E-Mails/Einladungen senden – nichts anderes.', 'With this OK you may send exactly the e-mails/invitations announced in your "On OK" – nothing else.')) : tr(`E-Mails NIE senden (auch nicht antworten/weiterleiten/teilen/einladen): nur als Entwurf anlegen (create_draft) und als „Bei OK werde ich: Mail an … senden“ ankündigen – gesendet wird erst nach OK von ${OWNER()} oder deinem Chef.`, `NEVER send e-mails (also no replying/forwarding/sharing/inviting): only create a draft (create_draft) and announce it as "On OK I will: send mail to …" – it is sent only after an OK from ${OWNER()} or your chief.`);
  const okRule = tr(`\n\nAbschluss jeder Antwort: eine eigene letzte Zeile „Bei OK werde ich: <nächste Handlung, max. 8 Wörter>“ – das nächste größere Arbeitspaket oder die nächste freigabepflichtige Handlung, die du ausführst, sobald ${OWNER()} oder dein Chef OK sagt. Kein Kleinschritt. Arbeitsweise: Arbeite selbstständig und am Stück. Alles in deinem Bereich, was sich rückgängig machen lässt, erledigst du sofort und ohne Rückfrage, auch mehrere Schritte hintereinander: lesen, recherchieren, prüfen, rechnen, Dateien in deinem Knotenordner anlegen und ändern, Entwürfe schreiben, deinen Knoten pflegen (Kurzlage, To-dos, offene Punkte, Entscheidungen). Kündige solche Schritte nicht als „Bei OK“ an und frage nicht wegen Kleinigkeiten – mach sie. Ein OK brauchst du nur für: Versand nach außen (Mails, Teilen, Einladungen, Posts), Geld, Zahlungen und Orders, Live-Systeme und Deploys, Löschen oder Überschreiben von Daten außerhalb deines Knotenordners, Änderungen außerhalb deines Bereichs und Richtungsentscheidungen, die ${OWNER()} treffen muss. Unsichere Annahmen hältst du als Annahme fest (\`dg decide --kind annahme\`) und arbeitest weiter, statt zu warten. Du hast Web (WebSearch/WebFetch) und dein Google-Konto (Gmail lesen/Entwürfe, Drive, Docs, Sheets, Kalender lesen). ${mailNote} Human Blocker: Kommst du nur mit ${OWNER()} weiter (Entscheidung, Zugang, Daten, Login, Zahlung …), setze \`dg block "<was ${OWNER()} tun muss>"\`; ist es erledigt, \`dg unblock\`. Blocker deiner Unter-Bots siehst du in \`dg oks\` – ${OWNER()} sieht alle gesammelt. Entscheidungen (Strategie, Parameter, Vorgehen – von dir oder ${OWNER()}) hältst du mit \`dg decide "<was>" "<warum, mit Beleg>"\` fest; revidierst du eine frühere, mit \`--kind korrektur --refers <id>\` (IDs: \`dg decisions\`).${okInfo}`, `\n\nEnd of every answer: a separate last line "On OK I will: <next action, max. 8 words>" – the next larger work package or the next action that needs approval, which you carry out as soon as ${OWNER()} or your chief says OK. No small steps. Way of working: work independently and in one go. Everything in your area that can be undone you do immediately and without asking, also several steps in a row: reading, researching, checking, calculating, creating and changing files in your node folder, writing drafts, maintaining your node (short status, to-dos, open points, decisions). Do not announce such steps as "On OK" and do not ask about trivia – just do them. You need an OK only for: sending to the outside (mails, sharing, invitations, posts), money, payments and orders, live systems and deploys, deleting or overwriting data outside your node folder, changes outside your area and strategic decisions that ${OWNER()} has to make. You record uncertain assumptions as an assumption (\`dg decide --kind annahme\`) and keep working instead of waiting. You have web (WebSearch/WebFetch) and your Google account (read Gmail/drafts, Drive, Docs, Sheets, read calendar). ${mailNote} Human Blocker: if you can only continue with ${OWNER()} (decision, access, data, login, payment …), set \`dg block "<what ${OWNER()} needs to do>"\`; once it is done, \`dg unblock\`. You see the blockers of your sub-bots in \`dg oks\` – ${OWNER()} sees all of them collected. You record decisions (strategy, parameters, approach – by you or ${OWNER()}) with \`dg decide "<what>" "<why, with evidence>"\`; if you revise an earlier one, use \`--kind korrektur --refers <id>\` (IDs: \`dg decisions\`).${okInfo}`);
  // Long-term memory of the contact person (Zep): fetched before the answer; stored only what the bot assigns explicitly (dg zep talk/note)
  const mem = node.memory && zepEnabled() ? node.memory : null;
  let zepCtx = '';
  if (mem && !a.brief) { try { zepCtx = await personContext(a.nodeId); } catch (e) { console.warn('zep:', (e as Error).message); } }
  const memNote = mem ? tr(`\n\n## Gedächtnis zu ${mem.name} (Zep)
Dieser Knoten steht für die Person ${mem.name}. Gibt dir ${OWNER()} ein Gespräch mit ${mem.name} (Text, Diktat oder Datei), dann: 1) speichere es wörtlich als \`gespraeche/<JJJJ-MM-TT>-<thema>.md\` in deinem Ordner, Zeilen im Format „${mem.name.split(' ')[0]}: …“ und „${OWNER()}: …“ (ordne jede Aussage dem richtigen Sprecher zu; bei Zusammenfassungen schreibe, wer was gesagt hat); 2) übertrage es mit \`dg zep talk <datei>\` ins Gedächtnis. Eigene Beobachtungen oder Infos über ${mem.name} aus anderen Quellen: \`dg zep note "<text>"\`. Gedächtnis abfragen: \`dg zep ask\`. Speichere keine Arbeitsaufträge von ${OWNER()} an dich als Gespräch.`, `\n\n## Memory of ${mem.name} (Zep)
This node stands for the person ${mem.name}. When ${OWNER()} gives you a conversation with ${mem.name} (text, dictation or file): 1) save it verbatim as \`gespraeche/<YYYY-MM-DD>-<topic>.md\` in your folder, lines formatted "${mem.name.split(' ')[0]}: …" and "${OWNER()}: …" (assign every statement to the right speaker; for summaries, write who said what); 2) transfer it to the memory with \`dg zep talk <file>\`. Your own observations or information about ${mem.name} from other sources: \`dg zep note "<text>"\`. Query the memory: \`dg zep ask\`. Do not store ${OWNER()}'s work instructions to you as a conversation.`) : '';
  const base = `${zepCtx ? tr(`Gedächtnis (Zep) zu ${mem!.name} und euren Absprachen:\n${zepCtx}\n\n`, `Memory (Zep) of ${mem!.name} and your agreements:\n${zepCtx}\n\n`) : ''}${buildPrompt(s, a.nodeId, a.from, askText, a.about ?? null, !session)}${instr}\n\n${accessNote}${readNote}${memNote}${okRule}${closing}`;
  let newSession: string | null = null;
  let usedLabel = label(chair);

  const job = (async () => {
    if (members.length === 1) return spawnRuntime(chair.runtime, chair.model, dir, base, { ...env(false), DG_RUN: info.id, ...(session ? { DG_SESSION: session.id } : {}) }, step(''), (sid) => { newSession = sid; });
    // round 1: all models independently, read-only
    const proposalPrompt = `${base}\n\n` + tr(`Du bist eines von ${members.length} Modellen, die diese Nachricht unabhängig beantworten (Vorschlagsrunde). Du darfst nur lesen (dg show/tree/bots). Schreibe deine Antwort und, falls nötig, die konkreten Änderungen als dg-Befehle – führe sie NICHT aus.`, `You are one of ${members.length} models that answer this message independently (proposal round). You may only read (dg show/tree/bots). Write your answer and, if needed, the concrete changes as dg commands – do NOT execute them.`);
    const results = await Promise.allSettled(members.map((m, i) => spawnRuntime(m.runtime, m.model, dir, proposalPrompt, { ...env(true), DG_RUN: `${info.id}-v${i + 1}` }, step(`[${label(m)}] `))));
    const proposals: { m: BotMember; text: string }[] = [];
    results.forEach((r, i) => {
      const text = r.status === 'fulfilled' ? r.value : tr(`Fehler: ${(r.reason as Error).message}`, `Error: ${(r.reason as Error).message}`);
      if (r.status === 'fulfilled') proposals.push({ m: members[i], text });
      addMessage({ threadId: info.threadId, from: a.nodeId, to: a.from, text, edgeId: a.edgeId, runId: info.id, kind: r.status === 'fulfilled' ? 'vorschlag' : 'fehler', via: 'bot', runtime: label(members[i]) });
    });
    if (!proposals.length) throw new Error(tr('Kein Modell hat geantwortet.', 'No model answered.'));
    // round 2: the chair forms the consensus and implements it
    const chairUp = proposals.find((p) => p.m === chair)?.m ?? proposals[0].m;
    usedLabel = tr(`${label(chairUp)} · Konsens aus ${proposals.length}`, `${label(chairUp)} · consensus of ${proposals.length}`);
    const consensus = `${base}\n\n` + tr(`Die Nachricht wurde von ${members.length} Modellen unabhängig beantwortet:\n\n`, `The message was answered independently by ${members.length} models:\n\n`) +
      proposals.map((p, i) => `### ${tr('Vorschlag', 'Proposal')} ${i + 1} (${label(p.m)})\n${p.text}`).join('\n\n') +
      tr(`\n\nDu bist der Vorsitz. Stimme die Vorschläge ab: Wo sie übereinstimmen, setze die Änderungen mit dg um. Wo sie sich widersprechen, entscheide nach Belegen bzw. Mehrheit und nenne den Dissens offen. Antworte mit: Konsens, Dissens (falls vorhanden), umgesetzte Änderungen.`, `\n\nYou are the chair. Reconcile the proposals: where they agree, implement the changes with dg. Where they contradict, decide by evidence or majority and state the dissent openly. Answer with: consensus, dissent (if any), implemented changes.`);
    step('')(tr(`Abstimmung: ${label(chairUp)} bildet den Konsens …`, `Vote: ${label(chairUp)} forms the consensus …`));
    return spawnRuntime(chairUp.runtime, chairUp.model, dir, consensus, { ...env(false), DG_RUN: `${info.id}-k` }, step(tr('[Vorsitz] ', '[Chair] ')));
  })();

  const done = job
    .then((reply) => {
      info.status = 'fertig'; info.reply = reply || tr('(keine Antwort)', '(no answer)');
      const ok = extractOk(info.reply);
      if (ok) mutate((st) => { const n = nodeById(st, a.nodeId); if (n) n.okNext = { text: ok, at: now(), by: a.nodeId }; });
    })
    .catch((e: Error) => { info.status = 'fehlgeschlagen'; info.error = e.message; })
    .finally(() => {
      info.endedAt = now();
      addMessage({
        threadId: info.threadId, from: a.nodeId, to: a.from, text: info.reply ?? tr(`Fehler: ${info.error}`, `Error: ${info.error}`), edgeId: a.edgeId, runId: info.id,
        kind: info.status === 'fertig' ? 'antwort' : 'fehler', via: 'bot', runtime: usedLabel, steps: info.steps.map((x) => x.text),
        about: a.about ?? null, section,
      });
      if (resumable && info.status === 'fertig') mutate((st) => {
        const pr = nodeById(st, a.nodeId)?.agentProfile;
        if (!pr) return;
        if (rollover) { pr.session = null; pr.section = section + 1; touch(st, a.nodeId, 'bot', tr(`Gesprächsabschnitt ${section} abgeschlossen (Zusammenfassung in CLAUDE.md).`, `Conversation section ${section} completed (summary in CLAUDE.md).`)); }
        else if (newSession) pr.session = { id: newSession, startedAt: session?.startedAt ?? now(), runs: (session?.id === newSession ? session.runs : 0) + 1 };
      });
      mutate((st) => touch(st, a.nodeId, 'bot', tr(`Lauf ${info.id} (${info.model ? info.model : info.runtime}): ${info.status}.`, `Run ${info.id} (${info.model ? info.model : info.runtime}): ${statusLabel(info.status)}.`), info.id));
    });
  if (wait) await done;
  return info;
}

// ───────── OK cascades, blocker query, autorun (triggered by the owner; at most 3 runs at once) ─────────
const queue: (() => Promise<unknown>)[] = [];
let active = 0;
function pump() {
  while (active < 3 && queue.length) {
    const job = queue.shift()!;
    active++;
    job().catch(() => {}).finally(() => { active--; pump(); });
  }
}
export const queued = () => queue.length + active;
const waiting = new Set<string>();
export const waitingIds = () => [...waiting];
const busy = (x: string) => waiting.has(x) || [...runs.values()].some((r) => r.nodeId === x && r.status === 'läuft');
/** Bots of an area: self = only this one, next = the next bot level below, zone = all bots below (including itself). */
export function botsIn(s: GraphState, id: string, scope: 'self' | 'next' | 'zone'): string[] {
  const r = rootOf(s);
  const runnable = (x: string) => x !== r && !!nodeById(s, x)?.isBot;
  if (scope === 'self') return runnable(id) ? [id] : [];
  const below = descendants(s, id).filter((x) => nodeById(s, x)?.isBot);
  if (scope === 'next') return below.filter((x) => !ancestors(s, x).some((a) => a !== id && below.includes(a))).filter(runnable);
  return [id, ...below].filter(runnable);
}
export function okCascade(nodeId: string, scope: 'self' | 'next' | 'zone') {
  const s = normalize(readState() ?? starterState());
  const all = botsIn(s, nodeId, scope);
  const go = all.filter((x) => nodeById(s, x)?.okNext && !busy(x));
  for (const x of go) enqueue(s, x, 'OK', 'text');
  pump();
  return { started: go, skipped: all.filter((x) => !go.includes(x)) };
}
export function blockerSweep(nodeId: string) {
  const s = normalize(readState() ?? starterState());
  const all = botsIn(s, nodeId, 'zone').filter((x) => !busy(x));
  const q = tr(`Blocker-Abfrage von ${OWNER()}: Wirst du gerade durch etwas blockiert, das nur ${OWNER()} lösen kann (Entscheidung, Zugang, Login, Daten, Zahlung, E-Mail …)? Dann \`dg block "<was ${OWNER()} konkret tun muss, max. 15 Wörter>"\`. Ist ein alter Blocker erledigt: \`dg unblock\`. Prüfe auch die Blocker deiner Unter-Bots (\`dg oks\`). Nichts anderes ändern. Antworte in einem Satz.`, `Blocker query from ${OWNER()}: Are you currently blocked by something only ${OWNER()} can resolve (decision, access, login, data, payment, e-mail …)? Then \`dg block "<what ${OWNER()} concretely needs to do, max. 15 words>"\`. If an old blocker is resolved: \`dg unblock\`. Also check the blockers of your sub-bots (\`dg oks\`). Change nothing else. Answer in one sentence.`);
  for (const x of all) enqueue(s, x, q, 'vorlage');
  pump();
  return { started: all };
}
/** Chat bots (ChatGPT/Claude Desktop via inbox) do not occupy a queue slot – their question waits in the inbox. */
function enqueue(s: GraphState, x: string, text: string, via: BotMessage['via']) {
  const run = () => { waiting.delete(x); return startRun({ nodeId: x, text, from: OWNER_ID, edgeId: null, depth: 0, via }, true); };
  if (membersFor(s, x)[0].runtime === 'chat') { startRun({ nodeId: x, text, from: OWNER_ID, edgeId: null, depth: 0, via }, false).catch(() => {}); return; }
  waiting.add(x);
  queue.push(run);
}
/** Bots without an "On OK" set it with a short run (change nothing else). */
export function fillOk(nodeId: string) {
  const s = normalize(readState() ?? starterState());
  const all = botsIn(s, nodeId, 'zone').filter((x) => !nodeById(s, x)?.okNext && !busy(x));
  const q = tr(`Kurzer Auftrag von ${OWNER()}: Lege dein „Bei OK“ fest. Prüfe dafür knapp deinen Stand (\`dg show\`, offene Punkte, Kurzlage) und wähle das nächste größere Arbeitspaket deines Bereichs oder die nächste Handlung, die wirklich eine Freigabe braucht (kein reiner Lese- oder Prüfschritt – solche erledigst du ohne OK). Ändere sonst nichts. Antworte in 1–2 Sätzen und ende mit der Zeile „Bei OK werde ich: <max. 8 Wörter>“.`, `Short task from ${OWNER()}: set your "On OK". To do so, briefly check your status (\`dg show\`, open points, short status) and choose the next larger work package of your area or the next action that really needs approval (not a pure reading or checking step – you do those without OK). Change nothing else. Answer in 1–2 sentences and end with the line "On OK I will: <max. 8 words>".`);
  for (const x of all) enqueue(s, x, q, 'vorlage');
  pump();
  return { started: all };
}
/** Text overview for chats/connector: blockers, On-OK list, autorun. */
export function cockpitText(): string {
  const s = normalize(readState() ?? starterState());
  const r = rootOf(s);
  const path = (id: string) => [...ancestors(s, id).filter((x) => x !== r), id].map((x) => nodeById(s, x)?.title).join(' › ');
  const bl = s.nodes.filter((n) => n.blocker).map((n) => `- ${path(n.id)} (\`${n.id}\`, ${tr('seit', 'since')} ${n.blocker!.at.slice(0, 16).replace('T', ' ')}): ${n.blocker!.text}`);
  const ok = s.nodes.filter((n) => n.isBot && n.id !== r).map((n) => `- ${n.title} (\`${n.id}\`${membersFor(s, n.id)[0].runtime === 'chat' ? ', Chat' : ''}${busy(n.id) ? tr(', arbeitet', ', working') : ''}): ${n.okNext ? tr(`Bei OK → ${n.okNext.text}`, `On OK → ${n.okNext.text}`) : tr('(kein „Bei OK“)', '(no "On OK")')}`);
  const a = autoStatus();
  return tr(`# Cockpit\n\n## Wo ${OWNER()} gebraucht wird (${bl.length})\n${bl.join('\n') || '- nichts blockiert'}\n\n## Bei OK\n${ok.join('\n')}\n\n## Autorun\n${a.on ? `läuft seit ${a.since?.slice(11, 16)}, ${a.oks} OKs gegeben${a.idleHours ? `, stoppt nach ${a.idleHours} h ohne Aktivität` : ', unbegrenzt'}` : `aus${a.stopReason ? ` (zuletzt: ${a.stopReason})` : ''}`} · Warteschlange ${queued()}`, `# Cockpit\n\n## Where ${OWNER()} is needed (${bl.length})\n${bl.join('\n') || '- nothing blocked'}\n\n## On OK\n${ok.join('\n')}\n\n## Autorun\n${a.on ? `running since ${a.since?.slice(11, 16)}, ${a.oks} OKs given${a.idleHours ? `, stops after ${a.idleHours} h without activity` : ', unlimited'}` : `off${a.stopReason ? ` (last: ${a.stopReason})` : ''}`} · queue ${queued()}`);
}
/** Autorun: gives OKs automatically while switched on. Stops after idleHours without the owner's activity (0 = never). */
type Auto = { on: boolean; nodeId: string; since: string | null; oks: number; idleHours: number; lastActive: number; timer: ReturnType<typeof setInterval> | null; stopReason: string | null };
const G = globalThis as unknown as { __mindAuto?: Auto };
const auto: Auto = (G.__mindAuto ??= { on: false, nodeId: '', since: null, oks: 0, idleHours: 3, lastActive: Date.now(), timer: null, stopReason: null });
export const autoStatus = () => ({ waiting: waitingIds(), on: auto.on, nodeId: auto.nodeId, since: auto.since, oks: auto.oks, idleHours: auto.idleHours, stopReason: auto.stopReason, queued: queued() });
export function autoActive() { auto.lastActive = Date.now(); }
export function setAuto(on: boolean, nodeId?: string, idleHours?: number) {
  if (idleHours !== undefined && idleHours >= 0) auto.idleHours = idleHours;
  if (auto.timer) { clearInterval(auto.timer); auto.timer = null; }
  auto.on = on;
  if (!on) return autoStatus();
  auto.nodeId = nodeId || auto.nodeId; auto.since = now(); auto.oks = 0; auto.stopReason = null; auto.lastActive = Date.now();
  const tick = () => {
    if (!auto.on) return;
    if (auto.idleHours > 0 && Date.now() - auto.lastActive > auto.idleHours * 3_600_000) { auto.on = false; auto.stopReason = tr(`nach ${auto.idleHours} h ohne Aktivität gestoppt`, `stopped after ${auto.idleHours} h without activity`); if (auto.timer) clearInterval(auto.timer); auto.timer = null; return; }
    if (queued() > 0) return;
    fillOk(auto.nodeId);
    const r = okCascade(auto.nodeId, 'zone');
    auto.oks += r.started.length;
  };
  auto.timer = setInterval(tick, 15_000);
  tick();
  return autoStatus();
}

/** Deterministic test bot without AI: tests dg, node folder and bot-to-bot conversation. */
export function ensureTestBot() {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(join(BIN_DIR, 'testbot.mjs'), `import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
const prompt = process.argv[2] || '';
const msg = (prompt.split(/(?:Nachricht von|Message from) [^:]+:\\n/)[1] || '').split('\\n\\nArbeite mit')[0].trim();
const dg = (...a) => execFileSync('dg', a, { encoding: 'utf8' }).trim();
const out = [];
if (process.env.DG_READONLY === '1') {
  const first = dg('show').split('\\n')[0].replace('# ', '');
  const variant = (process.env.DG_TEST_VARIANT || 'A');
  console.log('Vorschlag ' + variant + ' für ' + first + ': ' + (msg.match(/^offen:\\s*(.+)$/is) ? 'dg add-open "' + msg.replace(/^offen:\\s*/i, '') + '"' : 'notieren: ' + msg.slice(0, 60)));
  process.exit(0);
}
const show = dg('show');
out.push('Knoten gelesen (' + show.split('\\n')[0].replace('# ', '') + ').');
const claude = readFileSync('CLAUDE.md', 'utf8');
if (!claude.includes('## Eigene Notizen')) {
  writeFileSync('CLAUDE.md', claude + '\\n## Eigene Notizen\\n\\n- Test-Bot war hier. Gesprächspartner werden über dg ask erreicht.\\n');
  out.push('CLAUDE.md um eigene Notizen ergänzt.');
}
let m;
if ((m = msg.match(/^frag (\\S+):\\s*(.+)$/is))) {
  const reply = dg('ask', m[1], m[2]);
  out.push('Antwort von ' + m[1] + ': ' + reply);
  dg('note', 'mit ' + m[1] + ' gesprochen');
} else if ((m = msg.match(/^offen:\\s*(.+)$/is))) {
  out.push(dg('add-open', m[1]));
} else if ((m = msg.match(/^unterknoten:\\s*(.+)$/is))) {
  const r = dg('add-child', m[1]);
  out.push(r);
  const id = r.split(' ').pop();
  const dir = dg('folder', id);
  writeFileSync(dir + '/AGENTS.md', '# ' + m[1] + '\\n\\nVom Eltern-Bot angelegt. Rolle: Teilaspekt von ' + process.env.DG_NODE + '.\\n');
  out.push('AGENTS.md für ' + id + ' angelegt.');
} else {
  dg('note', 'Nachricht erhalten: ' + msg.slice(0, 80));
  out.push('Notiert: „' + msg.slice(0, 80) + '“.');
}
console.log(out.join(' '));
`);
}
