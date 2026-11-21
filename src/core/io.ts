import { OWNER_ID, OWNER_ALIASES, setLang, setOwner, tr } from './i18n.ts';
import { SCHEMA, SCHEMA_VERSION, defaultPresets, now, type GraphState, type GraphNode } from './model.ts';
import { buildSeedState, type LegacySeed } from './seed-legacy.ts';
import { starterState } from './seed.ts';
import { touch } from './graph.ts';

export function exportState(s: GraphState): string {
  return JSON.stringify({ ...s, exportedAt: now() }, null, 2);
}

/** Older states named the root after the owner's first name. Rename it to OWNER_ID everywhere (ids, edges, senders). */
export function migrateOwner(s: GraphState): boolean {
  const old = OWNER_ALIASES.find((a) => s.nodes?.some((n) => n.id === a) && !s.edges?.some((e) => e.primary && e.to === a));
  if (!old) return false;
  const walk = (v: unknown): unknown => {
    if (v === old) return OWNER_ID;
    if (typeof v === 'string') return v.startsWith(`${old}>`) ? OWNER_ID + v.slice(old.length) : v.endsWith(`>${old}`) ? v.slice(0, -old.length) + OWNER_ID : v;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = walk((v as Record<string, unknown>)[k]); return v; }
    return v;
  };
  for (const k of Object.keys(s)) if (k !== 'legacyExports') (s as unknown as Record<string, unknown>)[k] = walk((s as unknown as Record<string, unknown>)[k]);
  s.lang ??= 'de'; // old states were German
  return true;
}

/** Fill in missing fields (forward compatibility within schema 2) and set the language/owner. */
export function normalize(s: GraphState): GraphState {
  migrateOwner(s);
  setLang(s.lang);
  setOwner(s.nodes?.find((n) => n.id === OWNER_ID)?.title);
  const seed = starterState();
  s.view = { ...seed.view, ...(s.view ?? {}) };
  for (const k of ['nodes', 'edges', 'sources', 'runs', 'decisions', 'delegations', 'agentTasks', 'log', 'legacyExports', 'branchPrompts', 'botMessages'] as const) {
    if (!Array.isArray(s[k])) (s as unknown as Record<string, unknown[]>)[k] = [];
  }
  s.revision ??= 0;
  if (!Array.isArray(s.promptPresets) || !s.promptPresets.length) s.promptPresets = defaultPresets();
  return s;
}

export interface ImportResult { state: GraphState; message: string }

/**
 * Accepts: (a) versioned export (schema quant-decision-graph, version 2),
 * (b) legacy seed {nodes: {id: [t,type,note]}, links, runs, sources},
 * (c) 2D export / browser state quant-entscheidungsgraph-v1 with only nodes and edges.
 * (b) and (c) are merged into the current state by stable ids.
 */
