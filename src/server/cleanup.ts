// "Aufräumen" (cleanup): condenses summaries and short status into bullet points, closes finished open points,
// merges duplicates. A cheap model only PROPOSES changes (no tools, no writes); the owner sees a preview and confirms.
// Applying never deletes: the previous summary, removed open points and the old short status go into node.archive.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readState } from './store.ts';
import { normalize } from '../core/io.ts';
import { starterState } from '../core/seed.ts';
import { nodeById, children } from '../core/graph.ts';
import { OWNER_ID, OWNER, tr } from '../core/i18n.ts';
import type { GraphState, GraphNode } from '../core/model.ts';
import { mutate, spawnRuntime, cleanEnv, ensureNodeFolder } from './bots.ts';

const FILE = join(DATA_DIR, 'cleanup', 'preview.json');
const CHUNK = 30_000; // characters of node data per model call
const MODEL = process.env.MIND_CLEANUP_MODEL || 'sonnet';

type Fields = { summary: string; openPoints: string[]; todos: { pos: string[]; neg: string[] } | null };
export type CleanItem = { id: string; title: string; old: Fields; new: Fields; why: string };
export type Preview = { at: string; status: 'läuft' | 'fertig' | 'fehlgeschlagen'; done: number; total: number; items: CleanItem[]; errors: string[]; applied?: string; appliedIds?: string[]; by: string };

const G = globalThis as unknown as { __mindCleanup?: { running: boolean; nightly?: ReturnType<typeof setInterval> } };
G.__mindCleanup ??= { running: false };
const C = G.__mindCleanup;

export function readPreview(): Preview | null { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; } }
function writePreview(p: Preview) { mkdirSync(join(DATA_DIR, 'cleanup'), { recursive: true }); writeFileSync(FILE, JSON.stringify(p, null, 1)); }

const fieldsOf = (n: GraphNode): Fields => ({ summary: n.summary ?? '', openPoints: [...(n.openPoints ?? [])], todos: n.todos ? { pos: [...n.todos.pos], neg: [...n.todos.neg] } : null });
const same = (a: Fields, b: Fields) => JSON.stringify(a) === JSON.stringify(b);

/** Node data for the model, in tree order, cut into chunks. Mirrors of other Minds are skipped (read only). */
function chunks(s: GraphState): { ids: string[]; text: string }[] {
  const order: string[] = [];
  const walk = (id: string) => { order.push(id); children(s, id).forEach(walk); };
  walk(OWNER_ID);
  const out: { ids: string[]; text: string }[] = [];
  let cur = { ids: [] as string[], text: '' };
  for (const id of order) {
    const n = nodeById(s, id)!;
    if (n.remote || id === OWNER_ID && !n.summary && !n.openPoints.length) continue;
    if (!n.summary.trim() && !n.openPoints.length && !n.todos) continue;
    const notes = s.log.filter((l) => l.nodeId === id && !/^(Lauf|Run) /.test(l.text)).slice(-8).map((l) => `${l.at.slice(0, 10)} ${l.text.replace(/\s+/g, ' ').slice(0, 220)}`);
    const decs = s.decisions.filter((d) => d.nodeId === id).slice(-6).map((d) => `${d.date ?? '?'} ${d.kind}: ${d.content.slice(0, 200)}`);
    const block = JSON.stringify({ id, title: n.title, lastWorked: n.lastWorkedAt?.slice(0, 10) ?? null, summary: n.summary, openPoints: n.openPoints, todos: n.todos ? { pos: n.todos.pos, neg: n.todos.neg } : null, recentNotes: notes, decisions: decs });
    if (cur.text.length + block.length > CHUNK && cur.ids.length) { out.push(cur); cur = { ids: [], text: '' }; }
    cur.ids.push(id); cur.text += block + '\n';
  }
  if (cur.ids.length) out.push(cur);
  return out;
}

const prompt = (data: string, today: string) => tr(
  `Du räumst Knoten in ${OWNER()}s Mind-Karte auf. Heute ist ${today}. Unten steht je Zeile ein Knoten als JSON.
Für jeden Knoten, bei dem es sich lohnt:
- "summary": die Zusammenfassung als knappe Stichpunkte ("- …" je Zeile, höchstens 8). Alle Fakten, Zahlen, Namen, Entscheidungen und Belege behalten – nur Wiederholungen, Füllwörter und Veraltetes weglassen. Nichts erfinden.
- "openPoints": die offenen Punkte ohne erledigte (nur wenn recentNotes/decisions/summary klar zeigen, dass sie erledigt sind) und mit zusammengeführten Doppelungen.
- "todos": Kurzlage {"pos":[…], "neg":[…]} (je höchstens 3 bzw. 2, je max. 12 Wörter), Doppeltes zusammengeführt, Erledigtes raus. Fehlt sie, lass "todos" weg.
- "why": ein kurzer Satz, was du geändert hast.
Knoten, an denen nichts zu tun ist, lässt du weg. Ändere keine Bedeutung. Schreibe korrektes Deutsch mit Umlauten (ä, ö, ü, ß), nie ae/oe/ue. Altes wird nicht gelöscht, sondern automatisch archiviert.
Antworte NUR mit JSON: {"nodes":[{"id":"…","summary":"…","openPoints":["…"],"todos":{"pos":[],"neg":[]},"why":"…"}]}

${data}`,
  `You are tidying nodes in ${OWNER()}'s Mind map. Today is ${today}. Below, each line is one node as JSON.
For every node where it is worthwhile:
- "summary": the summary as concise bullet points ("- …" per line, at most 8). Keep all facts, numbers, names, decisions and evidence – only drop repetition, filler and outdated parts. Invent nothing.
- "openPoints": the open points without finished ones (only if recentNotes/decisions/summary clearly show they are done) and with duplicates merged.
- "todos": short status {"pos":[…], "neg":[…]} (at most 3 and 2, max. 12 words each), duplicates merged, finished items removed. If it is missing, omit "todos".
- "why": one short sentence on what you changed.
Leave out nodes that need nothing. Do not change meaning. Old content is not deleted but archived automatically.
Answer ONLY with JSON: {"nodes":[{"id":"…","summary":"…","openPoints":["…"],"todos":{"pos":[],"neg":[]},"why":"…"}]}

${data}`);

