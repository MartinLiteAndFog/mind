import { OWNER_ID, tr } from './i18n.ts';
import { type TrashItem, now, type GraphState, type GraphNode, type GraphEdge, type Run } from './model.ts';

export function nodeById(s: GraphState, id: string): GraphNode | undefined {
  return s.nodes.find((n) => n.id === id);
}

export function primaryParent(s: GraphState, id: string): string | null {
  return s.edges.find((e) => e.primary && e.to === id)?.from ?? null;
}

export function children(s: GraphState, id: string): string[] {
  return s.edges.filter((e) => e.primary && e.from === id).map((e) => e.to);
}

export function ancestors(s: GraphState, id: string): string[] {
  const out: string[] = [];
  let cur = primaryParent(s, id);
  const seen = new Set([id]);
  while (cur && !seen.has(cur)) {
    out.unshift(cur);
    seen.add(cur);
    cur = primaryParent(s, cur);
  }
  return out;
}

export function descendants(s: GraphState, id: string): string[] {
  const out: string[] = [];
  const stack = [...children(s, id)];
  const seen = new Set<string>([id]);
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...children(s, c));
  }
  return out;
}

export interface Visible { nodes: Map<string, number>; hiddenChildren: Map<string, number> }

/**
 * Visibility: depth counts from the focus (level 0). Locally expanded nodes show their
 * direct children regardless of depth; collapsed ones hide them.
 */
export function computeVisible(s: GraphState): Visible {
  const { focus, depth } = s.view;
  const expanded = new Set(s.view.expanded);
  const collapsed = new Set(s.view.collapsed);
  const vis = new Map<string, number>();
  const hidden = new Map<string, number>();
  const queue: [string, number][] = [[focus, 0]];
  while (queue.length) {
    const [id, lvl] = queue.shift()!;
    if (vis.has(id)) continue;
    vis.set(id, lvl);
    const kids = children(s, id);
    const open = !collapsed.has(id) && (lvl < depth || expanded.has(id));
    if (open) for (const k of kids) queue.push([k, lvl + 1]);
    else if (kids.length) hidden.set(id, kids.length);
  }
  return { nodes: vis, hiddenChildren: hidden };
}

export function visibleEdges(s: GraphState, vis: Visible): GraphEdge[] {
  return s.edges.filter((e) => vis.nodes.has(e.from) && vis.nodes.has(e.to));
}

/** Marks a content change (do not use for opening/layout). */
export function touch(s: GraphState, nodeId: string | null, kind: string, text: string, ref?: string) {
  const at = now();
  if (nodeId) {
    const n = nodeById(s, nodeId);
    if (n) n.lastWorkedAt = at;
  }
  s.log.push({ at, nodeId, kind, text, ref });
}

export function runsUnder(s: GraphState, id: string): Run[] {
  const ids = new Set([id, ...descendants(s, id)]);
  return s.runs.filter((r) => ids.has(r.nodeId));
}

/** All source ids relevant to a node: node, edges, runs, decisions, agent reports. */
export function relevantSourceIds(s: GraphState, id: string): string[] {
  const out = new Set<string>();
  const n = nodeById(s, id);
  n?.sourceIds.forEach((x) => out.add(x));
  s.edges.filter((e) => e.from === id || e.to === id).forEach((e) => e.sourceIds.forEach((x) => out.add(x)));
  runsUnder(s, id).forEach((r) => r.sourceIds.forEach((x) => out.add(x)));
  s.decisions.filter((d) => d.nodeId === id || d.affectedNodeIds.includes(id)).forEach((d) => d.sourceIds.forEach((x) => out.add(x)));
  s.agentTasks.filter((t) => t.nodeId === id || t.requestedBy === id).forEach((t) => t.sourceIds.forEach((x) => out.add(x)));
  return [...out].filter((x) => s.sources.some((src) => src.id === x));
}

export function slug(t: string): string {
  return t.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'knoten';
}

export function uniqueId(s: GraphState, base: string): string {
  let id = base;
  let i = 2;
  while (s.nodes.some((n) => n.id === id)) id = `${base}-${i++}`;
  return id;
}

export function addChild(s: GraphState, parentId: string, title: string, type = 'Thema'): GraphNode {
  const id = uniqueId(s, slug(title));
  const n: GraphNode = { id, title, type, summary: '', openPoints: [], sourceIds: [], lastWorkedAt: now(), createdAt: now() };
  s.nodes.push(n);
  s.edges.push({ id: `${parentId}>${id}`, from: parentId, to: id, type: 'UNTERTHEMA', sourceIds: [], primary: true });
  touch(s, id, 'knoten', tr(`Zweig „${title}“ unter ${nodeById(s, parentId)?.title ?? parentId} angelegt.`, `Branch “${title}” created under ${nodeById(s, parentId)?.title ?? parentId}.`));
  return n;
}