export function importJson(current: GraphState, text: string, fileName: string): ImportResult {
  const data = JSON.parse(text);
  if (data?.schema === SCHEMA) {
    if (data.version > SCHEMA_VERSION) throw new Error(tr(`Schema-Version ${data.version} ist neuer als diese App (${SCHEMA_VERSION}).`, `Schema version ${data.version} is newer than this app (${SCHEMA_VERSION}).`));
    delete data.exportedAt;
    const st = normalize(data as GraphState);
    st.revision = current.revision;
    return { state: st, message: tr(`Versionierter Stand importiert: ${st.nodes.length} Knoten, ${st.edges.length} Kanten, ${st.sources.length} Quellen, ${st.runs.length} Läufe.`, `Versioned state imported: ${st.nodes.length} nodes, ${st.edges.length} edges, ${st.sources.length} sources, ${st.runs.length} runs.`) };
  }
  const s: GraphState = structuredClone(current);
  s.legacyExports.push({ importedAt: now(), fileName, payload: data });
  let changed = 0, added = 0, edgesAdded = 0;
  const rawNodes = data.nodes ?? data.graph?.nodes;
  const entries: { id: string; title?: string; type?: string; note?: string; x?: number; y?: number; sources?: string[] }[] = [];
  if (Array.isArray(rawNodes)) {
    for (const n of rawNodes) entries.push({
      id: String(n.id), title: n.title ?? n.label ?? n.name, type: n.type ?? n.kind, note: n.note ?? n.summary ?? n.text,
      x: n.x ?? n.pos?.x, y: n.y ?? n.pos?.y, sources: n.sources ?? n.sourceIds ?? (n.source ? [n.source] : undefined),
    });
  } else if (rawNodes && typeof rawNodes === 'object') {
    for (const [id, v] of Object.entries(rawNodes)) {
      if (Array.isArray(v)) entries.push({ id, title: v[0] as string, type: v[1] as string, note: v[2] as string });
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        entries.push({ id, title: o.title as string, type: o.type as string, note: (o.note ?? o.summary) as string, x: o.x as number, y: o.y as number, sources: o.sources as string[] });
      }
    }
  }
  for (const e of entries) {
    let n = s.nodes.find((x) => x.id === e.id);
    if (!n) {
      n = { id: e.id, title: e.title ?? e.id, type: e.type ?? 'Thema', summary: e.note ?? '', openPoints: [], sourceIds: [], lastWorkedAt: now(), createdAt: now() } as GraphNode;
      s.nodes.push(n);
      // Without a parent link, attach under Quant so the node stays reachable.
      if (!(data.links ?? data.edges ?? []).some((l: Record<string, string>) => (l.target ?? l.to) === e.id)) {
        s.edges.push({ id: `quant>${e.id}`, from: 'quant', to: e.id, type: 'UNTERTHEMA', sourceIds: [], primary: true });
      }
      added++;
    } else {
      const before = JSON.stringify([n.title, n.type, n.summary]);
      if (e.title) n.title = e.title;
      if (e.type) n.type = e.type;
      if (e.note != null) n.summary = e.note;
      if (before !== JSON.stringify([n.title, n.type, n.summary])) { n.lastWorkedAt = now(); changed++; }
    }
    if (typeof e.x === 'number' && typeof e.y === 'number') n.pos2d = { x: e.x, y: e.y };
    for (const sid of e.sources ?? []) if (!n.sourceIds.includes(sid)) n.sourceIds.push(sid);
  }
  for (const l of data.links ?? data.edges ?? []) {
    const from = l.origin ?? l.from ?? l.source_id ?? l.sourceNode;
    const to = l.target ?? l.to;
    const type = l.relation ?? l.type ?? 'VERWEIS';
    if (!from || !to) continue;
    const id = `${from}>${to}`;
    const sids: string[] = l.sources ?? (typeof l.source === 'string' ? [l.source] : []);
    const ex = s.edges.find((x) => x.id === id);
    if (ex) { for (const x of sids) if (!ex.sourceIds.includes(x)) ex.sourceIds.push(x); ex.type = type; continue; }
    const hasParent = s.edges.some((x) => x.primary && x.to === to);
    s.edges.push({ id, from, to, type, sourceIds: sids, primary: !hasParent });
    edgesAdded++;
  }
  // Legacy seed: add sources/runs if new
  if (data.sources && !Array.isArray(data.sources)) {
    const seedSt = buildSeedState(data as LegacySeed);
    for (const src of seedSt.sources) if (!s.sources.some((x) => x.id === src.id)) s.sources.push(src);
    for (const r of seedSt.runs) if (!s.runs.some((x) => x.id === r.id)) s.runs.push(r);
  }
  const msg = tr(`2D-/Legacy-Stand zusammengeführt: ${added} Knoten neu, ${changed} geändert, ${edgesAdded} Kanten neu. Originalexport unter legacyExports aufbewahrt.`, `2D/legacy state merged: ${added} nodes new, ${changed} changed, ${edgesAdded} edges new. Original export kept under legacyExports.`);
  touch(s, null, 'import', `${fileName}: ${msg}`);
  return { state: s, message: msg };
}