function parse(text: string): { id: string; summary?: string; openPoints?: string[]; todos?: { pos: string[]; neg: string[] }; why?: string }[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in answer');
  const j = JSON.parse(m[0]);
  return Array.isArray(j.nodes) ? j.nodes : [];
}

/** Start a preview run (async). Returns immediately; the UI polls readPreview(). */
export function startPreview(by: string = OWNER_ID): Preview {
  if (C.running) return readPreview()!;
  const s = normalize(readState() ?? starterState());
  const parts = chunks(s);
  const p: Preview = { at: new Date().toISOString(), status: 'läuft', done: 0, total: parts.length, items: [], errors: [], by };
  writePreview(p); C.running = true;
  const dir = ensureNodeFolder(s, OWNER_ID);
  const today = new Date().toISOString().slice(0, 10);
  (async () => {
    // two at a time: fast enough, gentle on the subscription
    const queue = [...parts];
    const worker = async () => {
      for (let part = queue.shift(); part; part = queue.shift()) {
        try {
          const out = await spawnRuntime('claude', MODEL, dir, prompt(part.text, today), { ...cleanEnv(), DG_READONLY: '1', DG_EFFORT: 'low', DG_NODE: OWNER_ID, DG_RUNID: `cleanup-${Date.now()}` });
          const st = normalize(readState() ?? starterState());
          for (const r of parse(out)) {
            const n = nodeById(st, r.id);
            if (!n || !part.ids.includes(r.id)) continue;
            const old = fieldsOf(n);
            const nw: Fields = {
              summary: typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : old.summary,
              openPoints: Array.isArray(r.openPoints) ? r.openPoints.map(String).filter((x) => x.trim()) : old.openPoints,
              todos: r.todos && Array.isArray(r.todos.pos) && Array.isArray(r.todos.neg) && old.todos ? { pos: r.todos.pos.map(String).slice(0, 5), neg: r.todos.neg.map(String).slice(0, 5) } : old.todos,
            };
            if (!same(old, nw)) p.items.push({ id: r.id, title: n.title, old, new: nw, why: String(r.why ?? '').slice(0, 300) });
          }
        } catch (e) { p.errors.push(String((e as Error).message ?? e).slice(0, 300)); }
        p.done++; writePreview(p);
      }
    };
    await Promise.all([worker(), worker()]);
    p.status = p.errors.length && !p.items.length ? 'fehlgeschlagen' : 'fertig';
    writePreview(p);
  })().finally(() => { C.running = false; });
  return p;
}

/** Apply the confirmed items. Skips nodes that changed since the preview. Old content goes to node.archive. */
export function applyPreview(ids: string[], by: string = OWNER_ID): { applied: number; skipped: string[] } {
  const p = readPreview();
  if (!p || p.status !== 'fertig' || p.applied) return { applied: 0, skipped: [] };
  const done = new Set(p.appliedIds ?? []);
  const want = new Set(ids.filter((x) => !done.has(x)));
  const skipped: string[] = [];
  let applied = 0;
  mutate((s) => {
    for (const it of p.items) {
      if (!want.has(it.id)) continue;
      const n = nodeById(s, it.id);
      if (!n || !same(fieldsOf(n), it.old)) { skipped.push(it.title); continue; }
      const removed = it.old.openPoints.filter((x) => !it.new.openPoints.includes(x));
      (n.archive ??= []).push({ at: new Date().toISOString(), by, ...(it.old.summary !== it.new.summary ? { summary: it.old.summary } : {}), ...(removed.length ? { openPoints: removed } : {}), ...(it.old.todos && JSON.stringify(it.old.todos) !== JSON.stringify(it.new.todos) ? { todos: it.old.todos } : {}) });
      n.summary = it.new.summary; n.openPoints = it.new.openPoints;
      if (it.new.todos && n.todos) n.todos = { ...n.todos, pos: it.new.todos.pos, neg: it.new.todos.neg, at: new Date().toISOString(), by };
      s.log.push({ at: new Date().toISOString(), nodeId: it.id, kind: 'bot', text: tr(`Aufgeräumt: ${it.why || 'verdichtet'} (Altes im Archiv).`, `Tidied: ${it.why || 'condensed'} (old content in the archive).`) });
      applied++; done.add(it.id);
    }
  });
  const all = p.items.every((x) => done.has(x.id));
  writePreview({ ...p, appliedIds: [...done], ...(all ? { applied: new Date().toISOString() } : {}) });
  return { applied, skipped };
}

/** Optional nightly preview (03:00 local time); it is applied only after confirmation. */
export function startNightly() {
  if (C.nightly) clearInterval(C.nightly);
  C.nightly = setInterval(() => {
    const s = normalize(readState() ?? starterState());
    if (!s.cleanupNightly || C.running || new Date().getHours() !== 3) return;
    const p = readPreview();
    if (p && p.at.slice(0, 10) === new Date().toISOString().slice(0, 10)) return;
    startPreview('nacht');
  }, 10 * 60_000);
}
export const cleanupRunning = () => C.running;
export const previewExists = () => existsSync(FILE);