export function addCrossLink(s: GraphState, from: string, to: string, type: string, sourceIds: string[] = []): GraphEdge {
  const id = `${from}>${to}`;
  const existing = s.edges.find((e) => e.id === id);
  if (existing) return existing;
  const e: GraphEdge = { id, from, to, type, sourceIds, primary: false };
  s.edges.push(e);
  touch(s, from, 'kante', tr(`Querverbindung ${type} → ${to} angelegt.`, `Cross-link ${type} → ${to} created.`));
  return e;
}

/** Deletes only nodes without children and without runs. */
export function deleteLeaf(s: GraphState, id: string): string | null {
  if (children(s, id).length) return tr('Knoten hat Unterknoten.', 'Node has child nodes.');
  if (s.runs.some((r) => r.nodeId === id)) return tr('Knoten trägt Läufe.', 'Node carries runs.');
  if (id === OWNER_ID) return tr('Zentrum kann nicht gelöscht werden.', 'The centre cannot be deleted.');
  const parent = primaryParent(s, id);
  s.nodes = s.nodes.filter((n) => n.id !== id);
  s.edges = s.edges.filter((e) => e.from !== id && e.to !== id);
  delete s.view.pinned[id];
  touch(s, parent, 'knoten', tr(`Knoten ${id} gelöscht.`, `Node ${id} deleted.`));
  return null;
}

export function fmtEur(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return tr('offen', 'open');
  const digits = Math.abs(v) < 1 ? 4 : 2;
  return v.toLocaleString(tr('de-DE', 'en-US'), { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' €';
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return tr('offen', 'open');
  return v.toLocaleString(tr('de-DE', 'en-US'), { maximumFractionDigits: 2 }) + ' %';
}

export function relTime(iso: string | null): string {
  if (!iso) return tr('nie', 'never');
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return tr('gerade eben', 'just now');
  if (d < 3600) return tr(`vor ${Math.round(d / 60)} min`, `${Math.round(d / 60)} min ago`);
  if (d < 86400) return tr(`vor ${Math.round(d / 3600)} h`, `${Math.round(d / 3600)} h ago`);
  return tr(`vor ${Math.round(d / 86400)} T`, `${Math.round(d / 86400)} d ago`);
}

/** Remove a branch (node + all child nodes) and put it in the trash. The root cannot be removed. */
export function removeBranch(s: GraphState, id: string, by: string): TrashItem | null {
  const n = nodeById(s, id);
  if (!n || !s.edges.some((e) => e.primary && e.to === id)) return null;
  const ids = new Set([id, ...descendants(s, id)]);
  const parentId = s.edges.find((e) => e.primary && e.to === id)?.from ?? null;
  const item: TrashItem = { id: `tr-${Date.now().toString(36)}`, at: now(), by, rootId: id, title: n.title, parentId, nodes: s.nodes.filter((x) => ids.has(x.id)), edges: s.edges.filter((e) => ids.has(e.from) || ids.has(e.to)) };
  s.nodes = s.nodes.filter((x) => !ids.has(x.id));
  s.edges = s.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
  (s.trash ??= []).push(item);
  if (s.trash.length > 200) s.trash.splice(0, s.trash.length - 200);
  if (parentId) touch(s, parentId, 'knoten', tr(`Ast „${n.title}“ (${ids.size} Knoten) entfernt – im Papierkorb.`, `Branch “${n.title}” (${ids.size} nodes) removed – in the trash.`));
  return item;
}

/** Bring a branch back from the trash (under its old parent, otherwise under the root). */
export function restoreBranch(s: GraphState, trashId: string): boolean {
  const i = (s.trash ?? []).findIndex((t) => t.id === trashId);
  if (i < 0) return false;
  const t = s.trash![i];
  const rootId = s.nodes.find((n) => !s.edges.some((e) => e.primary && e.to === n.id))?.id ?? OWNER_ID;
  const parent = t.parentId && nodeById(s, t.parentId) ? t.parentId : rootId;
  const have = new Set(s.nodes.map((n) => n.id));
  s.nodes.push(...t.nodes.filter((n) => !have.has(n.id)));
  const all = new Set(s.nodes.map((n) => n.id));
  for (const e of t.edges) {
    const ed = e.to === t.rootId && e.primary ? { ...e, from: parent, id: `${parent}>${t.rootId}` } : e;
    if (all.has(ed.from) && all.has(ed.to) && !s.edges.some((x) => x.id === ed.id)) s.edges.push(ed);
  }
  s.trash!.splice(i, 1);
  touch(s, t.rootId, 'knoten', tr(`Ast „${t.title}“ aus dem Papierkorb wiederhergestellt.`, `Branch “${t.title}” restored from the trash.`));
  return true;
}
