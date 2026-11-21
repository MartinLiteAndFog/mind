import { OWNER_ID, OWNER_ALIASES, OWNER, tr, getLang, setLang, setOwner } from '../core/i18n.ts';
import { Store } from '../ui/store.ts';
import { defaultUpdatePrompt, planeName, type GraphState, type GraphNode, type BranchPrompt, type BotMessage } from '../core/model.ts';
import { nodeById, children, addChild, touch, ancestors, descendants, removeBranch, restoreBranch } from '../core/graph.ts';
import { taskMarkdown } from '../core/agents.ts';
import { responsibleBot, standingPrompts, addStanding, removePrompt } from '../core/branches.ts';

const COL = 210;
const ROW = 44;
const PALETTE = ['#e4572e', '#2e86ab', '#f2a541', '#8e44ad', '#17a398', '#e83f6f', '#4a7c59', '#c08497'];
const NS = 'http://www.w3.org/2000/svg';

const store = new Store();
const pop = () => document.getElementById('pop')!;
const S = () => store.state;
const $ = (id: string) => document.getElementById(id)!;
const svg = $('map') as unknown as SVGSVGElement;
const vp = $('vp') as unknown as SVGGElement;

const view = { x: 60, y: 0, k: 1 };
const collapsed = new Set<string>();
let pos = new Map<string, { x: number; y: number; depth: number; ang?: number; a0?: number; r?: number }>();
const LAYOUT_KEY = 'mind-layout';
let focusId: string | null = null;
const LINES_KEY = 'mind-lines';
let lineStyle: 'curve' | 'straight' | 'step' = (() => { try { return (localStorage.getItem(LINES_KEY) as 'curve' | 'straight' | 'step') || 'step'; } catch { return 'step'; } })();
let arcRing = 0, arcDepth = 0;
const arcNow = () => (mode === 'arc' || mode === 'circle') && !focusId;
type Mode = 'circle' | 'arc' | 'ltr';
let mode: Mode = (() => { try { const m = localStorage.getItem(LAYOUT_KEY) as Mode; return m === 'arc' || m === 'ltr' || m === 'circle' ? m : 'circle'; } catch { return 'circle'; } })();
const ROT_KEY = 'mind-rot';
let rot = (() => { try { return Number(localStorage.getItem(ROT_KEY)) || 0; } catch { return 0; } })();
const PLANE_KEY = 'mind-plane';
let plane = (() => { try { return Number(localStorage.getItem(PLANE_KEY)) || 0; } catch { return 0; } })();
const planeView = () => (mode === 'circle' || mode === 'arc') && !focusId;
/** Plane of a node = plane of its main branch (direct child of the owner). */
function planeOf(s: GraphState, id: string): number {
  const r = root(s);
  if (id === r) return -1;
  let top = id;
  for (let e = s.edges.find((x) => x.primary && x.to === top); e && e.from !== r; e = s.edges.find((x) => x.primary && x.to === top)) top = e.from;
  return nodeById(s, top)?.plane ?? 0;
}
/** used planes + one empty one to fill */
function planeTotal(s: GraphState) { return Math.max(0, ...children(s, root(s)).map((c) => nodeById(s, c)?.plane ?? 0)) + 2; }
let sel: { kind: 'node' | 'edge'; id: string } | null = null;
let menuOpen = false;
let childInput = false;
interface RunLite { id: string; nodeId: string; from: string; threadId: string; status: string; runtime: string; model: string; steps?: { at: string; text: string }[] }
let liveRuns: RunLite[] = [];
const voiceThreads = new Set<string>();
const spokenMsgs = new Set<string>();
const RUNTIMES = ['standard', 'claude', 'codex', 'test', 'chat'];

/** Display label for a task/run status (persisted values stay German). */
/** Locale for dates/numbers. */
const LOC = () => (getLang() === 'de' ? 'de-DE' : 'en-US');
const ST = (s: string) => (({ wartend: tr('wartend', 'waiting'), 'läuft': tr('läuft', 'running'), fertig: tr('fertig', 'done'), fehlgeschlagen: tr('fehlgeschlagen', 'failed') } as Record<string, string>)[s] ?? s);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}
function note(msg: string) {
  const n = $('note');
  n.textContent = msg;
  n.hidden = false;
  clearTimeout((n as unknown as { t: number }).t);
  (n as unknown as { t: number }).t = window.setTimeout(() => (n.hidden = true), 4000);
}

// ───────── Layout: tree left → right ─────────

function root(s: GraphState) {
  return s.nodes.find((n) => !s.edges.some((e) => e.primary && e.to === n.id))?.id ?? OWNER_ID;
}

function layout(s: GraphState) {
  if (focusId && nodeById(s, focusId)) return layoutFocus(s, focusId);
  if (mode === 'arc' || mode === 'circle') return layoutArc(s, mode === 'circle');
  layoutLtr(s);
}

/** Focus: path owner → node as a horizontal line, all other subtrees relative to their path anchor. */
function layoutFocus(s: GraphState, id: string) {
  const path = [...ancestors(s, id), id];
  path.forEach((x) => collapsed.delete(x));
  layoutLtr(s);
  const onPath = new Set(path);
  const shift = new Map<string, number>();
  for (const [nid] of pos) {
    let anchor: string | null = nid;
    if (!onPath.has(nid)) { anchor = null; for (const a of [...ancestors(s, nid)].reverse()) if (onPath.has(a)) { anchor = a; break; } }
    shift.set(nid, anchor ? -(pos.get(anchor)?.y ?? 0) : 0);
  }
  for (const [nid, p] of pos) p.y += shift.get(nid) ?? 0;
}

/** Rotates the circle around the centre (circle view only); computes x/y from base angle + rot. */
function applyRotation(full = mode === 'circle') {
  for (const p of pos.values()) {
    if (p.a0 === undefined || p.r === undefined) continue;
    p.ang = p.a0 + (full ? rot : 0);
    p.x = p.r * Math.cos(p.ang); p.y = p.r * Math.sin(p.ang);
  }
}

function setRotation(r: number) {
  rot = ((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  try { localStorage.setItem(ROT_KEY, String(rot)); } catch { /* */ }
  if (mode === 'circle' && !focusId) { applyRotation(true); render(); }
  updateDial();
}

function layoutLtr(s: GraphState) {
  pos = new Map();
  let leaf = 0;
  const visit = (id: string, depth: number): number => {
    const kids = collapsed.has(id) ? [] : children(s, id);
    let y: number;
    if (!kids.length) { y = leaf * ROW; leaf++; }
    else {
      const ys = kids.map((k) => visit(k, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(id, { x: depth * COL, y, depth });
    return y;
  };
  visit(root(s), 0);
}

/**
 * Semicircle upwards: root bottom centre, each level a further arc. Each leaf gets enough angle
 * to keep ~SPACE px of spacing on its own arc (flat leaves need more angle).
 */
function layoutArc(s: GraphState, full = false) {
  pos = new Map();
  // Clear semicircle (180° … 360°). Each node gets a sector; children split it by their number of
  // leaves, with a minimum share for small branches.
  const A0 = full ? 0 : Math.PI, A1 = 2 * Math.PI;
  const rid = root(s);
  const kidsOf = (id: string) => (collapsed.has(id) ? [] : id === rid ? children(s, id).filter((c) => (nodeById(s, c)?.plane ?? 0) === plane) : children(s, id));
  const leafCount = new Map<string, number>();
  let maxDepth = 1;
  const count = (id: string, d: number): number => {
    maxDepth = Math.max(maxDepth, d);
    const k = kidsOf(id);
    const n = k.length ? k.reduce((a, c) => a + count(c, d + 1), 0) : 1;
    leafCount.set(id, n);
    return n;
  };
  count(root(s), 0);
  const leaves = leafCount.get(root(s)) ?? 1;
  // more spacing between the levels (zones)
  const ring = Math.min(300, Math.max(200, (leaves * 34) / Math.PI / Math.max(2, maxDepth - 1)));
  const stagger = new Map<string, number>(); // leaf nodes alternate inside/outside within their zone
  const place = (id: string, d: number, a: number, b: number) => {
    const ang = d === 0 ? 1.5 * Math.PI : (a + b) / 2;
    const r = d * ring;
    pos.set(id, { x: r * Math.cos(ang), y: r * Math.sin(ang), depth: d, ang });
    const k = kidsOf(id);
    if (!k.length) return;
    const minW = Math.max(1, 0.06 * leaves); // small branches: minimum share of the arc
    const w = k.map((c) => Math.max(leafCount.get(c) ?? 1, minW * (d === 0 ? 1.8 : 0.8)));
    const tot = w.reduce((x, y) => x + y, 0);
    let cur = a;
    let li = 0;
    k.forEach((c, i) => {
      const span = ((b - a) * w[i]) / tot;
      if (!kidsOf(c).length) stagger.set(c, (li++ % 2) * 0.3);
      place(c, d + 1, cur, cur + span); cur += span;
    });
  };
  place(root(s), 0, A0, A1);
  // Semicircle: stretch outermost nodes onto the baseline; circle: full circumference, rotatable
  const angs = [...pos.values()].filter((p) => p.depth > 0).map((p) => p.ang!);
  if (!angs.length) angs.push(0);
  const lo = Math.min(...angs), hi = Math.max(...angs);
  for (const [id, p] of pos) {
    if (p.depth === 0) { p.r = 0; p.a0 = p.ang; continue; }
    if (!full && hi > lo) p.ang = A0 + ((p.ang! - lo) / (hi - lo)) * (A1 - A0);
    p.a0 = p.ang;
    p.r = (p.depth + (stagger.get(id) ?? 0)) * ring;
  }
  applyRotation(full);
  arcRing = ring; arcDepth = maxDepth;
}

/** Colour per branch: main branch (level 1), fanned out by level 2 under a single main branch. */
function branchColor(s: GraphState, id: string): string {
  const r = root(s);
  const path: string[] = [];
  let cur: string | undefined = id;
  while (cur && cur !== r) {
    path.unshift(cur);
    cur = s.edges.find((e) => e.primary && e.to === cur)?.from;
  }
  const top = children(s, r);
  const l1 = path[0];
  const l2 = path[1];
  const key = l2 ? `${l1}/${l2}` : l1;
  const keys = top.flatMap((t) => [t, ...children(s, t).map((c) => `${t}/${c}`)]);
  return PALETTE[Math.max(0, keys.indexOf(key)) % PALETTE.length];
}

function curve(a: { x: number; y: number; ang?: number }, b: { x: number; y: number; ang?: number }) {
  if (lineStyle === 'straight') return `M${a.x},${a.y} L${b.x},${b.y}`;
  if (arcNow() && b.ang !== undefined) {
    const ra = Math.hypot(a.x, a.y), rb = Math.hypot(b.x, b.y), rm = (ra + rb) / 2;
    const aa = ra < 1 ? b.ang : (a.ang ?? b.ang);
    if (lineStyle === 'step') {
      // radially outwards, along the ring, radially to the node
      const p1 = { x: rm * Math.cos(aa), y: rm * Math.sin(aa) }, p2 = { x: rm * Math.cos(b.ang), y: rm * Math.sin(b.ang) };
      let dd = b.ang - aa; while (dd > Math.PI) dd -= 2 * Math.PI; while (dd < -Math.PI) dd += 2 * Math.PI;
      const sweep = dd > 0 ? 1 : 0;
      return ra < 1 ? `M${a.x},${a.y} L${p2.x},${p2.y} L${b.x},${b.y}` : `M${a.x},${a.y} L${p1.x},${p1.y} A${rm},${rm} 0 0 ${sweep} ${p2.x},${p2.y} L${b.x},${b.y}`;
    }
    return `M${a.x},${a.y} C${rm * Math.cos(aa)},${rm * Math.sin(aa)} ${rm * Math.cos(b.ang)},${rm * Math.sin(b.ang)} ${b.x},${b.y}`;
  }
  if (lineStyle === 'step') { const mx = (a.x + b.x) / 2; return `M${a.x},${a.y} H${mx} V${b.y} H${b.x}`; }
  const mx = (a.x + b.x) / 2;
  return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
}

// ───────── Drawing ─────────

function draw() {
  layout(S());
  render();
  updatePlaneBtn();
}

function render() {
  const s = S();
  const pathSet = focusId ? new Set([...ancestors(s, focusId), focusId]) : null;
  const eg = $('edges');
  const ng = $('nodes');
  eg.replaceChildren();
  ng.replaceChildren();
  if (arcNow() && arcRing) {
    // faint guides: baseline and semicircle rings per level
    // zones: one softly tinted half-ring band per level, alternating light/lighter; plus the baseline
    for (let d = 1; d <= arcDepth; d++) {
      const r1 = (d - 0.35) * arcRing, r2 = (d + 0.5) * arcRing;
      if (mode === 'circle') {
        el('path', { class: `zone ${d % 2 ? 'odd' : 'even'}`, 'fill-rule': 'evenodd', d: `M${-r2},0 a${r2},${r2} 0 1 0 ${2 * r2},0 a${r2},${r2} 0 1 0 ${-2 * r2},0 M${-r1},0 a${r1},${r1} 0 1 0 ${2 * r1},0 a${r1},${r1} 0 1 0 ${-2 * r1},0` }, eg);
      } else el('path', { class: `zone ${d % 2 ? 'odd' : 'even'}`, d: `M${-r2},0 A${r2},${r2} 0 0 1 ${r2},0 L${r1},0 A${r1},${r1} 0 0 0 ${-r1},0 Z` }, eg);
    }
    if (mode !== 'circle') { const R = arcRing * (arcDepth + 0.5); el('path', { class: 'guide', d: `M${-R},0 L${R},0` }, eg); }
  }
  const r = root(s);
  if (planeView()) {
    // other planes stand perpendicular to this one: seen from the side as a line through the owner
    const other = [...new Set(children(s, r).map((c) => nodeById(s, c)?.plane ?? 0))].filter((k) => k !== plane).sort((a, b) => a - b);
    if (other.length) {
      const R = Math.max(arcRing * (arcDepth + 0.5), 260);
      el('path', { class: 'planeaxis', d: mode === 'circle' ? `M0,${-R} L0,${R}` : `M0,0 L0,${-R}` }, eg);
      const lb = el('text', { class: 'planelabel', x: 8, y: -R + 14, 'data-plane': other[0] }, eg) as SVGTextElement;
      lb.textContent = other.map((k) => `${planeName(s, k)} · ${children(s, r).filter((c) => (nodeById(s, c)?.plane ?? 0) === k).length} ${tr('Äste', 'branches')}`).join('  ·  ');
    }
  }

  for (const e of s.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    if (!e.primary) {
      el('path', { class: `xlink${pathSet ? ' dim' : ''}`, d: curve(a, b) }, eg);
      continue;
    }
    const g = el('g', { class: `edge${sel?.kind === 'edge' && sel.id === e.id ? ' on' : ''}${pathSet ? (pathSet.has(e.from) && pathSet.has(e.to) ? ' path' : ' dim') : ''}`, 'data-edge': e.id }, eg);
    let d: string;
    if (arcNow()) {
      // offset start/end by the node radius along the connection
      const off = (p: { x: number; y: number }, q: { x: number; y: number }, k: number) => { const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1; return { x: p.x + (dx / l) * k, y: p.y + (dy / l) * k }; };
      const sa = off(a, b, e.from === r ? Math.max(30, arcRing * 0.55) : 9 + (nodeById(s, e.from)?.isBot ? 8 : 2));
      const eb = off(b, a, nodeById(s, e.to)?.isBot ? 16 : 10);
      d = e.from === r ? `M${sa.x},${sa.y} L${eb.x},${eb.y}` : lineStyle === 'step' ? curve(a, b) : curve({ ...sa, ang: a.ang }, { ...eb, ang: b.ang });
    } else d = curve({ x: a.x + (e.from === r ? 14 : 9) + (nodeById(s, e.from)?.isBot ? 21 : 15), y: a.y }, { x: b.x - (nodeById(s, e.to)?.isBot ? 16 : 10), y: b.y });
    el('path', { class: 'line', d, stroke: branchColor(s, e.to), 'stroke-width': Math.max(2, 6 - b.depth) }, g);
    el('path', { class: 'hit', d }, g);
    // marker when the branch carries instructions
    const n = s.branchPrompts.filter((p) => p.edgeId === e.id).length;
    if (n) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      el('circle', { class: 'mark', cx: mx, cy: my, r: standingPrompts(s, e.id).length ? 5 : 3.5, fill: branchColor(s, e.to) }, g);
    }
  }

  for (const [id, p] of pos) {
    const node = nodeById(s, id)!;
    const isRoot = id === r;
    // Owner in the centre (circle/semicircle view): button as large as the free inner circle where the rays begin
    const bigRoot = isRoot && arcNow() && !!arcRing;
    const rad = bigRoot ? rootRad() : isRoot ? 14 : 9;
    const g = el('g', { class: `node${bigRoot ? ' big' : ''}${sel?.kind === 'node' && sel.id === id ? ' on' : ''}${pathSet && !pathSet.has(id) ? ' dim' : ''}${pathSet && id === focusId ? ' focus' : ''}`, 'data-node': id, transform: `translate(${p.x},${p.y})` }, ng);
    if (node.isBot && !bigRoot) el('circle', { class: 'ring', r: rad + 6 }, g);
    if (node.isBot && liveRuns.some((x) => x.nodeId === id && x.status === 'läuft')) { const sp = el('g', { class: 'zs' }, g); el('circle', { class: 'spin-ring', r: bigRoot ? rad - 14 : rad + 11 }, sp); el('title', {}, sp).textContent = tr('arbeitet gerade', 'working right now'); }
    el('circle', { class: 'dot', r: rad }, g);
    if (node.isBot && bigRoot) el('circle', { class: 'ring', r: rad - 7 }, g);
    const leafHere = !children(s, id).length || collapsed.has(id);
    let t: SVGTextElement;
    if (arcNow() && !isRoot && leafHere && p.ang !== undefined) {
      // leaf nodes in the semicircle: label radiating outwards, mirrored on the left (readable)
      let deg = (p.ang * 180) / Math.PI;
      const left = Math.cos(p.ang) < 0;
      if (left) deg += 180;
      const off = rad + (node.isBot ? 11 : 6) + (collapsed.has(id) ? 16 : 0);
      t = el('text', { class: 'radial', x: left ? -off : off, y: 4, 'text-anchor': left ? 'end' : 'start', transform: `rotate(${deg})` }, g) as SVGTextElement;
    } else {
      t = el('text', { class: isRoot ? 'root' : '', x: 0, y: bigRoot ? 6 : isRoot && arcNow() ? rad + (node.isBot ? 26 : 22) : -(rad + (node.isBot ? 11 : 7)), 'text-anchor': 'middle' }, g) as SVGTextElement;
    }
    t.textContent = node.title;
    if (node.blocker) { const bz = el('g', { class: 'zs blk' }, g); el('circle', { cx: rad * 0.75, cy: -rad * 0.75, r: 4.5 }, bz); el('title', {}, bz).textContent = `${tr('Braucht dich', 'Needs you')}: ${node.blocker.text}`; }
    if (isRoot) { const nb = s.nodes.filter((x) => x.blocker).length; if (nb) { const bo = bigRoot ? rad * 0.7 : 0; const bw = el('g', { transform: `translate(${bo},${-bo})` }, g); const bz = el('g', { class: 'zs blk' }, bw); const bc = bigRoot ? 0 : rad; el('circle', { cx: bc, cy: -bc, r: 8 }, bz); const bt = el('text', { x: bc, y: -bc + 3.5, 'text-anchor': 'middle' }, bz); bt.textContent = String(nb); el('title', {}, bz).textContent = tr(`${nb} Stellen brauchen dich – Cockpit öffnen`, `${nb} places need you – open cockpit`); bz.setAttribute('data-act', 'cockpit'); } }
    const kidsN = children(s, id).length;
    if (kidsN) {
      const isCol = collapsed.has(id);
      const f = el('g', { class: `fold${isCol ? ' col' : ''}`, 'data-fold': id, transform: arcNow() && p.ang !== undefined && !isRoot ? `translate(${Math.cos(p.ang) * (rad + (node.isBot ? 15 : 9))},${Math.sin(p.ang) * (rad + (node.isBot ? 15 : 9))})` : bigRoot ? `translate(0,${rad - 20})` : `translate(${rad + (node.isBot ? 15 : 9)},0)` }, g);
      const fz = el('g', { class: 'zs' }, f);
      el('circle', { r: isCol ? 9 : 7.5 }, fz);
      const ft = el('text', { 'text-anchor': 'middle', y: isCol ? 3.6 : 3.6 }, fz);
      ft.textContent = isCol ? String(kidsN) : '−';
      el('title', {}, f).textContent = isCol ? tr(`${kidsN} Unterknoten zeigen`, `Show ${kidsN} sub-nodes`) : tr('Unterknoten einklappen', 'Collapse sub-nodes');
    }
  }
  drawActs(s);
  applyView(false);
  renderPop();
}

/** Action symbols above the selected bot (and above the owner): pass OK on, cascade, sweep, blockers, autorun. */
/** Radius of the big owner button: just inside the point where the rays begin. */
function rootRad() { return Math.max(30, arcRing * 0.55) - 5; }
function drawActs(s: GraphState) {
  if (sel?.kind !== 'node') return;
  const p = pos.get(sel.id);
  const n = nodeById(s, sel.id);
  if (!p || !n) return;
  const r = root(s);
  const isRoot = sel.id === r;
  const hasSubs = s.nodes.some((x) => x.isBot && x.id !== sel!.id && ancestors(s, x.id).includes(sel!.id));
  const items: [string, string, string][] = isRoot
    ? [['sweep', '▶ Sweep', tr('Alle Bots führen ihr „Bei OK“ aus (ganze Karte)', 'All bots run their "On OK" (whole map)')], ['next', 'OK ›', tr('OK an die oberste Bot-Ebene', 'OK to the top bot level')], ['blockers', `⚑ ${tr('Blocker', 'Blockers')}${s.nodes.some((x) => x.blocker) ? ` ${s.nodes.filter((x) => x.blocker).length}` : ''}`, tr('Wo wirst du gebraucht? Cockpit öffnen und Blocker neu einholen', 'Where are you needed? Open cockpit and re-collect blockers')], ['auto', autoSt?.on ? '■ Auto' : '∞ Auto', autoSt?.on ? tr('Autorun stoppen', 'Stop autorun') : tr('Autorun: gibt laufend OKs, bis du stoppst', 'Autorun: keeps giving OKs until you stop')], ['cockpit', '☰', 'Cockpit']]
    : [...(n.isBot && hasSubs ? [['next', 'OK ›', tr('OK an die nächste Ebene: Unter-Bots führen ihr „Bei OK“ aus', 'OK to the next level: sub-bots run their "On OK"')], ['zone', 'OK »', tr('OK-Kaskade: alle Bots in dieser Zone bis in die letzten Äste', 'OK cascade: all bots in this zone down to the last branches')]] as [string, string, string][] : []),
      ['addchild', tr('+ Unterknoten', '+ Sub-node'), tr('Neuen Unterknoten anlegen', 'Create a new sub-node')], ['remove', tr('Entfernen', 'Remove'), tr('Diesen Ast entfernen (mit Unterknoten, kommt in den Papierkorb)', 'Remove this branch (with sub-nodes, goes to the trash)')]];
  if (!items.length) return;
  const g = el('g', { transform: `translate(${p.x},${p.y})` }, $('nodes'));
  const z = el('g', { class: 'zs acts' }, g);
  const w = items.map(([, l]) => 14 + l.length * 6.6);
  const gap = 5, tot = w.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
  let x = -tot / 2;
  const y = isRoot && arcNow() && arcRing ? -rootRad() * 0.5 - 10 : isRoot ? -52 : -46;
  items.forEach(([a, l, tip], i) => {
    const b = el('g', { class: `act${a === 'auto' && autoSt?.on ? ' hot' : ''}`, 'data-act': a, transform: `translate(${x},${y})` }, z);
    el('rect', { width: w[i], height: 20, rx: 10 }, b);
    const tx = el('text', { x: w[i] / 2, y: 14, 'text-anchor': 'middle' }, b); tx.textContent = l;
    el('title', {}, b).textContent = tip;
    x += w[i] + gap;
  });
}

/** follow=true only when the owner pans/zooms: then the window moves with the node. */
function applyView(follow = true) {
  vp.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  // labels stay readable when zooming out: at least ~11.5 px on screen
  svg.style.setProperty('--fs', `${Math.max(13, 11.5 / view.k).toFixed(1)}px`);
  svg.style.setProperty('--zf', (Math.max(13, 11.5 / view.k) / 13).toFixed(3));
  if (!$('pop').hidden) placePop(follow);
}

function viewFor(pts: { x: number; y: number }[], padX = 220, padY = 80) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs) + padX, h = Math.max(...ys) - Math.min(...ys) + padY;
  const k = Math.min(1.4, Math.min(innerWidth / w, innerHeight / h));
  return { k, x: (innerWidth - (Math.max(...xs) + Math.min(...xs)) * k) / 2, y: (innerHeight - (Math.max(...ys) + Math.min(...ys)) * k) / 2 };
}

function fit() {
  // circle/semicircle: more margin for the radiating labels
  if (mode === 'circle' && !focusId) {
    // circle: fit to the full radius so nothing leaves the view while rotating
    const R = Math.max(230, ...[...pos.values()].map((p) => p.r ?? 0)) + 170;
    Object.assign(view, viewFor([{ x: -R, y: -R }, { x: R, y: R }], 0, 0));
  } else Object.assign(view, arcNow() ? viewFor([...pos.values()], 520, 380) : viewFor([...pos.values()]));
  applyView();
}

/** Smooth transition: node positions and view glide to the target in ~550 ms. */
let animFrame = 0;
function animateTo(target: typeof pos, targetView: { k: number; x: number; y: number }) {
  cancelAnimationFrame(animFrame);
  const from = new Map([...pos].map(([k, v]) => [k, { ...v }]));
  const v0 = { ...view };
  const t0 = performance.now(), D = 550;
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / D), e = ease(t);
    pos = new Map([...target].map(([k, b]) => {
      const a = from.get(k) ?? { ...b, x: b.x, y: b.y };
      return [k, { ...b, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }];
    }));
    view.k = v0.k + (targetView.k - v0.k) * e; view.x = v0.x + (targetView.x - v0.x) * e; view.y = v0.y + (targetView.y - v0.y) * e;
    render();
    if (t < 1) animFrame = requestAnimationFrame(step);
  };
  animFrame = requestAnimationFrame(step);
}

function setFocus(id: string | null) {
  focusId = id;
  const s = S();
  const prev = new Map([...pos].map(([k, v]) => [k, { ...v }]));
  layout(s);
  const target = pos;
  const pts = focusId ? [...ancestors(s, focusId), focusId].map((x) => target.get(x)!).filter(Boolean) : [...target.values()];
  const tv = viewFor(pts, focusId ? 360 : 220, focusId ? 360 : 80);
  pos = prev;
  animateTo(target, tv);
}

// ───────── Popover ─────────

function anchor(): { x: number; y: number } | null {
  if (!sel) return null;
  const s = S();
  let p: { x: number; y: number } | undefined;
  if (sel.kind === 'node') { const q = pos.get(sel.id); p = q && { x: q.x, y: q.y + 18 }; }
  else {
    const e = s.edges.find((x) => x.id === sel!.id);
    const a = e && pos.get(e.from), b = e && pos.get(e.to);
    if (a && b) p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 10 };
  }
  if (!p) return null;
  return { x: p.x * view.k + view.x, y: p.y * view.k + view.y };
}

/**
 * Place the window. An already open window stays put when only the content or the
 * layout changes (running bots) – otherwise it would jump away from under the pointer.
 */
function placePop(force = false) {
  const pop = $('pop');
  if (pop.dataset.dragged === pop.dataset.key && pop.style.top) return; // moved by the user: leave it
  if (pop.classList.contains('big')) { pop.style.left = ''; pop.style.top = ''; pop.style.maxHeight = ''; return; }
  const key = pop.dataset.key ?? '';
  const cap = pop.classList.contains('sized') ? 4000 : 620;
  if (!force && pop.dataset.placed === key && pop.style.top) {
    const top = parseFloat(pop.style.top);
    pop.style.maxHeight = `${Math.max(140, Math.min(cap, innerHeight - top - 8))}px`;
    return;
  }
  const a = anchor();
  if (!a) { pop.hidden = true; return; }
  pop.style.maxHeight = '';
  const w = pop.offsetWidth, h = pop.offsetHeight;
  // stay below the node (node and action symbols visible); rather shorter than above
  let top = a.y + 6;
  let left = a.x - w / 2;
  if (innerHeight - top < Math.min(h, 420) + 8) {
    // not enough room below: beside the node (node stays visible), vertically as tall as needed
    top = Math.max(8, Math.min(innerHeight - Math.min(h, 620) - 8, a.y - Math.min(h, 620) / 2));
    // gap larger than half the width of the action buttons above the node
    const gap = 140;
    left = a.x + gap + w < innerWidth - 8 ? a.x + gap : a.x - w - gap;
  }
  top = Math.max(8, top);
  pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, left))}px`;
  pop.style.top = `${top}px`;
  pop.style.maxHeight = `${Math.max(140, Math.min(cap, innerHeight - top - 8))}px`;
  pop.dataset.placed = key;
}

function promptChip(p: BranchPrompt) {
  const s = S();
  const t = p.taskId ? s.agentTasks.find((x) => x.id === p.taskId) : null;
  const status = p.kind === 'dauerhaft' ? '' : t ? ` · ${ST(t.status)}` : tr(' · notiert', ' · noted');
  return `<span class="chip ${p.kind === 'dauerhaft' ? 'standing' : ''}" title="${esc(p.createdAt.slice(0, 16).replace('T', ' '))}${p.via === 'stimme' ? tr(' · per Stimme', ' · by voice') : ''}">${esc(p.text.length > 48 ? p.text.slice(0, 46) + '…' : p.text)}${esc(status)}${p.kind === 'dauerhaft' ? ` <b data-run="${p.id}" title="${tr('jetzt ausführen', 'run now')}">▶</b>` : ''} <b data-del="${p.id}" title="${tr('entfernen', 'remove')}">×</b></span>`;
}

type RT = 'claude' | 'codex' | 'test' | 'chat';
interface Opt { group: string; runtime: RT; model: string; label: string; open?: { app?: string; url?: string } }
// A: Who works? "Works on its own on your Mac" (immediately, no chat needed) or "In chat" (waits until you pick up the task in the chat).
// B: Provider/place is in the name. C: Pace (fast/thorough) is chosen separately below.
// A function (not a constant): the language is only known once the state is loaded.
const OPTIONS = (): Opt[] => {
  const G1 = tr('Arbeitet selbst · auf deinem Mac · sofort', 'Works on its own · on your Mac · immediately');
  const G2 = tr('Im Chat · wartet, bis du ihn im Chat abholst', 'In chat · waits until you pick it up in the chat');
  return [
    { group: G1, runtime: 'claude', model: 'fable', label: tr('Claude Fable 5.2 (am stärksten, braucht am meisten Kontingent)', 'Claude Fable 5.2 (strongest, uses the most quota)') },
    { group: G1, runtime: 'claude', model: 'sonnet', label: 'Claude Sonnet' },
    { group: G1, runtime: 'claude', model: 'opus', label: tr('Claude Opus (stärker, langsamer)', 'Claude Opus (stronger, slower)') },
    { group: G1, runtime: 'claude', model: 'haiku', label: tr('Claude Haiku (am schnellsten)', 'Claude Haiku (fastest)') },
    { group: G1, runtime: 'codex', model: '', label: 'ChatGPT (Codex)' },
    { group: G2, runtime: 'chat', model: 'claude-desktop', label: tr('Claude-App', 'Claude app'), open: { app: 'Claude' } },
    { group: G2, runtime: 'chat', model: 'chatgpt-desktop', label: tr('ChatGPT-App', 'ChatGPT app'), open: { app: 'ChatGPT' } },
    { group: G2, runtime: 'chat', model: 'claude.ai', label: tr('claude.ai im Browser', 'claude.ai in the browser'), open: { url: 'https://claude.ai/new' } },
    { group: G2, runtime: 'chat', model: 'chatgpt.com', label: tr('chatgpt.com im Browser', 'chatgpt.com in the browser'), open: { url: 'https://chatgpt.com/' } },
    { group: tr('Ohne KI', 'Without AI'), runtime: 'test', model: '', label: tr('Test-Bot', 'Test bot') },
  ];
};
let modelMenu: false | 'set' | 'add' = false;
let nodeMenu: null | 'menu' | 'archive' | 'link' | 'instr' | 'uprompt' | 'reich' = null;
let replyKey: string | null = null;
let chatPend: { key: string; nodeId: string; threadId: string; readonly: boolean }[] = [];
const optOf = (m: { runtime: string; model: string }) => OPTIONS().find((o) => o.runtime === m.runtime && (o.model === m.model || (m.runtime === 'chat' && !m.model && o.model === 'claude-desktop')));
const mlabel = (m: { runtime: string; model: string }) => optOf(m)?.label ?? `${m.runtime}${m.model ? ' · ' + m.model : ''}`;
const CHAT_SHORT: Record<string, string> = { 'chatgpt.com': 'ChatGPT', 'claude.ai': 'Claude', 'chatgpt-desktop': 'ChatGPT-App', 'claude-desktop': 'Claude-App' }; // brand names, same in both languages
const short = (m: { runtime: string; model: string; chatModel?: string }) =>
  m.runtime === 'claude' ? (m.model === 'fable' ? 'Claude Fable 5.2' : `Claude ${m.model[0]?.toUpperCase() ?? ''}${m.model.slice(1)}`) : m.runtime === 'codex' ? 'ChatGPT (Codex)' : m.runtime === 'chat' ? `${CHAT_SHORT[m.model] || 'Chat'}${m.chatModel ? ' ' + m.chatModel : ''}` : mlabel(m);

function membersOf(id: string): { runtime: RT; model: string; chatModel?: string }[] {
  const p = nodeById(S(), id)?.agentProfile;
  if (p?.members?.length) return p.members;
  const rt = runtimeOf(id);
  if (rt === 'chat') return [{ runtime: 'chat', model: 'claude-desktop' }];
  if (rt === 'standard') return [{ runtime: 'claude', model: 'sonnet' }];
  return [{ runtime: rt as RT, model: rt === 'claude' ? (p?.model && p.model !== 'unbestimmt' ? p.model.split(' ')[0] : 'haiku') : '' }];
}

function setMembers(id: string, members: { runtime: RT; model: string; chatModel?: string }[]) {
  const n = nodeById(S(), id)!;
  n.agentProfile = { ...(n.agentProfile ?? { name: `Bot ${n.title}`, provider: '', model: '', workdir: '', allowedSourceIds: [], instructions: '' }), members };
}

const CHEV = '<svg class="chev" width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SUMMARIZE = () => tr('Kurzlage neu: dg set-todos mit 3× "+Befund → To-do" und 2× "-Befund → To-do", stichpunktartig, To-do mit Verb zuerst, je max. 8 Wörter. Ändere sonst nichts.', 'New short status: dg set-todos with 3× "+finding → to-do" and 2× "-finding → to-do", in bullet points, to-do starting with a verb, max. 8 words each. Change nothing else.');
let detailsOpen = false;
let big = false;
let minimized = false;

const CHAT_MODELS_GPT = ['Auto', 'gpt-6-astra', 'Thinking', 'Pro'];
const CHAT_MODELS_CLAUDE = ['Fable 5.2', 'Opus', 'Sonnet', 'Haiku'];
const EFFORTS = (): [string, string][] => [['low', tr('schnell', 'fast')], ['medium', tr('normal', 'normal')], ['high', tr('gründlich', 'thorough')], ['xhigh', tr('sehr gründlich', 'very thorough')], ['max', tr('maximal', 'maximum')]];
const effortOf = (id: string) => nodeById(S(), id)?.agentProfile?.effort ?? 'low';
/** Work folders a node inherits from above (not its own). */
const inheritedDirs = (id: string) => ancestors(S(), id).flatMap((a) => (nodeById(S(), a)?.workDirs ?? []).map((d) => ({ d, from: nodeById(S(), a)!.title })));

/** Header row of a bot: "haiku + sonnet ⌄ +  ↗ … ⋯". */
function modelHead(id: string) {
  const ms = membersOf(id);
  const hasChat = ms.some((m) => m.runtime === 'chat');
  const win = `<span class="ic" data-a="big" title="${big ? tr('Verkleinern', 'Make smaller') : tr('Groß ansehen', 'View large')}">${big ? '⤡' : '⤢'}</span><span class="ic" data-a="nmenu" title="${tr('Mehr', 'More')}">⋯</span><span class="ic" data-a="min" title="${minimized ? tr('Wieder öffnen', 'Reopen') : tr('Minimieren', 'Minimize')}">${minimized ? '▢' : '–'}</span><span class="ic" data-a="close" title="${tr('Schließen (Esc)', 'Close (Esc)')}">×</span>`;
  // Row 1: name + window buttons · row 2: models (full width) + bot actions
  return `<div class="mhead mh2"><div class="mrow1"><span class="mtitle" data-rename="${esc(id)}" title="${tr('Doppelklick: umbenennen', 'Double-click: rename')}">${esc(nodeById(S(), id)?.title)}</span><span class="sp"></span>${win}</div><div class="mrow2"><span class="dd-btn" data-a="mset" title="${esc(ms.map(mlabel).join(' + '))} – ${tr('Modell, Denkstufe, Zugriff', 'model, reasoning level, access')}">${ms.map(short).map(esc).join(' + ')}${ms.length ? `<i class="eff">· ${esc(EFFORTS().find((e) => e[0] === effortOf(id))?.[1] ?? '')}${nodeById(S(), id)?.private ? tr(' · privat', ' · private') : ''}</i>` : ''} ${CHEV}</span><span class="ic plus" data-a="mmore" title="${tr('weiteres Modell (Abstimmung)', 'another model (vote)')}">+</span>${hasChat ? `<span class="where chat" title="${tr('Dieser Bot arbeitet im Chat: Aufträge warten, bis du sie dort abholst', 'This bot works in the chat: tasks wait until you pick them up there')}">Chat</span><span class="ic" data-a="open-chat" title="${tr('Chat öffnen', 'Open chat')}">↗</span>` : ms.some((m) => m.runtime === 'claude' || m.runtime === 'codex') ? `<span class="where mac" title="${tr('Dieser Bot arbeitet selbst auf deinem Mac (dein Abo). Hier im Fenster mit ihm sprechen – Mikrofon in der Mind-App.', 'This bot works on its own on your Mac (your subscription). Talk to it here in the window – microphone in the Mind app.')}">Mac</span>` : ''}<span class="sp"></span><span class="ic act" data-a="update" title="${tr('Aktualisieren: Lage prüfen, Daten und Arbeitsanweisung pflegen, Unter-Bots anstoßen', 'Update: check the situation, maintain data and work instruction, nudge sub-bots')}">↻</span><span class="ic ${nodeMenu === 'instr' ? 'on' : ''}" data-a="instr" title="${tr('Arbeitsanweisung dieses Bereichs', 'Work instruction of this area')}">≡</span></div></div>`;
}

function modelMenuHtml(id: string) {
  if (!modelMenu) return '';
  const ms = membersOf(id);
  const groups = [...new Set(OPTIONS().map((o) => o.group))];
  const adding = modelMenu === 'add';
  const chatM = ms.findIndex((m) => m.runtime === 'chat');
  const cli = ms.some((m) => m.runtime === 'claude' || m.runtime === 'codex');
  const isClaudeChat = chatM >= 0 && /claude/.test(ms[chatM].model);
  const sugg = isClaudeChat ? CHAT_MODELS_CLAUDE : CHAT_MODELS_GPT;
  const chatField = !adding && chatM >= 0 ? `<div class="grp">${tr('Modell im Chat', 'Model in chat')}</div><div class="seg">${sugg.map((x) => `<span class="${(ms[chatM].chatModel ?? '') === x ? 'on' : ''}" data-chatpick="${esc(x)}">${esc(x)}</span>`).join('')}</div>
    <div class="seg"><input id="chat-model" data-chatm="${chatM}" placeholder="${tr('anderes Modell eintippen ↵', 'type another model ↵')}" value="${esc(sugg.includes(ms[chatM].chatModel ?? '') ? '' : ms[chatM].chatModel ?? '')}"></div>` : '';
  const effortSeg = `<div class="grp">${tr('Tempo / Denkstufe', 'Pace / reasoning level')}${!cli && chatM >= 0 ? ` <i>${tr('– wird dem Chat als Arbeitsweise mitgegeben', '– passed to the chat as a way of working')}</i>` : ''}</div><div class="seg">${EFFORTS().map(([k, l]) => `<span class="${effortOf(id) === k ? 'on' : ''}" data-effort="${k}">${l}</span>`).join('')}</div>`;
  const mailMode = nodeById(S(), id)?.agentProfile?.mailSend ?? 'ok';
  const mailSeg = cli ? `<div class="grp">${tr('E-Mail senden', 'Send email')} <i>${tr('– Web, Drive, Gmail lesen und Entwürfe gehen immer', '– web, Drive, Gmail reading and drafts always work')}</i></div><div class="seg"><span class="${mailMode === 'ok' ? 'on' : ''}" data-mail="ok" title="${tr('Senden, Antworten, Einladungen, Drive-Teilen nur, wenn du oder der Chef OK gibt', 'Sending, replying, invitations, Drive sharing only when you or the boss give OK')}">${tr('nur nach OK', 'only after OK')}</span><span class="${mailMode === 'immer' ? 'on' : ''}" data-mail="immer" title="${tr('Bot darf selbst senden', 'Bot may send on its own')}">${tr('dauerhaft erlaubt', 'always allowed')}</span></div>` : '';
  const seg = !adding ? chatField + effortSeg + (cli ? `<div class="grp">${tr('Zugriff', 'Access')}</div><div class="seg"><span data-a="reich" title="${tr('Reich: eigener Knoten, Unterknoten und Arbeitsordner – dort darf der Bot alles', 'Realm: own node, sub-nodes and work folders – the bot may do anything there')}">${tr('Reich · Arbeitsordner · privat …', 'Realm · work folders · private …')}</span></div>` : '') + mailSeg : '';
  // Order: 1. settings (pace, access, email – short, always visible), 2. models
  return `<div class="menu dd">
    ${seg}
    ${!adding && ms.length > 1 ? `<div class="grp">${tr('Abstimmung · ★ = Vorsitz', 'Vote · ★ = chair')}</div>${ms.map((m, i) => `<div class="opt" data-chair="${i}">${i === 0 ? '★' : '☆'} ${esc(mlabel(m))}<b data-mdel="${i}">×</b></div>`).join('')}` : ''}
    ${adding ? `<div class="grp">${tr('Weiteres Modell – Frage geht an alle, dann Abstimmung', 'Another model – the question goes to all, then a vote')}</div>` : ''}
    ${groups.map((g) => `<div class="grp">${esc(g)}</div>${OPTIONS().map((o, i) => (o.group === g ? `<div class="opt ${!adding && ms.length === 1 && optOf(ms[0]) === o ? 'cur' : ''}" ${adding ? `data-madd="${i}"` : `data-mopt="${i}"`}>${!adding && ms.length === 1 && optOf(ms[0]) === o ? '● ' : ''}${esc(o.label)}</div>` : '')).join('')}`).join('')}
  </div>`;
}

/** "Finding → to-do": to-do in bold, finding small underneath. Old entries without an arrow stay single-line. */
function tdItem(x: string, k: 'pos' | 'neg') {
  const m = x.split(/\s*(?:→|->|=>)\s*/);
  if (m.length < 2) return `<div class="td ${k}">${md(x)}</div>`;
  const todo = m.slice(1).join(' → ');
  return `<div class="td ${k}"><b>${md(todo)}</b><span class="bef">${md(m[0])}</span></div>`;
}

function todosHtml(id: string, bot: boolean) {
  const n = nodeById(S(), id)!;
  const t = n.todos;
  const refresh = bot ? `<span class="ic sm" data-a="summarize" title="${tr('Kurzlage vom Bot neu erstellen lassen', 'Have the bot recreate the short status')}">↻</span>` : '';
  if (!t) return `<div class="todos empty">${tr('Noch keine Kurzlage.', 'No short status yet.')}${bot ? ' ' + refresh : nodeById(S(), id)?.remote ? '' : ` <span class="hint">${tr('+ oben im Fenster legt einen Agenten an.', '+ at the top of the window creates an agent.')}</span>`}</div>`;
  return `<div class="todos">
    ${t.pos.map((x) => tdItem(x, 'pos')).join('')}
    ${t.neg.map((x) => tdItem(x, 'neg')).join('')}
    <div class="tdmeta">${esc(t.at.slice(0, 10))} · ${esc(who(t.by))} ${refresh}</div>
  </div>`;
}

const openSteps = new Set<string>();
const SPIN_WORDS = () => [tr('Grübelt', 'Pondering'), tr('Prüft', 'Checking'), tr('Sortiert', 'Sorting'), tr('Kombobuliert', 'Cogitating'), tr('Wägt ab', 'Weighing up'), tr('Sichtet', 'Reviewing'), tr('Tüftelt', 'Tinkering'), tr('Rechnet nach', 'Recalculating'), tr('Sinniert', 'Musing')];
let spinIdx = 0;
let lastCount = 0;

/** Below the short status: state (brief), latest conversation visible, older items and open points expandable. */
function miniLine(id: string) {
  const t = nodeById(S(), id)?.todos;
  return `${CHEV.replace('M1 1l4 4 4-4', 'M1 5l4-4 4 4')} ${tr('Kurzlage', 'Short status')}${t ? ` · <b class="p">${t.pos.length} +</b> <b class="n">${t.neg.length} –</b> · ${esc((t.pos[0] ?? '').replace(/\s–.*$/, '').slice(0, 48))}` : ''}`;
}

function chefOf(id: string): string | null {
  for (const a of ancestors(S(), id).reverse()) if (nodeById(S(), a)?.isBot) return a;
  return null;
}

function detailsHtml(n: { id: string; summary: string; openPoints: string[]; isBot?: boolean }) {
  const chef = n.isBot ? null : chefOf(n.id);
  const f = n.isBot ? (m: BotMessage) => m.to === n.id || m.from === n.id : (m: BotMessage) => m.about === n.id;
  const all = S().botMessages.filter(f);
  const lim = big ? 30 : 3;
  const recent = n.isBot || chef ? talkHtml(f, n.isBot ? n.id : chef, lim) : '';
  const olderN = Math.max(0, all.length - lim);
  const older = olderN;
  const instr = nodeById(S(), n.id)?.instruction;
  const area = new Set([n.id, ...descendants(S(), n.id)]);
  const decs = S().decisions.filter((d) => area.has(d.nodeId)).slice().sort((a, b) => (b.at ?? b.date ?? '').localeCompare(a.at ?? a.date ?? ''));
  const supersededBy = new Map(S().decisions.filter((d) => d.refersTo).map((d) => [d.refersTo!, d.id] as const));
  const decHtml = decs.length ? `<div class="decs"><div class="grp">${tr('Entscheidungen', 'Decisions')}</div>${decs.slice(0, big ? 50 : 8).map((d) => `<div class="dec ${d.kind}${supersededBy.has(d.id) ? ' old' : ''}"><i>${esc(d.date ?? '?')} · ${esc(d.kind)}${d.nodeId !== n.id ? ` · ${esc(nodeById(S(), d.nodeId)?.title ?? d.nodeId)}` : ''}${d.by ? ` · ${esc(who(d.by))}` : ''}</i><b>${md(d.content)}</b>${d.rationale ? `<span>${md(d.rationale)}</span>` : ''}${supersededBy.has(d.id) ? `<span class="sup">${tr('überholt durch spätere Korrektur', 'superseded by a later correction')}</span>` : ''}</div>`).join('')}</div>` : '';
  if (!nodeFilesCache.has(n.id)) loadNodeFiles(n.id);
  const files = (nodeFilesCache.get(n.id) ?? []).filter((f) => !/^(CLAUDE|AGENTS)\.md$/.test(f.path));
  const filesHtml = files.length ? `<div class="files"><div class="grp">${tr('Dateien', 'Files')}</div>${files.slice(0, 30).map((f) => `<div class="file" data-a="readfile" data-id="${esc(f.path)}" title="${/\.(pdf|png|jpe?g|gif|webp|svg|html?)$/i.test(f.path) ? tr('Klicken zum Ansehen', 'Click to view') : tr('Klicken zum Lesen', 'Click to read')}"><span>${/\.pdf$/i.test(f.path) ? '📕' : /\.(png|jpe?g|gif|webp|svg)$/i.test(f.path) ? '🖼' : '📄'} ${esc(f.path)}</span><a class="dl" href="/api/node-raw?id=${encodeURIComponent(n.id)}&path=${encodeURIComponent(f.path)}&dl=1" download title="${tr('Herunterladen', 'Download')}">⤓</a><i>${f.size < 1024 ? f.size + ' B' : Math.round(f.size / 1024) + ' KB'} · ${esc(new Date(f.at).toLocaleString(LOC(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</i></div>`).join('')}</div>` : '';
  const hasMore = older > 0 || n.openPoints.length > 0 || !!instr || decs.length > 0;
  // New: changes of the last 48 h (notes, summary …) – so work from chats/connector becomes visible
  const since = Date.now() - 48 * 3_600_000;
  const news = S().log.filter((l) => l.nodeId === n.id && Date.parse(l.at) > since && !/^(Lauf|Run) |Modell im Chat|Model in chat/.test(l.text)).slice(-4).reverse();
  const newsHtml = news.length ? `<div class="news"><div class="grp">${tr('Neu', 'New')}</div>${news.map((l) => `<div class="nw${newsOpen.has(l.at) ? ' open' : ''}" data-a="news" data-id="${esc(l.at)}"><i>${esc(new Date(l.at).toLocaleString(LOC(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</i> ${esc(l.text.replace(new RegExp(`^(${[OWNER_ID, ...OWNER_ALIASES].join('|')}): `), '').replace(/^[a-z0-9-]+: /, ''))}</div>`).join('')}</div>` : '';
  return `${newsHtml}${filesHtml}${n.summary ? `<div class="stand ${detailsOpen ? 'full' : ''}" data-a="details" title="${tr('Klicken: ganz lesen', 'Click: read in full')}">${md(n.summary)}</div>` : ''}
    ${recent}
    ${hasMore ? `<div class="more-btn" data-a="details">${detailsOpen ? CHEV.replace('M1 1l4 4 4-4', 'M1 5l4-4 4 4') : CHEV} ${[older ? tr(`${older} ältere Nachrichten`, `${older} older messages`) : '', n.openPoints.length ? tr(`${n.openPoints.length} offene Punkte`, `${n.openPoints.length} open points`) : '', decs.length ? tr(`${decs.length} Entscheidungen`, `${decs.length} decisions`) : '', instr ? tr('Arbeitsanweisung', 'Work instruction') : ''].filter(Boolean).join(' · ')}</div>` : ''}
    ${detailsOpen ? `<div class="details">
      ${instr ? `<div class="instr"><div class="grp">${tr('Arbeitsanweisung', 'Work instruction')} · ${esc(instr.at.slice(0, 10))} · ${esc(who(instr.by))} · <b class="lnk" data-a="instr">${tr('bearbeiten', 'edit')}</b></div>${md(instr.text).replace(/\n/g, '<br>')}</div>` : ''}
      ${decHtml}
      ${n.openPoints.length ? `<div class="dop">${n.openPoints.map((p) => `<div>· ${md(p)}</div>`).join('')}</div>` : ''}
      ${older ? talkHtml((m) => f(m) && all.indexOf(m) < older, null, 200) : ''}
    </div>` : ''}`;
}

const newsOpen = new Set<string>();
const nodeFilesCache = new Map<string, { path: string; size: number; at: string }[]>();
async function loadNodeFiles(id: string) {
  try { const f = await (await fetch(`/api/node-files?id=${encodeURIComponent(id)}`)).json(); const old = JSON.stringify(nodeFilesCache.get(id)); nodeFilesCache.set(id, f); if (old !== JSON.stringify(f) && sel?.kind === 'node' && sel.id === id) renderPop(); } catch { /* */ }
}
async function openReader(id: string, path: string) {
  const r = await fetch(`/api/node-file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`);
  const txt: string = r.ok ? await r.text() : String((await r.json()).error);
  const el = $('reader');
  el.innerHTML = `<div class="rdwrap"><div class="rtop"><b>${esc(path)}</b><i>${esc(nodeById(S(), id)?.title ?? id)}</i><span class="sp"></span><span class="ic" data-rd="copy" title="${tr('Text kopieren', 'Copy text')}">⧉</span><span class="ic" data-rd="close" title="${tr('Schließen (Esc)', 'Close (Esc)')}">×</span></div><div class="rdbody">${/\.md$/i.test(path) ? txt.split('\n').map((l: string) => { const h = l.match(/^(#{1,6})\s+(.*)$/); if (h) return `<div class="rdh h${h[1].length}">${md(h[2])}</div>`; if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) return '<hr>'; return l.trim() ? `<div>${md(l)}</div>` : '<div class="rdgap"></div>'; }).join('') : `<pre>${esc(txt)}</pre>`}</div></div>`;
  (el as unknown as { _txt: string })._txt = txt;
  el.hidden = false;
}
const askLink = new Set<string>(); // nodes whose chat link should be saved after the first open

/**
 * ↗ Open chat – one chat per node:
 * saved link → exactly that chat; otherwise on claude.ai/chatgpt.com a new chat with a prefilled
 * task or context, then have the link saved. Desktop apps only open the app (last used chat).
 */
async function openChat(nodeId: string, key?: string) {
  const s = S();
  const n = nodeById(s, nodeId)!;
  const p = n.agentProfile;
  const m: { runtime: string; model: string; chatModel?: string } = membersOf(nodeId).find((x) => x.runtime === 'chat') ?? { runtime: 'chat', model: 'chatgpt.com' };
  const o = optOf(m);
  const go = async (target: { app?: string; url?: string; dock?: boolean }) => {
    const r = await fetch('/api/open', { method: 'POST', body: JSON.stringify(target) }).catch(() => null);
    if (!r?.ok && target.url) window.open(target.url, '_blank');
  };
  if (p?.chatUrl) {
    if (m.chatModel) note(tr(`Im Chat oben auf „${m.chatModel}“ stellen, falls noch nicht geschehen.`, `Switch the chat to "${m.chatModel}" at the top if you haven't already.`));
    return go({ url: p.chatUrl, dock: true } as { url: string });
  }
  if (o?.model === 'claude.ai' || o?.model === 'chatgpt.com') {
    const pend = key ?? chatPend.find((c) => c.nodeId === nodeId)?.key;
    const connOn = await fetch('/api/connector').then((r) => r.json()).then((c) => !!c.enabled).catch(() => false);
    let text: string;
    if (connOn) {
      // With connector: short start task – the chat fetches state and instructions itself.
      text = tr(`Du bist der Bot „${n.title}“ (Knoten ${nodeId}) in ${OWNER()}s Mind. Dieser Chat gehört nur zu diesem Bot.\n`
        + `1. Rufe über den Mind-Connector mind_brief mit node="${nodeId}" auf: Stand, Kurzlage, Grundregeln und Arbeitsanweisungen.\n`
        + `2. Lies mit mind_messages node="${nodeId}" den bisherigen Verlauf und prüfe mind_inbox auf offene Fragen an dich${pend ? ` (offen: ${pend})` : ''}; beantworte sie mit mind_reply.\n`
        + `3. Arbeite ab jetzt in diesem Chat als „${n.title}“: Änderungen nur über die Mind-Werkzeuge, Kurzlage als „+Befund → To-do“, nichts erfinden.\n`
        + `${m.chatModel || effortOf(nodeId) ? `Arbeitsweise: ${m.chatModel ? `Modell ${m.chatModel}` : ''}${m.chatModel && effortOf(nodeId) ? ', ' : ''}Denkstufe ${EFFORTS().find((e) => e[0] === effortOf(nodeId))?.[1]} – denke entsprechend ${effortOf(nodeId) === 'low' ? 'knapp und schnell' : 'gründlich'}.\n` : ''}`
        + `Antworte zum Start kurz mit deiner aktuellen Lage.`,
        `You are the bot "${n.title}" (node ${nodeId}) in ${OWNER()}'s Mind. This chat belongs only to this bot.\n`
        + `1. Call mind_brief via the Mind connector with node="${nodeId}": state, short status, ground rules and work instructions.\n`
        + `2. Read the history so far with mind_messages node="${nodeId}" and check mind_inbox for open questions to you${pend ? ` (open: ${pend})` : ''}; answer them with mind_reply.\n`
        + `3. From now on work in this chat as "${n.title}": changes only via the Mind tools, short status as "+finding → to-do", invent nothing.\n`
        + `${m.chatModel || effortOf(nodeId) ? `Way of working: ${m.chatModel ? `model ${m.chatModel}` : ''}${m.chatModel && effortOf(nodeId) ? ', ' : ''}reasoning level ${EFFORTS().find((e) => e[0] === effortOf(nodeId))?.[1]} – think accordingly ${effortOf(nodeId) === 'low' ? 'briefly and quickly' : 'thoroughly'}.\n` : ''}`
        + `Start by replying briefly with your current situation.`);
    } else {
      const body = pend ? await dgText({ cmd: 'task', args: [pend, 'online'] }) : await dgText({ cmd: 'show', args: [nodeId], as: OWNER_ID });
      text = tr(`Dieser Chat gehört zum Knoten „${n.title}“ (${nodeId}) in ${OWNER()}s Mind. Bleib in diesem Chat bei diesem Thema.\n\n${body}`, `This chat belongs to the node "${n.title}" (${nodeId}) in ${OWNER()}'s Mind. Stay on this topic in this chat.\n\n${body}`);
    }
    const base = o.model === 'claude.ai' ? 'https://claude.ai/new' : 'https://chatgpt.com/';
    // ChatGPT accepts a model via the URL (short name without spaces); Claude does not – switch it in the chat there.
    const gptModel = o.model === 'chatgpt.com' && m.chatModel && /^[\w.-]+$/.test(m.chatModel) && !/^auto$/i.test(m.chatModel) ? `&model=${encodeURIComponent(m.chatModel)}` : '';
    let url = `${base}?q=${encodeURIComponent(text)}${gptModel}`;
    if (url.length > 7000) { url = base; await copy(text, tr('Auftrag kopiert – im neuen Chat einfügen.', 'Task copied – paste it into the new chat.')); }
    await go({ url, dock: true } as { url: string });
    askLink.add(nodeId);
    note(tr('Neuer Chat für diesen Bot geöffnet (rechts). Link aus der Adresszeile unten im Fenster speichern – dann führt ↗ immer hierher.', 'New chat for this bot opened (right). Save the link from the address bar at the bottom of the window – then ↗ always leads here.'));
    renderPop();
    return;
  }
  await go(o?.open ?? { app: 'ChatGPT' });
  note(tr('Die Desktop-App zeigt den zuletzt benutzten Chat. Für einen eigenen Chat je Knoten: dort neuen Chat beginnen und seinen Link unter ⋯ → Chat-Link speichern.', 'The desktop app shows the last used chat. For a separate chat per node: start a new chat there and save its link under ⋯ → Save chat link.'));
}

function linkAskHtml(nodeId: string) {
  if (!askLink.has(nodeId) || nodeById(S(), nodeId)?.agentProfile?.chatUrl) return '';
  return `<div class="linkask"><div class="mut">${tr('Link dieses Chats speichern – dann öffnet ↗ immer genau diesen Chat:', 'Save this chat\'s link – then ↗ always opens exactly this chat:')}</div><div class="row"><input id="chatlink-inline" placeholder="${tr('https://chatgpt.com/c/… oder https://claude.ai/chat/… ↵', 'https://chatgpt.com/c/… or https://claude.ai/chat/… ↵')}"></div></div>`;
}

async function copy(text: string, msg: string) {
  try { await navigator.clipboard.writeText(text); note(msg); }
  catch { note(tr('Zwischenablage nicht verfügbar – Text im Browser öffnen.', 'Clipboard not available – open the text in the browser.')); }
}

async function dgText(body: Record<string, unknown>) {
  const r = await fetch('/api/dg', { method: 'POST', body: JSON.stringify({ args: [], node: null, actor: OWNER_ID, thread: '', depth: 0, ...body }) });
  return r.text();
}

function runtimeOf(id: string) {
  const prov = (nodeById(S(), id)?.agentProfile?.provider ?? '').toLowerCase();
  return prov.startsWith('anthropic') ? 'claude' : prov.startsWith('openai') ? 'codex' : RUNTIMES.find((r) => r !== 'standard' && prov.startsWith(r)) ?? 'standard';
}

function threadsOfEdge(edgeId: string) {
  return new Set(S().botMessages.filter((m) => m.edgeId === edgeId).map((m) => m.threadId));
}

const md = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
const who = (id: string) => (id === OWNER_ID ? tr('Du', 'You') : id.startsWith('partner:') ? id.slice(8) : nodeById(S(), id)?.title ?? id);

function talkHtml(filter: (m: BotMessage) => boolean, botId: string | null, limit = 8) {
  const msgs = S().botMessages.filter(filter).slice(-limit);
  const threads = new Set(msgs.map((m) => m.threadId));
  const pending = liveRuns.filter((r) => r.status === 'läuft' && (threads.has(r.threadId) || r.nodeId === botId));
  if (!msgs.length && !pending.length && !chatPend.some((c) => c.nodeId === botId)) return '';
  let lastSec = msgs[0]?.section ?? 1;
  return `<div class="talk">${msgs.map((m) => `${(m.section ?? 1) !== lastSec ? `<div class="secdiv">${tr('Abschnitt', 'Section')} ${(lastSec = m.section ?? 1)}</div>` : ''}<div class="msg ${m.from === OWNER_ID ? 'me' : ''} ${m.kind}"><span>${m.kind === 'vorschlag' ? tr('Vorschlag · ', 'Proposal · ') : ''}${esc(who(m.from))}${m.to !== OWNER_ID && m.from !== OWNER_ID ? ` → ${esc(who(m.to))}` : ''}${m.runtime ? ` · ${esc(m.runtime)}` : ''}${m.about && m.about !== botId ? ` · ${tr('zu', 're')} ${esc(who(m.about))}` : ''}</span>${md(m.text)}${m.steps?.length ? `<div class="steps-t" data-steps="${m.id}">${CHEV} ${m.steps.length} ${tr('Schritte', 'steps')}</div>${openSteps.has(m.id) ? `<div class="steps">${m.steps.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : ''}` : ''}</div>`).join('')}
    ${pending.filter((r) => !/chat/.test(r.model + r.runtime)).map((r) => `<div class="msg pending live"><span>${esc(who(r.nodeId))} · ${esc(r.model || r.runtime)}</span><div class="spin"><i class="star">✻</i> <i class="word">${SPIN_WORDS()[spinIdx % SPIN_WORDS().length]}</i>…<b class="cancel" data-cancel="${r.id}" title="${tr('Lauf abbrechen', 'Cancel run')}">${tr('abbrechen', 'cancel')}</b></div>${(r.steps ?? []).slice(-5).map((x, i, a) => `<div class="step ${i === a.length - 1 ? 'cur' : ''}">${esc(x.text)}</div>`).join('')}</div>`).join('')}
    ${chatPend.filter((c) => threads.has(c.threadId) || c.nodeId === botId).map((c) => `<div class="msg pending"><span>${esc(who(c.nodeId))} · Chat${c.readonly ? tr(' · Vorschlag', ' · proposal') : ''}</span>${tr('wartet auf deinen Chat', 'waiting for your chat')}
      <div class="acts"><b data-ctask="${c.key}" title="${tr('Auftrag für Online-Chat kopieren', 'Copy task for online chat')}">⧉ ${tr('kopieren', 'copy')}</b><b data-copen="${c.nodeId}" title="${tr('Chat öffnen', 'Open chat')}">↗ ${tr('öffnen', 'open')}</b><b data-creply="${c.key}" title="${tr('Antwort aus dem Chat einfügen', 'Paste reply from the chat')}">↩ ${tr('Antwort', 'Reply')}</b><b data-cdrop="${c.key}" title="${tr('Diese wartende Frage verwerfen', 'Discard this waiting question')}">✕ ${tr('verwerfen', 'discard')}</b></div>
      ${replyKey === c.key ? `<textarea id="reply-text" placeholder="${tr('Antwort aus dem Chat einfügen · ⌘↵ senden', 'Paste reply from the chat · ⌘↵ to send')}"></textarea>` : ''}</div>`).join('')}</div>`;
}

function chefChainHtml(id: string) {
  const out: string[] = [];
  let c = chefOf(id);
  while (c) {
    const n = nodeById(S(), c)!;
    out.unshift(`<details class="chefins"><summary>${tr('Vorgabe von', 'Guideline from')} ${esc(n.title)}${n.instruction ? '' : tr(' – keine', ' – none')}</summary>${n.instruction ? md(n.instruction.text).replace(/\n/g, '<br>') : ''}</details>`);
    c = chefOf(c);
  }
  if (S().globalInstruction) out.unshift(`<details class="chefins"><summary>${tr('Grundregeln (alle Bots)', 'Ground rules (all bots)')}</summary>${md(S().globalInstruction!).replace(/\n/g, '<br>')}</details>`);
  return out.join('');
}

function nodeMenuHtml(id: string, isBot: boolean) {
  const kids = children(S(), id).length;
  if (nodeMenu === 'menu') return `<div class="menu dd">
    <div class="opt" data-a="child">${tr('Unterknoten anlegen', 'Create sub-node')}</div>
    ${kids ? `<div class="opt" data-a="fold">${collapsed.has(id) ? tr('Unterknoten zeigen', 'Show sub-nodes') : tr('Unterknoten einklappen', 'Collapse sub-nodes')}</div>` : ''}
    ${isBot ? `<div class="opt" data-a="instr">${tr('Arbeitsanweisung (≡)', 'Work instruction (≡)')}</div>` : ''}
    ${id === OWNER_ID ? '' : nodeById(S(), id)?.remote ? `<div class="opt" data-a="leave">${tr('Gespiegelten Ast verlassen', 'Leave mirrored branch')}</div>` : `<div class="opt" data-a="share">${nodeById(S(), id)?.sharedAs ? tr('Geteilt ✓ · neue Einladung', 'Shared ✓ · new invitation') : tr('Ast mit anderem Mind teilen …', 'Share branch with another Mind …')}</div>${nodeById(S(), id)?.sharedAs ? `<div class="opt" data-a="unshare">${tr('Teilen beenden', 'Stop sharing')}</div>` : ''}`}
    <div class="opt" data-a="reich">${tr('Reich · Arbeitsordner · privat', 'Realm · work folders · private')}${nodeById(S(), id)?.private ? ' 🔒' : ''}</div>
    <div class="opt" data-a="ctx">${tr('Kontext kopieren · im Chat weitermachen', 'Copy context · continue in chat')}</div>
    ${$('pop').classList.contains('sized') ? `<div class="opt" data-a="popreset">${tr('Fenstergröße zurücksetzen', 'Reset window size')}</div>` : ''}
    <div class="opt" data-a="arch">${tr('Chat-Auszug archivieren', 'Archive chat excerpt')}</div>
    ${isBot ? `<div class="opt" data-a="newsec">${tr('Neuer Gesprächsabschnitt', 'New conversation section')} (${tr('Abschnitt', 'Section')} ${nodeById(S(), id)?.agentProfile?.section ?? 1})</div><div class="opt" data-a="clink">${tr('Chat-Link des Bots', 'Bot chat link')}${nodeById(S(), id)?.agentProfile?.chatUrl ? ' ✓' : ''}</div>${nodeById(S(), id)?.agentProfile?.chatUrl ? `<div class="opt" data-a="newchat">${tr('Neuen Online-Chat beginnen (alten archivieren)', 'Start a new online chat (archive the old one)')}</div>` : ''}<div class="opt" data-a="bot">${tr('Agent entfernen', 'Remove agent')}</div>` : `<div class="opt" data-a="bot">${tr('Agent anlegen', 'Create agent')}</div>`}
  </div>`;
  if (nodeMenu === 'instr') return `<div class="form">${chefChainHtml(id)}<div class="grp">${tr('Arbeitsanweisung', 'Work instruction')} ${esc(nodeById(S(), id)?.title)}${nodeById(S(), id)?.instruction ? ` · ${esc(nodeById(S(), id)!.instruction!.at.slice(0, 10))} · ${esc(who(nodeById(S(), id)!.instruction!.by))}` : ''}</div><textarea id="instr-text" style="min-height:140px" placeholder="${tr(`Zweck, Prioritäten, Arbeitsweise, Qualitätsmaßstab, wann ${OWNER()} fragen, lokale Abweichungen`, `Purpose, priorities, way of working, quality bar, when to ask ${OWNER()}, local deviations`)}">${esc(nodeById(S(), id)?.instruction?.text ?? '')}</textarea><div class="row"><span class="sp"></span><button data-a="instr-save">${tr('Speichern', 'Save')}</button></div></div>`;
  if (nodeMenu === 'reich') {
    const n = nodeById(S(), id)!;
    const inh = inheritedDirs(id);
    const kids = descendants(S(), id).length;
    return `<div class="form"><div class="grp">${tr('Reich von', 'Realm of')} ${esc(n.title)}</div><div class="hint">${tr(`Der Bot darf hier alles (Bash, Python, Code, PDFs, Web): eigener Knoten${kids ? ` + ${kids} Unterknoten` : ''} und die Arbeitsordner. Außerhalb fragt er seinen Chef (dg request), ganz oben dich im Cockpit.`, `The bot may do anything here (bash, Python, code, PDFs, web): its own node${kids ? ` + ${kids} sub-nodes` : ''} and the work folders. Outside, it asks its boss (dg request), at the very top you in the cockpit.`)}</div>
      ${inh.length ? `<div class="hint">${tr('Geerbt', 'Inherited')}: ${inh.map((x) => `<code>${esc(x.d)}</code> (${tr('von', 'from')} ${esc(x.from)})`).join(', ')}</div>` : ''}
      <div class="grp">${tr('Arbeitsordner – gelten für den ganzen Ast, einer pro Zeile', 'Work folders – apply to the whole branch, one per line')}</div><textarea id="reich-dirs" style="min-height:70px" placeholder="~/Projects/my-app">${esc((n.workDirs ?? []).join('\n'))}</textarea>
      <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" id="reich-priv" ${n.private ? 'checked' : ''}> ${tr('privat – Bots außerhalb dieses Asts sehen und lesen ihn nicht', 'private – bots outside this branch cannot see or read it')}</label>
      <div class="row"><span class="sp"></span><button data-a="reich-save">${tr('Speichern', 'Save')}</button></div></div>`;
  }
  if (nodeMenu === 'uprompt') return `<div class="form"><div class="hint">${tr('Gilt für ↻ an allen Bots.', 'Applies to ↻ on all bots.')}</div><textarea id="uprompt-text" style="min-height:180px">${esc(S().updatePrompt ?? defaultUpdatePrompt())}</textarea><div class="row"><span class="hint" data-a="uprompt-reset" style="cursor:pointer">${tr('Standard wiederherstellen', 'Restore default')}</span><span class="sp"></span><button data-a="uprompt-save">${tr('Speichern', 'Save')}</button></div></div>`;
  if (nodeMenu === 'archive') return `<div class="form"><textarea id="arch-text" placeholder="${tr('Chat-Auszug einfügen', 'Paste chat excerpt')}"></textarea><div class="row"><input id="arch-link" placeholder="${tr('Link zum Chat (optional)', 'Link to the chat (optional)')}"><button data-a="arch-save">${tr('Archivieren', 'Archive')}</button></div></div>`;
  if (nodeMenu === 'link') return `<div class="form"><div class="row"><input id="chat-link" placeholder="${tr('https://claude.ai/chat/… oder chatgpt.com/c/…', 'https://claude.ai/chat/… or chatgpt.com/c/…')}" value="${esc(nodeById(S(), id)?.agentProfile?.chatUrl ?? '')}"><button data-a="clink-save">${tr('Speichern', 'Save')}</button></div></div>`;
  return '';
}

/**
 * Update the window without replacing unchanged parts: header row and input stay
 * the same DOM elements so clicks are not lost while bots are running.
 */
function setPop(pop: HTMLElement, html: string, same: boolean) {
  if (!same || !pop.children.length) { pop.innerHTML = html; return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const next = [...tmp.children] as HTMLElement[];
  const cur = [...pop.children] as HTMLElement[];
  if (next.length !== cur.length || next.some((n, i) => n.tagName !== cur[i].tagName || n.className.replace(/\bshow\b/, '') !== cur[i].className.replace(/\bshow\b/, ''))) { pop.innerHTML = html; return; }
  next.forEach((n, i) => {
    const c = cur[i];
    if (c.classList.contains('foot')) return; // never replace the input field
    if (n.outerHTML !== c.outerHTML) {
      if (c.classList.contains('body')) {
        // keep the short-status row (scroll state), swap the rest
        const top = c.scrollTop;
        c.innerHTML = n.innerHTML;
        c.scrollTop = top;
      } else c.replaceWith(n);
    }
  });
}

const okUsedToday = (id: string) => { const u = nodeById(S(), id)?.okUsed; return u?.day === new Date().toISOString().slice(0, 10) ? u.n : 0; };
/** "On OK I will …" – small, bold, dark grey at the top of the bot window; OK runs it. */
function okLineHtml(id: string) {
  const n = nodeById(S(), id)!;
  if (!n.okNext) return '';
  const busy = liveRuns.some((r) => r.nodeId === id && r.status === 'läuft');
  const q = n.okBudget ?? 0;
  return `<div class="okline" title="${tr(`Was ${esc(n.title)} tut, wenn du OK gibst (Stand ${esc(n.okNext.at.slice(0, 16).replace('T', ' '))})`, `What ${esc(n.title)} does when you give OK (as of ${esc(n.okNext.at.slice(0, 16).replace('T', ' '))})`)}"><span class="okl">${tr('Bei OK:', 'On OK:')}</span><b>${esc(n.okNext.text)}</b>${q ? `<i>${q - okUsedToday(id)}/${q}</i>` : ''}<span class="okbtn${busy ? ' off' : ''}" data-a="ok" title="${busy ? tr('Bot arbeitet gerade', 'Bot is working right now') : tr('Freigeben – der Bot führt das jetzt aus', 'Approve – the bot runs this now')}">OK</span></div>`;
}

function renderPop() {
  if ((document.activeElement as HTMLElement | null)?.classList.contains('rename')) return; // renaming in progress
  const pop = $('pop');
  const s = S();
  const key = sel ? `${sel.kind}:${sel.id}` : '';
  const same = pop.dataset.key === key && !pop.hidden;
  const vals = new Map<string, string>();
  if (same) pop.querySelectorAll<HTMLInputElement>('input[id],textarea[id]').forEach((el) => vals.set(el.id, el.value));
  const focusId = same ? (document.activeElement as HTMLElement | null)?.id || null : null;
  const keepScroll = (pop.querySelector('.body') as HTMLElement | null)?.scrollTop ?? 0;
  pop.dataset.key = key;
  let html = '';
  if (!sel) { pop.hidden = true; return; }
  if (sel.kind === 'node' && sel.id === root(s) && !ownerChat) { pop.hidden = true; return; }
  if (sel.kind === 'node') {
    const n = nodeById(s, sel.id);
    if (!n) { sel = null; pop.hidden = true; return; }
    html = `${n.isBot ? modelHead(n.id) : `<div class="mhead"><span class="ttl" data-rename="${esc(n.id)}" title="${tr('Doppelklick: umbenennen', 'Double-click: rename')}">${esc(n.title)}</span>${chefOf(n.id) && !n.remote ? `<i class="eff">· ${tr('Chef', 'Boss')}: ${esc(nodeById(s, chefOf(n.id)!)?.title)}</i>` : ''}<span class="sp"></span><span class="ic act" data-a="mkbot" title="${tr('Agent für diesen Knoten anlegen', 'Create an agent for this node')}">+</span><span class="ic" data-a="big" title="${big ? tr('Verkleinern', 'Make smaller') : tr('Groß ansehen', 'View large')}">${big ? '⤡' : '⤢'}</span><span class="ic" data-a="nmenu" title="${tr('Mehr', 'More')}">⋯</span><span class="ic" data-a="min" title="${minimized ? tr('Wieder öffnen', 'Reopen') : tr('Minimieren', 'Minimize')}">${minimized ? '▢' : '–'}</span><span class="ic" data-a="close" title="${tr('Schließen (Esc)', 'Close (Esc)')}">×</span></div>`}
      ${n.isBot ? okLineHtml(n.id) : ''}
      ${n.isBot ? modelMenuHtml(n.id) : ''}
      ${nodeMenuHtml(n.id, !!n.isBot)}
      ${childInput ? `<div class="row"><input id="child-title" placeholder="${tr('Name des Unterknotens ↵', 'Name of the sub-node ↵')}"></div>` : ''}
      <div class="body">${n.remote ? mirrorHtml(n) : ''}<div class="mini" data-a="totop" title="${tr('Zur Kurzlage', 'To the short status')}">${miniLine(n.id)}</div>${linkAskHtml(n.id)}${todosHtml(n.id, !!n.isBot)}${detailsHtml(n)}</div>
      ${n.isBot || n.remote ? `<div class="foot"><div class="livebar" id="livebar" hidden></div><div class="row ask"><input id="prompt" placeholder="${n.remote ? tr(`Nachricht an den Bot bei ${esc(n.remote.origin)}…`, `Message to the bot at ${esc(n.remote.origin)}…`) : tr(`Mit ${esc(n.title)} sprechen…`, `Talk to ${esc(n.title)}…`)}" autocomplete="off"><span class="ic" data-a="mic" id="mic" title="${tr('Spracheingabe', 'Voice input')}">🎤</span><span class="ic send" data-a="send" title="${tr('Senden (Enter)', 'Send (Enter)')}">↑</span></div></div>`
        : chefOf(n.id) ? `<div class="foot"><div class="livebar" id="livebar" hidden></div><div class="row ask"><input id="prompt" placeholder="${tr(`Frage zu ${esc(n.title)} an ${esc(nodeById(s, chefOf(n.id)!)?.title)}…`, `Question about ${esc(n.title)} to ${esc(nodeById(s, chefOf(n.id)!)?.title)}…`)}" autocomplete="off"><span class="ic" data-a="mic" id="mic" title="${tr('Spracheingabe', 'Voice input')}">🎤</span><span class="ic send" data-a="send" title="${tr('Senden (Enter)', 'Send (Enter)')}">↑</span></div></div>` : ''}`;
    pop.classList.toggle('big', big && !minimized);
    pop.classList.toggle('min', minimized);
  } else {
    const e = s.edges.find((x) => x.id === sel!.id);
    if (!e) { sel = null; pop.hidden = true; return; }
    const bot = responsibleBot(s, e.id);
    const prompts = s.branchPrompts.filter((p) => p.edgeId === e.id);
    const standing = prompts.filter((p) => p.kind === 'dauerhaft');
    const recent = prompts.filter((p) => p.kind === 'einmalig').slice(-3).reverse();
    html = `<div class="head"><span>${esc(nodeById(s, e.from)?.title)} → ${esc(nodeById(s, e.to)?.title)}</span><span>${bot ? `Bot: ${esc(nodeById(s, bot)?.title)}` : tr('kein Bot', 'no bot')} <span class="ic" data-a="close" title="${tr('Schließen (Esc)', 'Close (Esc)')}">×</span></span></div>
      <div class="body">
        ${standing.length ? `<div class="chips">${standing.map(promptChip).join('')}</div>` : ''}
        ${talkHtml((m) => threadsOfEdge(e.id).has(m.threadId), bot)}
        ${!bot && recent.length ? `<div class="chips">${recent.map(promptChip).join('')}</div>` : ''}
      </div>
      ${menuOpen ? `<div class="menu">${s.promptPresets.map((t, i) => `<div data-preset="${i}">${esc(t)}</div>`).join('')}<div data-a="save-preset" style="color:var(--mut)">${tr('Eingabe als Vorlage speichern', 'Save input as template')}</div></div>` : ''}
      <div class="foot"><div class="livebar" id="livebar" hidden></div><div class="row ask">
        <input id="prompt" placeholder="${tr('Was soll der Bot auf dieser Branch tun?', 'What should the bot do on this branch?')}" autocomplete="off">
        <span class="ic" data-a="mic" id="mic" title="${tr('Spracheingabe', 'Voice input')}">🎤</span><span class="ic send" data-a="send" title="${tr('Senden (Enter)', 'Send (Enter)')}">↑</span>
        <span class="ic plus" data-a="plus" title="${tr('Vorlage als dauerhafte Anweisung für diese Branch', 'Template as a standing instruction for this branch')}">+</span>
      </div></div>`;
  }
  setPop(pop, html, same);
  if (sel.kind !== 'node') pop.classList.remove('min', 'big');
  pop.hidden = false;
  placePop();
  for (const [id, v] of vals) { const el = document.getElementById(id) as HTMLInputElement | null; if (el && !el.value) el.value = v; }
  const inp = (document.getElementById(focusId ?? '') ?? (same ? null : document.getElementById('prompt') ?? document.getElementById('child-title'))) as HTMLInputElement | null;
  inp?.focus();
  // Chat behaviour: scroll down on new messages or running work, at the top when opening (short status first)
  const body = pop.querySelector('.body') as HTMLElement | null;
  const mini = pop.querySelector('.mini') as HTMLElement | null;
  if (body && mini) { const upd = () => mini.classList.toggle('show', body.scrollTop > 60); body.onscroll = upd; setTimeout(upd, 0); }
  const count = S().botMessages.length + liveRuns.filter((r) => r.status === 'läuft').reduce((a, r) => a + 1 + (r.steps?.length ?? 0), 0);
  if (body) {
    if (same && count !== lastCount) body.scrollTop = body.scrollHeight;
    else if (same) body.scrollTop = keepScroll;
  }
  lastCount = count;
}

function commit(redraw = true) {
  store.save();
  if (redraw) draw(); else renderPop();
}

async function exportTask(taskId: string) {
  const t = S().agentTasks.find((x) => x.id === taskId);
  if (!t || store.backend !== 'datei') return;
  const r = await fetch(`/api/agent/tasks/${t.id}`, { method: 'POST', body: JSON.stringify({ markdown: taskMarkdown(S(), t), task: t }) });
  if (r.ok) { t.exportedPath = (await r.json()).path; store.save(); }
}

async function send(text: string, via: BranchPrompt['via']) {
  if (!sel || !text.trim()) return;
  const s = S();
  const edgeId = sel.kind === 'edge' ? sel.id : null;
  const mirror = sel.kind === 'node' && !!nodeById(s, sel.id)?.remote;
  const about = sel.kind === 'node' && !mirror && !nodeById(s, sel.id)?.isBot ? sel.id : null;
  const bot = sel.kind === 'node' ? (about ? chefOf(sel.id) : sel.id) : responsibleBot(s, sel.id);
  if (!bot) {
    s.branchPrompts.push({ id: `bp-${Date.now().toString(36)}`, edgeId: edgeId!, text: text.trim(), kind: 'einmalig', via, createdAt: new Date().toISOString(), botNodeId: null, taskId: null });
    note(tr('Notiert. Auf dieser Branch ist noch kein Bot – Knoten anklicken und „Bot“ einschalten.', 'Noted. There is no bot on this branch yet – click the node and switch on "Bot".'));
    return commit();
  }
  if (store.backend !== 'datei') { note(tr('Bots brauchen die lokale App-API (npm run dev).', 'Bots need the local app API (npm run dev).')); return; }
  await store.saveNow();
  let r: Response;
  try { r = await fetch('/api/bot/run', { method: 'POST', body: JSON.stringify({ nodeId: bot, text: text.trim(), edgeId, via, about }) }); }
  catch { setOffline(true); note(tr('Nicht gesendet: keine Verbindung zum App-Server. Mind auf dem Desktop starten.', 'Not sent: no connection to the app server. Start Mind on the desktop.')); return; }
  if (!r.ok) { note(tr(`Bot-Start fehlgeschlagen: ${await r.text()}`, `Bot start failed: ${await r.text()}`)); return; }
  const run = await r.json();
  if (via === 'stimme') voiceThreads.add(run.threadId);
  liveRuns.push(run);
  await refresh(true);
}

/** Fetches the new state when bots changed it, and reads out answers to spoken questions. */
let lastSig = '';
const runSig = () => liveRuns.map((r) => r.id + r.status + (r.steps?.length ?? 0)).join() + chatPend.map((c) => c.key).join();

function setOffline(off: boolean) {
  document.body.classList.toggle('offline', off);
  $('conn').hidden = !off;
}

// ───────── Cockpit (the owner's centre): blockers, On-OK list, autorun ─────────
let autoSt: { on: boolean; since: string | null; oks: number; idleHours: number; stopReason: string | null; queued: number; waiting?: string[] } | null = null;
const askOpen = new Set<string>();
const blkEdit = new Set<string>(); // blockers currently being edited in the cockpit
const ansOpen = new Set<string>();
const ckThread = (id: string) => `ck-${id}`;
const firstBit = (t: string, n = 150) => { const x = t.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
async function postJ(url: string, b: unknown, method = 'POST') { return (await fetch(url, { method, body: JSON.stringify(b) })).json(); }
function updateAutoChip() {
  let c = document.getElementById('auto-chip');
  if (!autoSt?.on) { c?.remove(); return; }
  if (!c) { const ca = document.createElement('a'); ca.href = '#'; c = ca; c.id = 'auto-chip'; c.addEventListener('click', (ev) => { ev.preventDefault(); doAct('auto', root(S())); }); $('hud').prepend(c); }
  c.textContent = `● AUTO · ${autoSt.oks} OKs`;
  c.title = tr(`Autorun läuft seit ${autoSt.since?.slice(11, 16)} – klicken zum Stoppen${autoSt.idleHours ? ` · stoppt nach ${autoSt.idleHours} h ohne Aktivität` : ' · unbegrenzt'}`, `Autorun running since ${autoSt.since?.slice(11, 16)} – click to stop${autoSt.idleHours ? ` · stops after ${autoSt.idleHours} h without activity` : ' · unlimited'}`);
}
async function doAct(a: string, id: string) {
  const s = S();
  const title = nodeById(s, id)?.title ?? id;
  const isRootAct = id === root(s);
  if (a === 'cockpit') { openCockpit(); return; }
  if (a === 'addchild') { childInput = true; collapsed.delete(id); sel = { kind: 'node', id }; renderPop(); setTimeout(() => (document.getElementById('child-title') as HTMLInputElement | null)?.focus(), 30); return; }
  if (a === 'remove') {
    const k = descendants(s, id).length;
    if (!confirm(tr(`„${title}“${k ? ` mit ${k} Unterknoten` : ''} entfernen?\n\nDer Ast kommt in den Papierkorb (Regeln → Papierkorb) und lässt sich dort wiederherstellen.`, `Remove "${title}"${k ? ` with ${k} sub-nodes` : ''}?\n\nThe branch goes to the trash (Rules → Trash) and can be restored there.`))) return;
    if (removeBranch(s, id, OWNER_ID)) { sel = null; commit(); note(tr(`„${title}“ entfernt – wiederherstellbar unter Regeln → Papierkorb.`, `"${title}" removed – restorable under Rules → Trash.`)); }
    return;
  }
  if (a === 'blockers') { openCockpit(); await postJ('/api/blockers/refresh', { nodeId: root(s) }); note(tr('Blocker werden eingeholt – alle Bots prüfen kurz, ob sie dich brauchen.', 'Collecting blockers – all bots briefly check whether they need you.')); return; }
  if (a === 'auto') {
    if (autoSt?.on) { autoSt = await postJ('/api/auto', { on: false }, 'PUT'); note(tr(`Autorun gestoppt – ${autoSt?.oks ?? 0} OKs gegeben.`, `Autorun stopped – ${autoSt?.oks ?? 0} OKs given.`)); }
    else {
      const h = autoSt?.idleHours ?? 3;
      if (!confirm(tr(`Autorun starten?\n\nAlle Bots bekommen laufend OK und arbeiten ihr „Bei OK“ ab, bis du stoppst${h ? ` – oder automatisch nach ${h} h ohne Aktivität am Rechner` : ' (unbegrenzt!)'}.\nKostet Kontingent deiner Abos.`, `Start autorun?\n\nAll bots keep receiving OK and work through their "On OK" until you stop${h ? ` – or automatically after ${h} h without activity on the computer` : ' (unlimited!)'}.\nUses quota of your subscriptions.`))) return;
      autoSt = await postJ('/api/auto', { on: true, nodeId: root(s) }, 'PUT'); note(tr('Autorun läuft.', 'Autorun is running.'));
    }
    updateAutoChip(); render(); if (!$('cockpit').hidden) renderCockpit(); return;
  }
  const scope = a === 'sweep' ? 'zone' : a === 'zone' ? 'zone' : a === 'next' ? 'next' : 'self';
  if (scope === 'zone' && !confirm(tr(`${isRootAct ? 'Sweep über die ganze Karte' : `OK-Kaskade für „${title}“`}: alle Bots darin führen ihr „Bei OK“ aus (max. 3 gleichzeitig). Los?`, `${isRootAct ? 'Sweep over the whole map' : `OK cascade for "${title}"`}: all bots in it run their "On OK" (max. 3 at a time). Go?`))) return;
  await store.saveNow();
  const r = await postJ('/api/ok', { nodeId: id, scope });
  note(r.started.length ? tr(`OK an ${r.started.length} Bot${r.started.length > 1 ? 's' : ''}: ${r.started.map((x: string) => nodeById(S(), x)?.title).join(', ')}${r.skipped.length ? ` · ${r.skipped.length} ohne „Bei OK“ oder beschäftigt` : ''}`, `OK given to ${r.started.length} bot${r.started.length > 1 ? 's' : ''}: ${r.started.map((x: string) => nodeById(S(), x)?.title).join(', ')}${r.skipped.length ? ` · ${r.skipped.length} without "On OK" or busy` : ''}`) : tr('Kein Bot mit „Bei OK“ frei.', 'No bot with "On OK" available.'));
  refresh(true);
}
let ownerChat = false;
function openCockpit() { renderCockpit(); $('cockpit').hidden = false; }
let cockpitSig = '';
function renderCockpit() {
  const s = S();
  const r = root(s);
  const path = (id: string) => ancestors(s, id).filter((x) => x !== r).map((x) => nodeById(s, x)?.title).join(' › ');
  const blockers = s.nodes.filter((n) => n.blocker).sort((a, b) => a.blocker!.at.localeCompare(b.blocker!.at));
  const oks = s.nodes.filter((n) => n.isBot && n.okNext && n.id !== r);
  const running = liveRuns.filter((x) => x.status === 'läuft');
  const msgsOf = (id: string) => s.botMessages.filter((m) => m.threadId === ckThread(id));
  const lastOkAns = (id: string) => { const q = [...s.botMessages].reverse().find((m) => m.from === OWNER_ID && m.to === id && m.text === 'OK'); return q ? s.botMessages.find((m) => m.runId === q.runId && m.from === id && m.kind !== 'frage') ?? null : null; };
  const sig = JSON.stringify([blockers.map((b) => [b.id, b.blocker]), oks.map((b) => [b.id, b.okNext?.text, lastOkAns(b.id)?.id, msgsOf(b.id).length]), running.map((x) => x.id), autoSt, [...askOpen], [...ansOpen], [...blkEdit], (() => { try { return localStorage.getItem('mind-ck-rest'); } catch { return ''; } })()]);
  if (sig === cockpitSig && $('cockpit').innerHTML) return;
  cockpitSig = sig;
  const keep = new Map<string, string>(); $('cockpit').querySelectorAll<HTMLInputElement>('input[id]').forEach((i) => keep.set(i.id, i.value));
  const foc = (document.activeElement as HTMLElement | null)?.id ?? '';
  const waitingB = (id: string) => !!autoSt?.waiting?.includes(id);
  const busy = (id: string) => waitingB(id) || running.some((x) => x.nodeId === id);
  // Management = all nodes directly under the owner (vice bosses), bot or not
  const tops = children(s, r).map((id) => nodeById(s, id)!).filter(Boolean);
  const isMgmt = (id: string) => tops.some((t) => t.id === id);
  const mgmt = tops;
  const rest = oks.filter((n) => !isMgmt(n.id));
  const restOpen = (() => { try { return localStorage.getItem('mind-ck-rest') === '1'; } catch { return false; } })();
  const miniChat = (id: string, title: string) => `<div class="mini-chat">${msgsOf(id).slice(-4).map((m) => `<div class="${m.from === OWNER_ID ? 'me' : 'bot'}">${m.from === OWNER_ID ? '' : '↳ '}${esc(m.from === OWNER_ID ? m.text : firstBit(m.text, 400))}</div>`).join('')}${running.some((x) => x.nodeId === id && x.threadId === ckThread(id)) ? `<div class="bot mutd">${tr('denkt …', 'thinking …')}</div>` : ''}<div class="mrow"><input id="ck-${esc(id)}" data-ask="${esc(id)}" placeholder="${tr(`Kurze Rückfrage an ${esc(title)} …`, `Short follow-up to ${esc(title)} …`)}" autocomplete="off"><span data-c="asksend" data-id="${esc(id)}" title="${tr('Senden (Enter)', 'Send (Enter)')}">↑</span></div></div>`;
  const blkRow = (n: (typeof blockers)[number]) => {
    const ed = blkEdit.has(n.id); const isBot = !!n.isBot;
    return `<div class="citem blk"><div class="okrow"><span data-c="go" data-id="${esc(n.id)}" title="${tr('Zum Knoten springen', 'Jump to node')}"><b>${esc(n.title)}</b> <i>${esc(path(n.id))}</i></span><span class="sp"></span><span class="age">${esc(n.blocker!.at.slice(5, 16).replace('T', ' '))}</span>
      <span class="ib${ed ? ' on' : ''}" data-c="blkedit" data-id="${esc(n.id)}" title="${tr('Blocker-Text bearbeiten', 'Edit blocker text')}">✎</span>${isBot ? `<span class="ib${askOpen.has(n.id) ? ' on' : ''}" data-c="ask" data-id="${esc(n.id)}" title="${tr('Rückfrage an den Bot zu diesem Blocker', 'Ask the bot a follow-up about this blocker')}">💬</span>` : ''}<span class="ib" data-c="go" data-id="${esc(n.id)}" title="${tr('Zum Knoten springen', 'Jump to node')}">↗</span>${isBot ? `<span class="okbtn${busy(n.id) ? ' off' : ''}" data-c="blkdone" data-id="${esc(n.id)}" title="${tr('Erledigt – Blocker schließen und der Bot macht weiter', 'Done – close the blocker and the bot carries on')}">${busy(n.id) ? '…' : tr('✓ Erledigt', '✓ Done')}</span>` : ''}<span class="ib" data-c="blkdrop" data-id="${esc(n.id)}" title="${tr('Blocker schließen, ohne dem Bot etwas zu sagen', 'Close the blocker without telling the bot')}">✕</span></div>
      ${ed ? `<div class="mrow"><input id="blk-${esc(n.id)}" data-blk="${esc(n.id)}" value="${esc(n.blocker!.text)}" autocomplete="off"><span data-c="blksave" data-id="${esc(n.id)}" title="${tr('Speichern (Enter)', 'Save (Enter)')}">✓</span></div>` : `<div class="btxt" data-c="blkedit" data-id="${esc(n.id)}" title="${tr('Klicken zum Bearbeiten', 'Click to edit')}">${esc(n.blocker!.text)}</div>`}
      ${askOpen.has(n.id) ? miniChat(n.id, n.title) : ''}</div>`;
  };
  const okRow = (n: (typeof oks)[number]) => {
        const st = running.some((x) => x.nodeId === n.id) ? `<i class="spinner"></i>${tr('arbeitet', 'working')}` : waitingB(n.id) ? tr('wartet', 'waiting') : '';
        const ans = lastOkAns(n.id);
        const thr = msgsOf(n.id).slice(-4);
        return `<div class="citem"><div class="okrow"><span data-c="go" data-id="${esc(n.id)}"><b>${esc(n.title)}</b></span><span class="t">${esc(n.okNext!.text)}</span>${st ? `<span class="st">${st}</span>` : ''}<span class="ib${askOpen.has(n.id) ? ' on' : ''}" data-c="ask" data-id="${esc(n.id)}" title="${tr('Kurze Rückfrage zu diesem OK', 'Short follow-up about this OK')}">💬</span><span class="ib" data-c="go" data-id="${esc(n.id)}" title="${tr('Zum Bot springen – sehen, was er gerade macht', 'Jump to the bot – see what it is doing right now')}">↗</span><span class="okbtn${busy(n.id) ? ' off' : ''}" data-c="ok" data-id="${esc(n.id)}">${busy(n.id) ? '…' : 'OK'}</span>${askOpen.has(n.id) || ansOpen.has(n.id) ? `<span class="ib fold-row" data-c="fold" data-id="${esc(n.id)}" title="${tr('Einklappen (Kleinansicht)', 'Collapse (compact view)')}">▴</span>` : ''}</div>
          ${ans && !st ? `<div class="ans${ansOpen.has(n.id) ? ' open' : ''}" data-c="ans" data-id="${esc(n.id)}" title="${esc(ans.at.slice(11, 16))} – ${tr('klicken zum', 'click to')} ${ansOpen.has(n.id) ? tr('Einklappen', 'collapse') : tr('Aufklappen', 'expand')}">↳ ${esc(ansOpen.has(n.id) ? ans.text.replace(/\*\*/g, '') : firstBit(ans.text))}</div>` : ''}
          ${askOpen.has(n.id) ? miniChat(n.id, n.title) : ''}</div>`;
  };
  const ckBig = (() => { try { return localStorage.getItem('mind-ck-big') === '1'; } catch { return false; } })();
  const ckSize = (() => { try { const v = JSON.parse(localStorage.getItem('mind-ck-size') ?? 'null') as { w: number; h: number } | null; return v && v.w >= 300 && v.h >= 200 ? v : null; } catch { return null; } })();
  $('cockpit').innerHTML = `<div class="cwrap${ckBig ? ' big' : ckSize ? ' sized' : ''}" style="${!ckBig && ckSize ? `width:${ckSize.w}px;height:${ckSize.h}px` : ''}">
    <div class="rtop"><h2>Cockpit</h2><span class="sp"></span>${ckSize && !ckBig ? `<span class="ic sm" data-c="resetsize" title="${tr('Größe zurücksetzen', 'Reset size')}">↺</span>` : ''}<span class="ic" data-c="big" title="${ckBig ? tr('Verkleinern', 'Make smaller') : tr('Groß ansehen', 'View large')}">${ckBig ? '⤡' : '⤢'}</span><span class="cbtn sm" data-c="mchat" title="${tr(`Chat mit deinem ${OWNER()}-Bot öffnen`, `Open chat with your ${OWNER()} bot`)}">Chat</span><span class="ic" data-c="close" title="${tr('Schließen (Esc)', 'Close (Esc)')}">×</span></div>
    <div class="csec"><div class="clabel">${tr('Wo du gebraucht wirst', 'Where you are needed')} <b>${blockers.length}</b><span class="sp"></span><span class="cbtn" data-c="refresh-blockers" title="${tr('Alle Bots kurz fragen, ob sie dich brauchen', 'Briefly ask all bots whether they need you')}">${tr('Neu einholen', 'Collect again')}</span></div>
      ${blockers.length ? blockers.map(blkRow).join('') : `<div class="mut">${tr('Nichts blockiert – kein Bot braucht dich gerade.', 'Nothing blocked – no bot needs you right now.')}</div>`}</div>
    <div class="csec"><div class="clabel">${tr('Bei OK', 'On OK')} <b>${oks.length}</b><span class="sp"></span>${askOpen.size || ansOpen.size ? `<span class="cbtn" data-c="foldall" title="${tr('Alle Zeilen zurück in die Kleinansicht', 'All rows back to the compact view')}">${tr('Alle einklappen', 'Collapse all')}</span>` : ''}<span class="cbtn" data-c="fill" title="${tr('Bots ohne „Bei OK“ legen ihren nächsten Schritt fest (kurzer Lauf)', 'Bots without "On OK" decide their next step (short run)')}">${tr('Auffüllen', 'Fill up')}</span></div>
      <div class="oklist-scroll">${!tops.length ? '' : `
        <div class="cgroup"><span class="gname">Management</span><i>${mgmt.length} · ${tr('direkt unter dir', 'directly under you')}</i><span class="cbtn sm" data-c="addtop" title="${tr('Neuen Hauptast direkt unter dir anlegen', 'Create a new main branch directly under you')}">${tr('+ Knoten', '+ Node')}</span><span class="sp"></span>${mgmt.some((n) => n.isBot && n.okNext && !busy(n.id)) ? `<span class="cbtn dark sm" data-c="okgroup" data-g="m" title="${tr('Alle Vize-Bosse führen ihr „Bei OK“ aus', 'All vice bosses run their "On OK"')}">${tr('▶ Alle OK', '▶ All OK')}</span>` : ''}</div>
        ${mgmt.map((n) => n.isBot && n.okNext ? okRow(n as (typeof oks)[number]) : `<div class="citem idle"><div class="okrow"><span data-c="go" data-id="${esc(n.id)}"><b>${esc(n.title)}</b></span><span class="t mutd">${n.isBot ? (busy(n.id) ? '' : tr('noch kein „Bei OK“', 'no "On OK" yet')) : tr('kein Bot', 'no bot')}</span>${busy(n.id) ? `<span class="st"><i class="spinner"></i>${tr('arbeitet', 'working')}</span>` : ''}${n.isBot ? '' : `<span class="cbtn sm" data-c="mkbot" data-id="${esc(n.id)}" title="${tr('Agent für diesen Bereich anlegen (Sonnet, über dein Abo)', 'Create an agent for this area (Sonnet, via your subscription)')}">+ Agent</span>`}<span class="ib" data-c="go" data-id="${esc(n.id)}" title="${tr('Zum Knoten springen', 'Jump to node')}">↗</span></div></div>`).join('')}
        ${rest.length ? `<div class="cgroup rest" data-c="toggle-rest" title="${restOpen ? tr('Einklappen', 'Collapse') : tr('Aufklappen', 'Expand')}"><span class="gname">${restOpen ? '▾' : '▸'} ${tr('Weitere Bots', 'More bots')}</span><i>${rest.length}${rest.some((n) => busy(n.id)) ? ` · ${rest.filter((n) => busy(n.id)).length} ${tr('arbeiten', 'working')}` : ''}</i><span class="sp"></span>${restOpen && rest.some((n) => !busy(n.id)) ? `<span class="cbtn sm" data-c="okgroup" data-g="r" title="${tr('Alle weiteren Bots führen ihr „Bei OK“ aus', 'All further bots run their "On OK"')}">${tr('▶ Alle OK', '▶ All OK')}</span>` : ''}</div>
        ${restOpen ? rest.map(okRow).join('') : ''}` : ''}`}</div></div>
    <div class="csec"><div class="clabel">Autorun<span class="sp"></span>
      <select id="c-idle" title="${tr('Stoppt, wenn du so lange nicht am Rechner aktiv warst', 'Stops when you have not been active on the computer for this long')}">${[[1, '1 h'], [3, '3 h'], [8, '8 h'], [24, '24 h'], [0, tr('unbegrenzt', 'unlimited')]].map(([v, l]) => `<option value="${v}" ${autoSt?.idleHours === v ? 'selected' : ''}>${tr('stoppt nach', 'stops after')} ${l}${v ? tr(' ohne Aktivität', ' without activity') : ''}</option>`).join('')}</select>
      <span class="cbtn ${autoSt?.on ? 'hot' : 'dark'}" data-c="auto">${autoSt?.on ? tr('■ Stoppen', '■ Stop') : tr('∞ Starten', '∞ Start')}</span></div>
      <div class="mut">${autoSt?.on ? tr(`Läuft seit ${esc(autoSt.since?.slice(11, 16))} · ${autoSt.oks} OKs gegeben`, `Running since ${esc(autoSt.since?.slice(11, 16))} · ${autoSt.oks} OKs given`) : autoSt?.stopReason ? `${tr('Zuletzt', 'Last')}: ${esc(autoSt.stopReason)}` : tr('Aus. Gibt allen Bots laufend OK, bis du stoppst.', 'Off. Keeps giving all bots OK until you stop.')} · ${tr(`gerade ${running.length} Läufe${autoSt?.queued ? `, ${autoSt.queued} in der Warteschlange` : ''}`, `${running.length} runs right now${autoSt?.queued ? `, ${autoSt.queued} queued` : ''}`)}</div></div>
  </div>`;
  const cw = $('cockpit').querySelector('.cwrap') as HTMLElement;
  let firstObs = true;
  new ResizeObserver(() => {
    if (firstObs) { firstObs = false; return; }
    if ($('cockpit').hidden || cw.offsetWidth < 300 || cw.classList.contains('big') || !cw.style.width) return;
    try { localStorage.setItem('mind-ck-size', JSON.stringify({ w: Math.round(cw.offsetWidth), h: Math.round(cw.offsetHeight) })); } catch { /* */ }
    cw.classList.add('sized');
  }).observe(cw);
  for (const [k, v] of keep) { const el = document.getElementById(k) as HTMLInputElement | null; if (el) el.value = v; }
  if (foc) (document.getElementById(foc) as HTMLInputElement | null)?.focus();
}
// only close if the click also started on the backdrop (not while drag-resizing)
let ckDownBackdrop = false;
$('cockpit').addEventListener('pointerdown', (ev) => { ckDownBackdrop = ev.target === $('cockpit'); });
$('cockpit').addEventListener('click', async (ev) => {
  const t = (ev.target as HTMLElement).closest('[data-c]') as HTMLElement | null;
  if (!t) { if (ev.target === $('cockpit') && ckDownBackdrop) $('cockpit').hidden = true; return; }
  const id = t.dataset.id ?? '';
  switch (t.dataset.c) {
    case 'close': $('cockpit').hidden = true; break;
    case 'mchat': $('cockpit').hidden = true; ownerChat = true; sel = { kind: 'node', id: root(S()) }; draw(); break;
    case 'big': { const b = !t.closest('.cwrap')!.classList.contains('big'); try { localStorage.setItem('mind-ck-big', b ? '1' : '0'); } catch { /* */ } cockpitSig = ''; renderCockpit(); break; }
    case 'resetsize': try { localStorage.removeItem('mind-ck-size'); } catch { /* */ } cockpitSig = ''; renderCockpit(); break;
    case 'go': $('cockpit').hidden = true; sel = { kind: 'node', id }; if (mode !== 'ltr' && planeOf(S(), id) !== plane && id !== root(S())) { plane = Math.max(0, planeOf(S(), id)); } draw(); break;
    case 'ok': if (!t.classList.contains('off')) { const r = await postJ('/api/ok', { nodeId: id, scope: 'self' }); note(r.started.length ? tr(`${nodeById(S(), id)?.title}: OK gegeben – arbeitet.`, `${nodeById(S(), id)?.title}: OK given – working.`) : tr(`${nodeById(S(), id)?.title} arbeitet schon oder wartet.`, `${nodeById(S(), id)?.title} is already working or waiting.`)); await refresh(true); cockpitSig = ''; renderCockpit(); } break;
    case 'ask': if (askOpen.has(id)) askOpen.delete(id); else askOpen.add(id); cockpitSig = ''; renderCockpit(); (document.getElementById(`ck-${id}`) as HTMLInputElement | null)?.focus(); break;
    case 'ans': if (ansOpen.has(id)) ansOpen.delete(id); else ansOpen.add(id); cockpitSig = ''; renderCockpit(); break;
    case 'asksend': ckSend(id); break;
    case 'blkedit': if (blkEdit.has(id) && t.classList.contains('ib')) blkEdit.delete(id); else blkEdit.add(id); cockpitSig = ''; renderCockpit(); { const i = document.getElementById(`blk-${id}`) as HTMLInputElement | null; i?.focus(); i?.select(); } break;
    case 'blksave': blkSave(id); break;
    case 'blkdrop': { const n = nodeById(S(), id); if (!n?.blocker) break; delete n.blocker; touch(S(), id, 'bot', `${OWNER_ID}: ${tr('Blocker geschlossen (Cockpit).', 'Blocker closed (cockpit).')}`); blkEdit.delete(id); askOpen.delete(id); await store.saveNow(); note(tr(`${n.title}: Blocker geschlossen.`, `${n.title}: blocker closed.`)); cockpitSig = ''; renderCockpit(); draw(); break; }
    case 'blkdone': {
      if (t.classList.contains('off')) break;
      const n = nodeById(S(), id); if (!n?.blocker) break;
      const txt = n.blocker.text; delete n.blocker; touch(S(), id, 'bot', `${OWNER_ID}: ${tr('Blocker erledigt', 'Blocker done')} – ${txt}`); blkEdit.delete(id);
      await store.saveNow();
      const r = await fetch('/api/bot/run', { method: 'POST', body: JSON.stringify({ nodeId: id, text: tr(`Erledigt von ${OWNER()}: „${txt}“. Der Blocker ist geschlossen – mach damit weiter.`, `Done by ${OWNER()}: "${txt}". The blocker is closed – carry on with it.`), threadId: ckThread(id), via: 'text' }) }).catch(() => null);
      note(r?.ok ? tr(`${n.title}: Blocker erledigt – Bot macht weiter.`, `${n.title}: blocker done – bot carries on.`) : tr(`${n.title}: Blocker geschlossen, Bot konnte nicht gestartet werden.`, `${n.title}: blocker closed, bot could not be started.`));
      await refresh(true); cockpitSig = ''; renderCockpit(); draw(); break;
    }
    case 'fold': askOpen.delete(id); ansOpen.delete(id); cockpitSig = ''; renderCockpit(); break;
    case 'foldall': askOpen.clear(); ansOpen.clear(); cockpitSig = ''; renderCockpit(); break;
    case 'sweep': doAct('sweep', root(S())); break;
    case 'addtop': { const tl = prompt(tr('Name des neuen Hauptasts (direkt unter dir):', 'Name of the new main branch (directly under you):'))?.trim(); if (!tl) break; const n = addChild(S(), root(S()), tl); if (plane) n.plane = plane; await store.saveNow(); draw(); cockpitSig = ''; renderCockpit(); note(tr(`„${tl}“ angelegt.`, `"${tl}" created.`)); break; }
    case 'mkbot': { const n = nodeById(S(), id); if (!n || n.isBot) break; n.isBot = true; touch(S(), id, 'bot', tr('Agent angelegt (Cockpit).', 'Agent created (cockpit).')); await store.saveNow(); note(tr(`${n.title} ist jetzt ein Bot – „Auffüllen“ lässt ihn sein „Bei OK“ festlegen.`, `${n.title} is now a bot – "Fill up" lets it set its "On OK".`)); draw(); cockpitSig = ''; renderCockpit(); break; }
    case 'toggle-rest': if ((ev.target as HTMLElement).closest('[data-c=okgroup]')) break; try { localStorage.setItem('mind-ck-rest', localStorage.getItem('mind-ck-rest') === '1' ? '0' : '1'); } catch { /* */ } cockpitSig = ''; renderCockpit(); break;
    case 'okgroup': {
      const st = S(); const r0 = root(st);
      const topIds = new Set(children(st, r0));
      const ids = st.nodes.filter((n) => n.isBot && n.okNext && n.id !== r0 && (t.dataset.g === 'm') === topIds.has(n.id)).map((n) => n.id);
      if (!confirm(tr(`${t.dataset.g === 'm' ? 'Management' : 'Weitere Bots'}: ${ids.length} Bots führen ihr „Bei OK“ aus. Los?`, `${t.dataset.g === 'm' ? 'Management' : 'More bots'}: ${ids.length} bots run their "On OK". Go?`))) break;
      let n0 = 0; for (const id of ids) { const r = await postJ('/api/ok', { nodeId: id, scope: 'self' }); n0 += r.started.length; }
      note(tr(`OK an ${n0} Bots gegeben.`, `OK given to ${n0} bots.`)); await refresh(true); cockpitSig = ''; renderCockpit(); break;
    }
    case 'fill': { const r = await postJ('/api/ok-fill', { nodeId: root(S()) }); note(r.started.length ? tr(`${r.started.length} Bots legen ihr „Bei OK“ fest: ${r.started.map((x: string) => nodeById(S(), x)?.title).join(', ')}`, `${r.started.length} bots are setting their "On OK": ${r.started.map((x: string) => nodeById(S(), x)?.title).join(', ')}`) : tr('Alle Bots haben schon ein „Bei OK“ (oder arbeiten gerade).', 'All bots already have an "On OK" (or are working right now).')); refresh(true); break; }
    case 'refresh-blockers': doAct('blockers', root(S())); break;
    case 'auto': doAct('auto', root(S())); break;
  }
});
async function blkSave(id: string) {
  const inp = document.getElementById(`blk-${id}`) as HTMLInputElement | null;
  const n = nodeById(S(), id); const v = inp?.value.trim();
  if (!n?.blocker || !v) return;
  if (v !== n.blocker.text) { n.blocker = { ...n.blocker, text: v.slice(0, 600) }; touch(S(), id, 'bot', `${OWNER_ID}: ${tr('Blocker geändert', 'Blocker changed')} – ${v}`); await store.saveNow(); }
  blkEdit.delete(id); cockpitSig = ''; renderCockpit(); draw();
}
async function ckSend(id: string) {
  const inp = document.getElementById(`ck-${id}`) as HTMLInputElement | null;
  const q = inp?.value.trim();
  if (!inp || !q) return;
  inp.value = '';
  await store.saveNow();
  const r = await fetch('/api/bot/run', { method: 'POST', body: JSON.stringify({ nodeId: id, text: q, threadId: ckThread(id), via: 'text', brief: true }) }).catch(() => null);
  if (!r?.ok) { note(tr('Rückfrage konnte nicht gesendet werden.', 'Follow-up could not be sent.')); return; }
  await refresh(true); cockpitSig = ''; renderCockpit();
}
$('cockpit').addEventListener('keydown', (ev) => { const t = ev.target as HTMLInputElement; if (ev.key === 'Enter' && t.dataset.ask) { ev.preventDefault(); ckSend(t.dataset.ask); } if (ev.key === 'Enter' && t.dataset.blk) { ev.preventDefault(); blkSave(t.dataset.blk); } if (ev.key === 'Escape' && t.dataset.blk) { blkEdit.delete(t.dataset.blk); cockpitSig = ''; renderCockpit(); } if (ev.key === 'Escape') ev.stopPropagation(); });
$('cockpit').addEventListener('change', async (ev) => {
  const t = ev.target as HTMLSelectElement;
  if (t.id === 'c-idle') { autoSt = await postJ('/api/auto', { on: !!autoSt?.on, idleHours: Number(t.value) }, 'PUT'); cockpitSig = ''; renderCockpit(); }
});
$('reader').addEventListener('click', async (ev) => {
  const t = (ev.target as HTMLElement).closest('[data-rd]') as HTMLElement | null;
  if (!t) { if (ev.target === $('reader')) $('reader').hidden = true; return; }
  if (t.dataset.rd === 'close') $('reader').hidden = true;
  if (t.dataset.rd === 'copy') copy(($('reader') as unknown as { _txt: string })._txt, tr('Text kopiert.', 'Text copied.'));
});
// report activity (for the autorun stop when away)
let lastPing = 0;
for (const evn of ['pointermove', 'keydown', 'wheel']) addEventListener(evn, () => { if (Date.now() - lastPing > 60_000) { lastPing = Date.now(); fetch('/api/active', { method: 'POST' }).catch(() => {}); } }, { passive: true });

/** Apply language and owner name from the loaded state and refresh the static UI texts (called after every load). */
function applyLang() {
  const s = S();
  setLang(s.lang);
  setOwner(nodeById(s, root(s))?.title);
  document.documentElement.lang = getLang();
  const rb = document.getElementById('rules-btn');
  if (rb) { rb.textContent = tr('Regeln', 'Rules'); rb.title = tr('Aktualisieren-Prompt und Arbeitsanweisungen aller Bots', 'Update prompt and work instructions of all bots'); }
  const d3 = document.querySelector('#hud a[href="/3d.html"]') as HTMLElement | null;
  if (d3) d3.title = tr('Bisherige 3D-Ansicht mit allen Details', 'Previous 3D view with all details');
  const ro = document.getElementById('rotor');
  if (ro) ro.title = tr('Kreis drehen: Regler ziehen oder darüber scrollen · Doppelklick = zurück · auf der Karte: ⌥ + Ziehen', 'Rotate circle: drag the slider or scroll over it · double-click = reset · on the map: ⌥ + drag');
  const cn = document.getElementById('conn');
  if (cn) cn.innerHTML = tr('Keine Verbindung zum App-Server – bitte <b>Mind</b> auf dem Desktop starten. Eingaben werden danach nachgereicht.', 'No connection to the app server – please start <b>Mind</b> on the desktop. Input will be sent afterwards.');
}

async function refresh(force = false) {
  if (store.backend !== 'datei') return;
  try {
    const h = await fetch('/api/health').catch(() => null);
    if (!h || !h.ok) { setOffline(true); return; }
    if (!$('conn').hidden) { setOffline(false); if (store.dirty) await store.saveNow(); force = true; note(tr('Wieder verbunden.', 'Reconnected.')); }
    const prevBusy = liveRuns.filter((x) => x.status === 'läuft').map((x) => x.nodeId).sort().join();
    liveRuns = await (await fetch('/api/bot/runs')).json();
    if (liveRuns.filter((x) => x.status === 'läuft').map((x) => x.nodeId).sort().join() !== prevBusy) render();
    chatPend = await (await fetch('/api/chat/pending')).json();
    const prevAuto = JSON.stringify(autoSt);
    autoSt = await (await fetch('/api/auto')).json().catch(() => null);
    if (JSON.stringify(autoSt) !== prevAuto) { updateAutoChip(); if (sel?.kind === 'node' && sel.id === root(S())) render(); }
    if (!$('cockpit').hidden) renderCockpit();
    if (sel?.kind === 'node' && !$('pop').hidden) loadNodeFiles(sel.id);
    const { revision } = await (await fetch('/api/rev')).json();
    if ((force || revision > S().revision || store.conflict) && !store.dirty) {
      await store.reload();
      applyLang();
      draw();
      for (const m of S().botMessages) {
        if (m.kind !== 'frage' && m.to === OWNER_ID && !spokenMsgs.has(m.id) && (tts?.readAloud === 'immer' || (tts?.readAloud === 'stimme' && voiceThreads.has(m.threadId)))) {
          spokenMsgs.add(m.id);
          speak(m.text);
        }
      }
    } else if (!$('pop').hidden && runSig() !== lastSig) renderPop();
    lastSig = runSig();
  } catch { /* server restarted */ }
}

const VOICE_KEY = 'quant-map-voice';
function germanVoices() {
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(getLang()));
}
/** Best available voice for the UI language: saved choice, else Premium/Enhanced/Siri, then Google, then the rest. */
function pickVoice(): SpeechSynthesisVoice | null {
  const vs = germanVoices();
  let saved: string | null = null;
  try { saved = localStorage.getItem(VOICE_KEY); } catch { /* */ }
  const chosen = saved ? vs.find((v) => v.name === saved) : null;
  if (chosen) return chosen;
  const rank = (v: SpeechSynthesisVoice) => (/premium|enhanced|neural|siri|erweitert/i.test(v.name) ? 3 : /google/i.test(v.name) ? 2 : /anna|petra|helena|markus|yannick/i.test(v.name) ? 1 : 0);
  return vs.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

let ttsAudio: HTMLAudioElement | null = null;
function speakSystem(text: string) {
  try {
    const u = new SpeechSynthesisUtterance(text.replace(/[*`#_]/g, '').slice(0, 900));
    u.lang = LOC();
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.03;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* no speech output */ }
}

/** Read aloud: AI voice via the local server (OpenAI/ElevenLabs), else system voice. */
async function speak(text: string) {
  try {
    const r = await fetch('/api/tts', { method: 'POST', body: JSON.stringify({ text }) });
    if (r.status === 200) {
      ttsAudio?.pause();
      ttsAudio = new Audio(URL.createObjectURL(await r.blob()));
      await ttsAudio.play();
      return;
    }
    if (r.status === 502) note(tr(`KI-Stimme nicht verfügbar: ${(await r.json()).error} – Systemstimme.`, `AI voice not available: ${(await r.json()).error} – system voice.`));
  } catch { /* offline → system voice */ }
  speakSystem(text);
}

// ───────── Rules: update prompt and work instructions in one place ─────────

function botTree(): { id: string; depth: number }[] {
  const s = S();
  const out: { id: string; depth: number }[] = [];
  const walk = (id: string, d: number) => {
    const n = nodeById(s, id)!;
    const nd = n.isBot ? d + 1 : d;
    if (n.isBot) out.push({ id, depth: d });
    children(s, id).forEach((c) => walk(c, nd));
  };
  walk(root(s), 0);
  return out;
}

let conn: { enabled: boolean; running: boolean; url: string; error: string; mcpUrl: string; fixed?: boolean; fixedHost?: string; lastOk?: string; fails?: number; urlChangedAt?: string } | null = null;

function connHtml() {
  if (!conn) return `<div class="mut">${tr('Connector wird geladen …', 'Loading connector …')}</div>`;
  const on = conn.enabled;
  return `<div class="rlabel">${tr('Connector für ChatGPT &amp; Claude online', 'Connector for ChatGPT &amp; Claude online')} <span>${tr('– sie lesen und schreiben direkt in Mind', '– they read and write directly in Mind')}</span></div>
    <div class="seg rseg"><span class="${on ? '' : 'on'}" data-r="conn" data-id="off">${tr('Aus', 'Off')}</span><span class="${on ? 'on' : ''}" data-r="conn" data-id="on">${tr('An (Tunnel)', 'On (tunnel)')}</span></div>
    ${on ? (conn.mcpUrl ? `<div class="rrow"><input id="r-mcp" readonly value="${esc(conn.mcpUrl)}"><b class="lnk" data-r="conn-copy">${tr('Kopieren', 'Copy')}</b></div>
      <div class="mut"><b>ChatGPT:</b> ${tr('Einstellungen → Apps &amp; Connectors → Erweitert → Entwicklermodus an → „Connector erstellen“ → diese URL, Authentifizierung „Keine“.', 'Settings → Apps &amp; Connectors → Advanced → turn on Developer mode → "Create connector" → this URL, authentication "None".')}<br>
      <b>Claude:</b> ${tr('Einstellungen → Connectors → „Benutzerdefinierten Connector hinzufügen“ → diese URL.', 'Settings → Connectors → "Add custom connector" → this URL.')}<br>
      ${conn.fixed ? tr(`Feste Adresse über deinen Cloudflare-Tunnel (${esc(conn.fixedHost)}) – bleibt immer gleich.`, `Fixed address via your Cloudflare tunnel (${esc(conn.fixedHost)}) – always stays the same.`) : tr('<b>Schnelltunnel:</b> Die Adresse ändert sich, wenn der Tunnel neu startet (Mind prüft alle 3 min und startet ihn bei Ausfall selbst neu). Dann hier neu kopieren und im Connector ersetzen – oder unten eine feste Adresse einrichten.', '<b>Quick tunnel:</b> The address changes when the tunnel restarts (Mind checks every 3 min and restarts it itself on failure). Then copy it again here and replace it in the connector – or set up a fixed address below.')} ${tr('Über den Connector gestartete Bots dürfen nicht am App-Code arbeiten.', 'Bots started via the connector must not work on the app code.')}</div>
      <div class="mut">${conn.lastOk ? tr(`Von außen erreichbar ✓ (geprüft ${esc(conn.lastOk.slice(11, 16))} UTC)`, `Reachable from outside ✓ (checked ${esc(conn.lastOk.slice(11, 16))} UTC)`) : tr('Erreichbarkeit wird geprüft …', 'Checking reachability …')}${conn.fails ? tr(` · ${conn.fails}× nicht erreichbar`, ` · ${conn.fails}× unreachable`) : ''} · <b class="lnk" data-r="conn-restart">${tr('Tunnel neu starten', 'Restart tunnel')}</b></div>
      <details class="mut" style="margin-top:6px"><summary style="cursor:pointer">${tr('Feste Adresse einrichten (Cloudflare-Tunnel)', 'Set up a fixed address (Cloudflare tunnel)')}</summary>
        ${tr('Cloudflare-Dashboard → Zero Trust → Networks → Tunnels → „Create tunnel“ (cloudflared) → Public Hostname z. B. <i>mind.deine-domain.de</i> → Service <i>http://127.0.0.1:5180</i>. Den Token aus dem Installationsbefehl hier eintragen:', 'Cloudflare dashboard → Zero Trust → Networks → Tunnels → "Create tunnel" (cloudflared) → Public hostname e.g. <i>mind.your-domain.com</i> → Service <i>http://127.0.0.1:5180</i>. Enter the token from the install command here:')}
        <div class="rrow"><input id="r-cfhost" placeholder="${tr('mind.deine-domain.de', 'mind.your-domain.com')}" value="${esc(conn.fixedHost ?? '')}"><input id="r-cftoken" placeholder="${tr('Tunnel-Token (eyJ…)', 'Tunnel token (eyJ…)')}" type="password"><button data-r="conn-fixed">${tr('Speichern', 'Save')}</button></div>
        ${conn.fixed ? `<b class="lnk" data-r="conn-unfix">${tr('Zurück zum Schnelltunnel', 'Back to quick tunnel')}</b>` : ''}</details>
      <div class="rrow"><b class="lnk" data-r="conn-rotate">${tr('Schlüssel erneuern', 'Renew key')}</b><span class="mut">${tr('(alte Adresse wird ungültig)', '(old address becomes invalid)')}</span></div>`
      : `<div class="mut">${conn.error ? esc(conn.error) : tr('Tunnel startet … (einige Sekunden)', 'Tunnel starting … (a few seconds)')}</div>`) : `<div class="mut">${tr('Aus: Mind ist nur auf diesem Mac erreichbar.', 'Off: Mind is only reachable on this Mac.')}</div>`}`;
}

let hub: { configured: boolean; enabled: boolean; url: string; connected: boolean; error: string; mcpUrl: string; shares: { id: string; title: string; own: boolean; owner: string; members: string[]; ownerOnline: boolean }[] } | null = null;
function hubHtml() {
  const h = hub;
  const head = `<div class="rlabel">${tr('Hub', 'Hub')} <span>${tr('– verbindet Mind mit dem Internet (Connector ohne Tunnel) und mit anderen Minds (geteilte Äste)', '– connects Mind to the internet (connector without tunnel) and to other Minds (shared branches)')}</span></div>`;
  if (!h) return `${head}<div class="mut">${tr('Wird geladen …', 'Loading …')}</div>`;
  const join = `<div class="rrow"><input id="r-join" placeholder="${tr('Einladung einfügen (https://…#CODE)', 'Paste invitation (https://…#CODE)')}"><button data-r="hub-join">${tr('Beitreten', 'Join')}</button></div>`;
  if (!h.configured || !h.enabled) return `${head}<div class="rrow"><input id="r-hub-url" placeholder="https://…up.railway.app" value="${esc(h.url)}"><input id="r-hub-key" type="password" placeholder="${tr('Hub-Schlüssel', 'Hub key')}"><button data-r="hub-save">${tr('Verbinden', 'Connect')}</button></div>
    <div class="mut">${tr('Oder mit einer Einladung beitreten – dann braucht es keinen Hub-Schlüssel:', 'Or join with an invitation – then no hub key is needed:')}</div>${join}`;
  const shares = h.shares.length ? h.shares.map((x) => `<div class="rrow"><b>${esc(x.title)}</b><span class="mut">${x.own ? tr(`geteilt mit ${esc(x.members.join(', ') || 'noch niemandem')}`, `shared with ${esc(x.members.join(', ') || 'nobody yet')}`) : tr(`von ${esc(x.owner)}${x.ownerOnline ? '' : ' · offline'}`, `from ${esc(x.owner)}${x.ownerOnline ? '' : ' · offline'}`)}</span></div>`).join('') : `<div class="mut">${tr('Noch keine geteilten Äste. Teilen: ⋯ im Knotenfenster → „Ast mit anderem Mind teilen“.', 'No shared branches yet. To share: ⋯ in the node window → "Share branch with another Mind".')}</div>`;
  return `${head}<div class="mut">${esc(h.url)} · ${h.connected ? tr('verbunden ✓', 'connected ✓') : tr('nicht verbunden', 'not connected')}${h.error ? ` · ${esc(h.error)}` : ''}</div>
    <div class="rrow"><input id="r-hub-mcp" readonly value="${esc(h.mcpUrl)}"><b class="lnk" data-r="hub-copy">${tr('Connector-Adresse kopieren', 'Copy connector address')}</b></div>
    <div class="mut">${tr('Diese Adresse in Claude bzw. ChatGPT als Connector eintragen (statt der Tunnel-Adresse). Sie bleibt gleich, solange der Hub läuft.', 'Enter this address as the connector in Claude or ChatGPT (instead of the tunnel address). It stays the same as long as the hub runs.')}</div>
    ${shares}${join}`;
}
async function loadHub() {
  try { hub = await (await fetch('/api/hub')).json(); } catch { hub = null; }
  const el = document.getElementById('r-hub'); if (el) el.innerHTML = hubHtml();
}
function mirrorHtml(n: GraphNode) {
  const r = n.remote!;
  const files = r.files?.length ? `<div class="mut">${tr('Dateien dort', 'Files there')}: ${r.files.slice(0, 12).map(esc).join(', ')}</div>` : '';
  const msgs = r.msgs?.length ? `<div class="mut" style="margin-top:4px">${r.msgs.slice(-3).map((m) => `<div><b>${esc(m.from)}:</b> ${esc(m.text.slice(0, 220))}</div>`).join('')}</div>` : '';
  return `<div class="mirror"><b>${tr(`Gespiegelt aus dem Mind von ${esc(r.origin)}`, `Mirrored from ${esc(r.origin)}'s Mind`)}</b> · ${tr('Stand', 'as of')} ${esc(new Date(r.at).toLocaleString(LOC(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}${r.online ? '' : ` · ${tr('gerade offline', 'offline right now')}`}<div class="mut">${tr(`Nur lesen. Deine Nachricht unten geht an den Bot bei ${esc(r.origin)}.`, `Read only. Your message below goes to the bot at ${esc(r.origin)}.`)}</div>${files}${msgs}</div>`;
}

async function loadConn() {
  try { conn = await (await fetch('/api/connector')).json(); } catch { conn = null; }
  const el = document.getElementById('r-conn'); if (el) el.innerHTML = connHtml();
  if (conn?.enabled && !conn.mcpUrl && !conn.error && !$('rules').hidden) setTimeout(loadConn, 1500);
}

let tts: { readAloud: string; provider: string; voice: string; openaiKey: string; elevenKey: string; openaiVoices: string[]; elevenVoices: [string, string][] } | null = null;

function ttsHtml() {
  if (!tts) return `<div class="mut">${tr('Stimmen werden geladen …', 'Loading voices …')}</div>`;
  const p = tts.provider;
  const seg = [['system', tr('System (kostenlos)', 'System (free)')], ['openai', tr('OpenAI (ChatGPT-Stimmen)', 'OpenAI (ChatGPT voices)')], ['elevenlabs', 'ElevenLabs']]
    .map(([k, l]) => `<span class="${p === k ? 'on' : ''}" data-r="tts-prov" data-id="${k}">${l}</span>`).join('');
  let body = '';
  if (p === 'system') {
    body = `<div class="rrow"><select id="r-voice">${germanVoices().map((v) => `<option ${pickVoice()?.name === v.name ? 'selected' : ''}>${esc(v.name)}</option>`).join('') || `<option>${tr('keine deutsche Stimme', 'no matching voice')}</option>`}</select></div>
      <div class="mut">${tr('Mac-Stimmen, lokal und kostenlos – klingen synthetisch.', 'Mac voices, local and free – they sound synthetic.')}</div>`;
  } else if (p === 'openai') {
    body = `<div class="rrow"><select id="r-tvoice">${tts.openaiVoices.map((v) => `<option ${tts!.voice === v ? 'selected' : ''} value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>
      <input id="r-tkey" type="password" autocomplete="off" placeholder="${tts.openaiKey ? `${tr('Schlüssel gespeichert', 'Key saved')} ${esc(tts.openaiKey)}` : tr('OpenAI-API-Schlüssel (sk-…)', 'OpenAI API key (sk-…)')}"></div>
      <div class="mut">${tr('Stimmen wie in ChatGPT (Modell gpt-4o-mini-tts). Abrechnung über dein OpenAI-API-Konto (platform.openai.com), nicht über das ChatGPT-Abo – wenige Cent pro Minute.', 'Voices as in ChatGPT (model gpt-4o-mini-tts). Billed through your OpenAI API account (platform.openai.com), not the ChatGPT subscription – a few cents per minute.')}</div>`;
  } else {
    body = `<div class="rrow"><select id="r-tvoice">${tts.elevenVoices.map(([id, n]) => `<option ${tts!.voice === id ? 'selected' : ''} value="${id}">${n}</option>`).join('')}</select>
      <input id="r-tkey" type="password" autocomplete="off" placeholder="${tts.elevenKey ? `${tr('Schlüssel gespeichert', 'Key saved')} ${esc(tts.elevenKey)}` : tr('ElevenLabs-API-Schlüssel', 'ElevenLabs API key')}"></div>
      <div class="mut">${tr('Sehr natürliche Stimmen (eleven_multilingual_v2, spricht Deutsch). Kostenloses Monatskontingent, danach ElevenLabs-Abo. Schlüssel unter elevenlabs.io → Profil → API Keys.', 'Very natural voices (eleven_multilingual_v2, multilingual). Free monthly quota, then an ElevenLabs subscription. Key under elevenlabs.io → Profile → API Keys.')}</div>`;
  }
  const ra = [['aus', tr('Aus', 'Off')], ['stimme', tr('Nur bei Spracheingabe', 'Only for voice input')], ['immer', tr('Immer', 'Always')]]
    .map(([k, l]) => `<span class="${tts!.readAloud === k ? 'on' : ''}" data-r="tts-read" data-id="${k}">${l}</span>`).join('');
  return `<div class="rlabel">${tr('Vorlesen', 'Read aloud')} <span>${tr('– sollen Bot-Antworten vorgelesen werden?', '– should bot replies be read aloud?')}</span></div>
    <div class="seg rseg">${ra}</div>
    ${tts.readAloud === 'aus' ? '' : `<div class="rlabel" style="margin-top:10px">${tr('Stimme', 'Voice')}</div><div class="seg rseg">${seg}</div>${body}`}
    <div class="rrow"><b class="lnk" data-r="voice-test">${tr('Testen', 'Test')}</b><span class="mut">${tr('Schlüssel bleibt lokal in secrets.json im Datenordner, nie bei den Bots.', 'The key stays local in secrets.json in the data folder, never with the bots.')}</span><span class="sp"></span><button data-r="voice-save">${tr('Speichern', 'Save')}</button></div>`;
}

async function loadTts() {
  try { tts = await (await fetch('/api/tts/settings')).json(); } catch { tts = null; }
  const el = document.getElementById('r-tts');
  if (el) el.innerHTML = ttsHtml();
}

function okBudgetHtml() {
  const s = S();
  const bots = s.nodes.filter((n) => n.isBot);
  const depth = (id: string) => { let d = 0; for (let c = chefOf(id); c; c = chefOf(c)) d++; return d; };
  const r = root(s);
  const order: string[] = [];
  const walk = (id: string) => { if (nodeById(s, id)?.isBot && id !== r) order.push(id); children(s, id).forEach(walk); };
  walk(r);
  const top = bots.filter((b) => b.id !== r && (!chefOf(b.id) || chefOf(b.id) === r)).reduce((a, b) => a + (b.okBudget ?? 0), 0);
  const pool = s.okPool ?? 30;
  return `<div class="rlabel">${tr('OK-Budget', 'OK budget')} <span>${tr('– so viele OKs dürfen Bots pro Tag untereinander geben; jeder Chef verteilt sein Budget weiter. Deine eigenen OKs kosten nichts.', '– this many OKs bots may give each other per day; each boss passes its budget on. Your own OKs cost nothing.')}</span></div>
    <div class="okpool">${tr(`${OWNER()}s Pool pro Tag`, `${OWNER()}'s pool per day`)} <input type="number" min="0" id="r-okpool" value="${pool}"> <span class="mut">${tr('an Haupt-Bots verteilt', 'distributed to main bots')}: ${top}${top > pool ? tr(' – mehr als der Pool!', ' – more than the pool!') : ''} · ${tr('heute genutzt', 'used today')}: ${okUsedToday(r)}</span></div>
    <div class="oklist">${order.map((id) => { const n = nodeById(s, id)!; return `<div style="padding-left:${depth(id) * 14}px"><span class="t">${esc(n.title)}</span><span class="nx">${n.okNext ? `${tr('Bei OK', 'On OK')}: ${esc(n.okNext.text)}` : ''}</span><input type="number" min="0" data-okb="${esc(id)}" value="${n.okBudget ?? 0}" title="${tr('OKs pro Tag, die dieser Bot an seine Unter-Bots geben darf', 'OKs per day this bot may give to its sub-bots')}"><i>${okUsedToday(id)} ${tr('heute', 'today')}</i></div>`; }).join('')}</div>
    <div class="rrow"><span class="sp"></span><button data-r="save-ok">${tr('Speichern', 'Save')}</button></div>`;
}

function renderRules() {
  const s = S();
  $('rules').innerHTML = `<div class="rwrap">
    <div class="rtop"><h2>${tr('Regeln', 'Rules')}</h2><span class="sp"></span><span class="ic" data-r="close" title="${tr('Schließen (Esc)', 'Close (Esc)')}">×</span></div>
    <div class="rsec">
      <div class="rlabel">${tr('Aktualisieren-Prompt', 'Update prompt')} <span>${tr('– gilt für ↻ an allen Bots', '– applies to ↻ on all bots')}</span></div>
      <textarea id="r-uprompt">${esc(s.updatePrompt ?? defaultUpdatePrompt())}</textarea>
      <div class="rrow"><b class="lnk" data-r="reset">${tr('Standard wiederherstellen', 'Restore default')}</b><span class="sp"></span><button data-r="save-prompt">${tr('Speichern', 'Save')}</button></div>
    </div>
    <div class="rsec">
      <div class="rlabel">${tr('Grundregeln', 'Ground rules')} <span>${tr('– gelten für jeden Bot in jedem Lauf (kurz halten)', '– apply to every bot in every run (keep short)')}</span></div>
      <textarea id="r-global" placeholder="${tr(`z. B. Belege vor Meinung. Keine erfundenen Zahlen. Kosten immer mitdenken. Bei Geld-Entscheidungen ${OWNER()} fragen.`, `e.g. Evidence before opinion. No invented numbers. Always consider costs. Ask ${OWNER()} for money decisions.`)}">${esc(s.globalInstruction ?? '')}</textarea>
      <div class="rrow"><span class="sp"></span><button data-r="save-global">${tr('Speichern', 'Save')}</button></div>
    </div>
    <div class="rsec" id="r-ok">${okBudgetHtml()}</div>
    <div class="rsec"><div class="rlabel">${tr('Papierkorb', 'Trash')} <span>${tr('– entfernte Äste, wiederherstellbar', '– removed branches, restorable')}</span></div>${(s.trash ?? []).slice().reverse().map((t) => `<div class="rrow"><b>${esc(t.title)}</b><span class="mut">${t.nodes.length} ${tr('Knoten', 'nodes')} · ${esc(t.at.slice(0, 16).replace('T', ' '))}</span><span class="sp"></span><b class="lnk" data-r="restore" data-id="${esc(t.id)}">${tr('Wiederherstellen', 'Restore')}</b></div>`).join('') || `<div class="mut">${tr('Leer.', 'Empty.')}</div>`}</div>
    <div class="rsec" id="r-tts">${ttsHtml()}</div>
    <div class="rsec" id="r-hub">${hubHtml()}</div>
    <div class="rsec" id="r-conn">${connHtml()}</div>
    <div class="mut" style="margin-top:18px">${tr('Arbeitsanweisungen einzelner Bereiche bearbeitest du direkt am Bot: ≡ oben im Knotenfenster.', 'You edit the work instructions of individual areas directly on the bot: ≡ at the top of the node window.')}</div>
  </div>`;
}

function openRules(focus?: string) {
  renderRules();
  loadTts();
  loadConn(); loadHub();
  $('rules').hidden = false;
  if (focus) return;
  if (focus) setTimeout(() => {
    const c = document.getElementById(`r-${focus}`);
    c?.scrollIntoView({ block: 'center' });
    c?.classList.add('hl');
    (c?.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
  }, 30);
}

try { speechSynthesis.onvoiceschanged = () => { if (!$('rules').hidden) renderRules(); }; } catch { /* */ }
$('rules-btn').addEventListener('click', (ev) => { ev.preventDefault(); if ($('rules').hidden) openRules(); else $('rules').hidden = true; });
$('rules').addEventListener('click', async (ev) => {
  const t = (ev.target as HTMLElement).closest('[data-r]') as HTMLElement | null;
  if (!t) return;
  const s = S();
  const id = t.dataset.id ?? '';
  switch (t.dataset.r) {
    case 'close': $('rules').hidden = true; break;
    case 'reset': ($('r-uprompt') as HTMLTextAreaElement).value = defaultUpdatePrompt(); break;
    case 'save-prompt': {
      const v = ($('r-uprompt') as HTMLTextAreaElement).value.trim();
      s.updatePrompt = v && v !== defaultUpdatePrompt() ? v : undefined;
      store.save(); note(tr('Aktualisieren-Prompt gespeichert – gilt für alle Bots.', 'Update prompt saved – applies to all bots.')); break;
    }
    case 'conn': {
      if (id === 'on' && !confirm(tr('Mind über einen Cloudflare-Tunnel aus dem Internet erreichbar machen? Erreichbar ist nur der Connector mit geheimem Schlüssel.', 'Make Mind reachable from the internet via a Cloudflare tunnel? Only the connector with a secret key is reachable.'))) break;
      conn = await (await fetch('/api/connector', { method: 'PUT', body: JSON.stringify({ enabled: id === 'on' }) })).json();
      const el = document.getElementById('r-conn'); if (el) el.innerHTML = connHtml();
      if (id === 'on') setTimeout(loadConn, 1500);
      break;
    }
    case 'conn-restart': { conn = await (await fetch('/api/connector', { method: 'PUT', body: JSON.stringify({ restart: true }) })).json(); const el = document.getElementById('r-conn'); if (el) el.innerHTML = connHtml(); note(tr('Tunnel startet neu – neue Adresse in ein paar Sekunden.', 'Tunnel restarting – new address in a few seconds.')); setTimeout(loadConn, 4000); break; }
    case 'hub-copy': copy(($('r-hub-mcp') as HTMLInputElement).value, tr('Connector-Adresse kopiert.', 'Connector address copied.')); break;
    case 'hub-save': case 'hub-join': {
      const body = t.dataset.r === 'hub-save'
        ? { cmd: 'hub', args: [($('r-hub-url') as HTMLInputElement).value.trim(), ($('r-hub-key') as HTMLInputElement).value.trim()].filter(Boolean) }
        : { cmd: 'join', args: [($('r-join') as HTMLInputElement).value.trim()] };
      if (!body.args[0]) { note(tr('Erst ausfüllen.', 'Fill it in first.')); break; }
      note((await dgText({ ...body, as: OWNER_ID })).trim());
      await loadHub(); await refresh(true); break;
    }
    case 'conn-fixed': case 'conn-unfix': {
      const body = t.dataset.r === 'conn-unfix' ? { cfToken: '', cfHost: '' } : { cfToken: ($('r-cftoken') as HTMLInputElement).value.trim(), cfHost: ($('r-cfhost') as HTMLInputElement).value.trim() };
      if (t.dataset.r === 'conn-fixed' && (!body.cfToken || !body.cfHost)) { note(tr('Hostname und Token eintragen.', 'Enter hostname and token.')); break; }
      conn = await (await fetch('/api/connector', { method: 'PUT', body: JSON.stringify(body) })).json(); setTimeout(loadConn, 3000); note(t.dataset.r === 'conn-fixed' ? tr('Feste Adresse gespeichert – Tunnel startet neu.', 'Fixed address saved – tunnel restarting.') : tr('Zurück zum Schnelltunnel.', 'Back to the quick tunnel.')); break;
    }
    case 'conn-copy': { copy(($('r-mcp') as HTMLInputElement).value, tr('Connector-Adresse kopiert.', 'Connector address copied.')); break; }
    case 'conn-rotate': {
      if (!confirm(tr('Neuen Schlüssel erzeugen? Die bisherige Connector-Adresse funktioniert dann nicht mehr.', 'Generate a new key? The current connector address will then stop working.'))) break;
      conn = await (await fetch('/api/connector', { method: 'PUT', body: JSON.stringify({ rotate: true }) })).json();
      const el = document.getElementById('r-conn'); if (el) el.innerHTML = connHtml();
      note(tr('Neuer Schlüssel – Adresse im Connector ersetzen.', 'New key – replace the address in the connector.')); break;
    }
    case 'tts-read': {
      tts = await (await fetch('/api/tts/settings', { method: 'PUT', body: JSON.stringify({ readAloud: id }) })).json();
      const el = document.getElementById('r-tts'); if (el) el.innerHTML = ttsHtml();
      note(id === 'aus' ? tr('Vorlesen ausgeschaltet.', 'Read-aloud switched off.') : id === 'immer' ? tr('Alle Bot-Antworten an dich werden vorgelesen.', 'All bot replies to you will be read aloud.') : tr('Antworten auf Spracheingaben werden vorgelesen.', 'Replies to voice input will be read aloud.'));
      break;
    }
    case 'tts-prov': {
      if (tts) tts.provider = id;
      const el = document.getElementById('r-tts'); if (el) el.innerHTML = ttsHtml();
      break;
    }
    case 'voice-save':
    case 'voice-test': {
      if (!tts) break;
      const body: Record<string, string> = { provider: tts.provider };
      if (tts.provider === 'system') {
        try { localStorage.setItem(VOICE_KEY, ($('r-voice') as HTMLSelectElement).value); } catch { /* */ }
      } else {
        body.voice = ($('r-tvoice') as HTMLSelectElement).value;
        const k = ($('r-tkey') as HTMLInputElement).value.trim();
        if (k) body[tts.provider === 'openai' ? 'openaiKey' : 'elevenKey'] = k;
      }
      tts = await (await fetch('/api/tts/settings', { method: 'PUT', body: JSON.stringify(body) })).json();
      const el = document.getElementById('r-tts'); if (el) el.innerHTML = ttsHtml();
      if (t.dataset.r === 'voice-test') speak(tr(`Hallo ${OWNER()}. So klinge ich, wenn ich dir die Antworten deiner Bots vorlese. Klingt das gut?`, `Hello ${OWNER()}. This is how I sound when I read your bots' answers to you. Does that sound good?`));
      else note(tr('Vorlesestimme gespeichert.', 'Read-aloud voice saved.'));
      break;
    }
    case 'save-ok': {
      const v = Math.max(0, Math.floor(Number(($('r-okpool') as HTMLInputElement).value) || 0));
      s.okPool = v;
      $('rules').querySelectorAll<HTMLInputElement>('input[data-okb]').forEach((i) => { const n = nodeById(s, i.dataset.okb!); if (n) { const b = Math.max(0, Math.floor(Number(i.value) || 0)); if (b) n.okBudget = b; else delete n.okBudget; } });
      store.save(); note(tr('OK-Budget gespeichert.', 'OK budget saved.')); const el = document.getElementById('r-ok'); if (el) el.innerHTML = okBudgetHtml(); break;
    }
    case 'restore': { if (restoreBranch(s, t.dataset.id!)) { store.save(); draw(); renderRules(); note(tr('Ast wiederhergestellt.', 'Branch restored.')); } break; }
    case 'save-global': {
      s.globalInstruction = ($('r-global') as HTMLTextAreaElement).value.trim() || undefined;
      store.save(); note(tr('Grundregeln gespeichert – gelten ab dem nächsten Lauf für alle Bots.', 'Ground rules saved – apply to all bots from the next run.')); break;
    }
    case 'save': {
      const v = ($('rules').querySelector(`textarea[data-instr="${CSS.escape(id)}"]`) as HTMLTextAreaElement).value.trim();
      nodeById(s, id)!.instruction = v ? { text: v, at: new Date().toISOString(), by: OWNER_ID } : undefined;
      touch(s, id, 'bearbeitung', tr(`Arbeitsanweisung von ${OWNER()} bearbeitet.`, `Work instruction edited by ${OWNER()}.`));
      store.save(); note(tr(`Arbeitsanweisung von ${nodeById(s, id)?.title} gespeichert.`, `Work instruction of ${nodeById(s, id)?.title} saved.`)); renderRules(); openRules(id); break;
    }
    case 'update': {
      await store.saveNow();
      const r = await fetch('/api/bot/update', { method: 'POST', body: JSON.stringify({ nodeId: id }) }).catch(() => null);
      note(r?.ok ? tr(`${nodeById(s, id)?.title} aktualisiert sich.`, `${nodeById(s, id)?.title} is updating itself.`) : tr('Aktualisieren konnte nicht gestartet werden.', 'Update could not be started.')); break;
    }
    case 'show': {
      $('rules').hidden = true;
      ancestors(s, id).forEach((x) => collapsed.delete(x));
      saveFold();
      sel = { kind: 'node', id };
      draw();
      break;
    }
  }
});

// ───────── Voice input ─────────

type Rec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void; onend: () => void; onerror: (e: { error: string }) => void };
let rec: Rec | null = null;
let spoken = false;

const getInp = () => document.getElementById('prompt') as HTMLInputElement | null;

function setRecUi(on: boolean, text = '') {
  document.getElementById('mic')?.classList.toggle('rec', on);
  const lb = document.getElementById('livebar');
  if (!lb) return;
  lb.hidden = !on;
  lb.innerHTML = on ? `<i class="dot"></i> ${text ? `${tr('hört zu', 'listening')}: <b>${esc(text.slice(-140))}</b>` : tr('Aufnahme läuft – sprich jetzt. 🎤 beendet, ↑ sendet.', 'Recording – speak now. 🎤 stops, ↑ sends.')}` : '';
}

function toggleMic() {
  if (rec) { rec.stop(); return; }
  const Ctor = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;
  if (!Ctor || !getInp()) { note(tr('Spracheingabe wird von diesem Browser nicht unterstützt – bitte in Chrome oder Safari öffnen.', 'Voice input is not supported by this browser – please open in Chrome or Safari.')); return; }
  rec = new Ctor();
  rec.lang = LOC();
  rec.interimResults = true;
  rec.continuous = true;
  const base = getInp()!.value ? getInp()!.value + ' ' : '';
  rec.onresult = (e) => {
    let fin = '', interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i] as ArrayLike<{ transcript: string }> & { isFinal: boolean };
      if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript;
    }
    const inp = getInp();
    if (inp) { inp.value = base + fin + interim; inp.scrollLeft = inp.scrollWidth; }
    setRecUi(true, fin + interim);
    spoken = true;
  };
  rec.onerror = (e) => { note(e.error === 'not-allowed' ? tr('Mikrofon nicht erlaubt – im Browser freigeben (im Claude-Fenster ist es gesperrt, bitte Chrome/Safari).', 'Microphone not allowed – grant it in the browser (it is blocked in the Claude window, please use Chrome/Safari).') : `${tr('Spracheingabe', 'Voice input')}: ${e.error}`); };
  rec.onend = () => { rec = null; setRecUi(false); getInp()?.focus(); };
  rec.start();
  setRecUi(true);
}

function sendInput() {
  const inp = getInp();
  if (!inp || !inp.value.trim()) return;
  const v = inp.value;
  inp.value = '';
  rec?.stop();
  send(v, spoken ? 'stimme' : 'text');
  spoken = false;
}

// ───────── Interaction ─────────

svg.addEventListener('dblclick', (ev) => {
  const nodeEl = (ev.target as Element).closest('[data-node]');
  const edgeId = (ev.target as Element).closest('[data-edge]')?.getAttribute('data-edge');
  const id = nodeEl?.getAttribute('data-node') ?? (edgeId ? S().edges.find((e) => e.id === edgeId)?.to ?? null : null);
  ev.preventDefault();
  if (!id || id === focusId) { setFocus(null); note(tr('Fokus aufgehoben.', 'Focus cleared.')); return; }
  setFocus(id);
});

svg.addEventListener('click', async (ev) => {
  const t = ev.target as Element;
  if (dragged) return;
  const act = t.closest('[data-act]');
  if (act) { doAct(act.getAttribute('data-act')!, sel?.kind === 'node' ? sel.id : root(S())); return; }
  const fd = t.closest('[data-fold]');
  if (fd) {
    const id = fd.getAttribute('data-fold')!;
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    saveFold();
    draw();
    return;
  }
  const nodeEl = t.closest('[data-node]');
  const nid = nodeEl?.getAttribute('data-node');
  if (nid && sel?.kind === 'node' && sel.id === nid && minimized) { minimized = false; renderPop(); return; }
  minimized = false;
  const edgeEl = t.closest('[data-edge]');
  menuOpen = false;
  childInput = false;
  modelMenu = false;
  nodeMenu = null;
  replyKey = null;
  detailsOpen = false;
  if (nodeEl && nodeEl.getAttribute('data-node') === root(S()) && !ownerChat) {
    // click on the owner: cockpit (the owner's centre); action buttons above the owner stay visible
    sel = { kind: 'node', id: root(S()) };
    draw(); $('pop').hidden = true; openCockpit(); return;
  }
  ownerChat = false;
  if (nodeEl) sel = { kind: 'node', id: nodeEl.getAttribute('data-node')! };
  else if (edgeEl) sel = { kind: 'edge', id: edgeEl.getAttribute('data-edge')! };
  else sel = null;
  draw();
});

// Double-click on the name in the window: rename (Enter saves, Esc cancels)
$('pop').addEventListener('dblclick', (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-rename]') as HTMLElement | null;
  if (!el || el.querySelector('input')) return;
  const id = el.dataset.rename!;
  const n = nodeById(S(), id);
  if (!n) return;
  ev.preventDefault();
  const inp = document.createElement('input');
  inp.className = 'rename'; inp.value = n.title;
  el.textContent = ''; el.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    inp.blur(); // window may redraw again
    if (save && v && v !== n.title) { const old = n.title; n.title = v; touch(S(), id, 'bearbeitung', tr(`Umbenannt: „${old}“ → „${v}“.`, `Renamed: "${old}" → "${v}".`)); commit(); note(tr(`Umbenannt in „${v}“.`, `Renamed to "${v}".`)); }
    else renderPop();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
  inp.addEventListener('blur', () => finish(true));
});

$('pop').addEventListener('click', async (ev) => {
  const t = ev.target as HTMLElement;
  const s = S();
  const a = t.closest('[data-a]')?.getAttribute('data-a');
  const preset = t.closest('[data-preset]')?.getAttribute('data-preset');
  const del = t.getAttribute('data-del');
  const run = t.getAttribute('data-run');
  if (del) { removePrompt(s, del); return commit(); }
  const eff = t.getAttribute('data-effort'), acc = null as string | null, cancel = t.getAttribute('data-cancel');
  if (cancel) { await fetch('/api/bot/cancel', { method: 'POST', body: JSON.stringify({ runId: cancel }) }); note(tr('Lauf wird abgebrochen …', 'Cancelling run …')); return refresh(true); }
  if ((eff || acc) && sel?.kind === 'node') {
    const n = nodeById(s, sel.id)!;
    n.agentProfile = { ...(n.agentProfile ?? { name: `Bot ${n.title}`, provider: '', model: '', workdir: '', allowedSourceIds: [], instructions: '' }), ...(eff ? { effort: eff as never } : {}), ...(acc ? { access: acc as never } : {}) };
    touch(s, n.id, 'bot', eff ? tr(`Denkstufe: ${eff}.`, `Reasoning level: ${eff}.`) : tr(`Zugriff: ${acc}.`, `Access: ${acc}.`));
    return commit(false);
  }
  const mail = t.getAttribute('data-mail');
  if (mail && sel?.kind === 'node') {
    const n = nodeById(s, sel.id)!;
    if (mail === 'immer' && !confirm(tr(`„${n.title}“ darf dann E-Mails, Antworten und Kalender-Einladungen jederzeit selbst senden und Drive-Dateien teilen – ohne dein OK. Wirklich?`, `"${n.title}" may then send emails, replies and calendar invitations on its own at any time and share Drive files – without your OK. Really?`))) return;
    n.agentProfile = { ...(n.agentProfile ?? { name: `Bot ${n.title}`, provider: '', model: '', workdir: '', allowedSourceIds: [], instructions: '' }), mailSend: mail as never };
    touch(s, n.id, 'bot', mail === 'immer' ? tr('E-Mail senden: dauerhaft erlaubt.', 'Send email: always allowed.') : tr('E-Mail senden: nur nach OK.', 'Send email: only after OK.'));
    return commit(false);
  }
  const cpick = t.getAttribute('data-chatpick');
  if (cpick && sel?.kind === 'node') {
    const ms = [...membersOf(sel.id)];
    const i = ms.findIndex((m) => m.runtime === 'chat');
    if (i >= 0) { ms[i] = { ...ms[i], chatModel: cpick }; setMembers(sel.id, ms); touch(s, sel.id, 'bot', tr(`Modell im Chat: ${cpick}.`, `Model in chat: ${cpick}.`)); }
    return commit(false);
  }
  const stp = t.closest('[data-steps]')?.getAttribute('data-steps');
  if (stp) { if (openSteps.has(stp)) openSteps.delete(stp); else openSteps.add(stp); renderPop(); return; }
  const mdel = t.getAttribute('data-mdel');
  const chair = t.closest('[data-chair]')?.getAttribute('data-chair');
  const madd = t.getAttribute('data-madd');
  const mopt = madd == null ? t.closest('[data-mopt]')?.getAttribute('data-mopt') : null;
  const ctask = t.getAttribute('data-ctask'), copen = t.getAttribute('data-copen'), creply = t.getAttribute('data-creply');
  if (ctask) { dgText({ cmd: 'task', args: [ctask, 'online'] }).then((txt) => copy(txt, tr('Auftrag kopiert – im Chat einfügen, Antwort mit ↩ zurückholen.', 'Task copied – paste it into the chat, bring the reply back with ↩.'))); return; }
  if (copen) { openChat(copen, t.closest('.msg')?.querySelector('[data-ctask]')?.getAttribute('data-ctask') ?? undefined); return; }
  if (creply) { replyKey = replyKey === creply ? null : creply; renderPop(); (document.getElementById('reply-text') as HTMLTextAreaElement | null)?.focus(); return; }
  const cdrop = t.getAttribute('data-cdrop');
  if (cdrop) { await fetch('/api/chat/discard', { method: 'POST', body: JSON.stringify({ key: cdrop }) }); note(tr('Wartende Frage verworfen.', 'Waiting question discarded.')); refresh(true); return; }
  if (sel?.kind === 'node' && (mdel != null || (chair != null && mdel == null) || mopt != null || madd != null)) {
    let ms = [...membersOf(sel.id)];
    const pick = (i: string) => { const o = OPTIONS()[Number(i)]; return { runtime: o.runtime, model: o.model }; };
    if (mdel != null) ms.splice(Number(mdel), 1);
    else if (madd != null) { ms.push(pick(madd)); modelMenu = false; }
    else if (mopt != null) { ms = [pick(mopt)]; modelMenu = false; }
    else if (chair != null && Number(chair) > 0) ms.unshift(...ms.splice(Number(chair), 1));
    if (!ms.length) ms = [pick('0')];
    setMembers(sel.id, ms);
    touch(s, sel.id, 'bot', tr(`Modelle: ${ms.map(mlabel).join(', ')}${ms.length > 1 ? ` (Vorsitz ${mlabel(ms[0])})` : ''}.`, `Models: ${ms.map(mlabel).join(', ')}${ms.length > 1 ? ` (chair ${mlabel(ms[0])})` : ''}.`));
    return commit(false);
  }
  if (run) { const p = s.branchPrompts.find((x) => x.id === run); if (p) send(p.text, 'vorlage'); return; }
  if (preset != null && sel?.kind === 'edge') {
    const p = addStanding(s, sel.id, s.promptPresets[Number(preset)], 'vorlage');
    note(p ? tr('Als dauerhafte Anweisung für diese Branch gesetzt. ▶ führt sie aus.', 'Set as a standing instruction for this branch. ▶ runs it.') : tr('Diese Anweisung ist hier schon gesetzt.', 'This instruction is already set here.'));
    menuOpen = false;
    return commit();
  }
  if (!a || !sel) return;
  if (a === 'bot' && sel.kind === 'node') {
    const n = nodeById(s, sel.id)!;
    n.isBot = !n.isBot;
    nodeMenu = null;
    touch(s, n.id, 'bot', n.isBot ? tr('Agent angelegt.', 'Agent created.') : tr('Agent entfernt.', 'Agent removed.'));
    commit();
  } else if (a === 'readfile' && sel.kind === 'node') {
    if (t.closest('a.dl')) return;
    const fp = (t.closest('[data-id]') as HTMLElement).dataset.id!;
    if (/\.(pdf|png|jpe?g|gif|webp|svg|html?)$/i.test(fp)) window.open(`/api/node-raw?id=${encodeURIComponent(sel.id)}&path=${encodeURIComponent(fp)}`, '_blank');
    else openReader(sel.id, fp);
  } else if (a === 'news') {
    const id = (t.closest('[data-id]') as HTMLElement).dataset.id!;
    if (newsOpen.has(id)) newsOpen.delete(id); else newsOpen.add(id);
    renderPop();
  } else if (a === 'popreset') {
    resetSize($('pop'), 'mind-pop-size'); nodeMenu = null; renderPop(); placePop(true);
  } else if (a === 'update' && sel.kind === 'node') {
    const id = sel.id;
    await store.saveNow();
    const r = await fetch('/api/bot/update', { method: 'POST', body: JSON.stringify({ nodeId: id }) }).catch(() => null);
    if (!r?.ok) { note(tr('Aktualisieren konnte nicht gestartet werden.', 'Update could not be started.')); return; }
    note(tr(`${nodeById(s, id)?.title} aktualisiert sich – Lage, Daten, Arbeitsanweisung, Unter-Bots.`, `${nodeById(s, id)?.title} is updating itself – situation, data, work instruction, sub-bots.`));
    refresh(true);
  } else if (a === 'mkbot' && sel.kind === 'node') {
    const n = nodeById(s, sel.id)!;
    n.isBot = true;
    touch(s, n.id, 'bot', tr('Agent angelegt.', 'Agent created.'));
    commit();
  } else if (a === 'instr' && sel.kind === 'node') {
    if (!nodeById(s, sel.id)?.isBot && chefOf(sel.id)) { sel = { kind: 'node', id: chefOf(sel.id)! }; nodeMenu = 'instr'; draw(); return; }
    nodeMenu = nodeMenu === 'instr' ? null : 'instr'; renderPop();
  } else if (a === 'uprompt') { nodeMenu = null; openRules();
  } else if (a === 'instr-save' && sel.kind === 'node') {
    const v = (document.getElementById('instr-text') as HTMLTextAreaElement).value.trim();
    nodeById(s, sel.id)!.instruction = v ? { text: v, at: new Date().toISOString(), by: OWNER_ID } : undefined;
    touch(s, sel.id, 'bearbeitung', tr(`Arbeitsanweisung von ${OWNER()} bearbeitet.`, `Work instruction edited by ${OWNER()}.`));
    nodeMenu = null; detailsOpen = true; note(tr('Arbeitsanweisung gespeichert.', 'Work instruction saved.')); commit(false);
  } else if (a === 'uprompt-save') {
    s.updatePrompt = (document.getElementById('uprompt-text') as HTMLTextAreaElement).value.trim() || undefined;
    nodeMenu = null; note(tr('Aktualisieren-Prompt gespeichert – gilt für alle Bots.', 'Update prompt saved – applies to all bots.')); commit(false);
  } else if (a === 'uprompt-reset') {
    (document.getElementById('uprompt-text') as HTMLTextAreaElement).value = defaultUpdatePrompt();
  } else if (a === 'close') { delete $('pop').dataset.dragged; sel = null; minimized = false; modelMenu = false; nodeMenu = null; rec?.stop(); draw();
  } else if (a === 'min') { minimized = !minimized; modelMenu = false; nodeMenu = null; renderPop();
  } else if (a === 'big') { big = !big; minimized = false; renderPop();
  } else if (a === 'totop') { (pop().querySelector('.body') as HTMLElement).scrollTo({ top: 0, behavior: 'smooth' });
  } else if (a === 'newsec' && sel.kind === 'node') {
    nodeMenu = null;
    await store.saveNow();
    await fetch('/api/bot/new-section', { method: 'POST', body: JSON.stringify({ nodeId: sel.id }) });
    note(tr('Bot fasst den Abschnitt zusammen und beginnt danach einen neuen.', 'The bot summarises the section and then starts a new one.'));
    refresh(true);
  } else if (a === 'mset') { modelMenu = modelMenu === 'set' ? false : 'set'; renderPop();
  } else if (a === 'mmore') { modelMenu = modelMenu === 'add' ? false : 'add'; renderPop();
  } else if (a === 'details') { detailsOpen = !detailsOpen; renderPop();
  } else if (a === 'summarize' && sel.kind === 'node') { send(SUMMARIZE(), 'vorlage');
  } else if (a === 'open-chat' && sel.kind === 'node') { openChat(sel.id);
  } else if (a === 'nmenu') { nodeMenu = nodeMenu ? null : 'menu'; renderPop();
  } else if (a === 'newchat' && sel.kind === 'node') {
    const n = nodeById(s, sel.id)!;
    const old = n.agentProfile?.chatUrl;
    if (!old || !confirm(tr('Alten Online-Chat archivieren und beim nächsten ↗ einen neuen beginnen?', 'Archive the old online chat and start a new one on the next ↗?'))) return;
    const day = new Date().toISOString().slice(0, 10);
    const sid = `chat:${n.id}:${Date.now().toString(36)}`;
    s.sources.push({ id: sid, title: tr(`Online-Chat bis ${day}`, `Online chat until ${day}`), kind: 'chat', date: day, link: old, path: null, location: tr(`archivierter Bot-Chat von ${n.title}`, `archived bot chat of ${n.title}`), excerpt: null });
    n.sourceIds.push(sid);
    n.agentProfile = { ...n.agentProfile!, chatUrl: undefined };
    touch(s, n.id, 'archiv', tr(`Online-Chat archiviert (${old}); nächster ↗ beginnt einen neuen.`, `Online chat archived (${old}); the next ↗ starts a new one.`), sid);
    nodeMenu = null;
    note(tr('Alter Chat archiviert. ↗ öffnet jetzt einen neuen Chat, der sich Stand und Verlauf über den Connector holt.', 'Old chat archived. ↗ now opens a new chat that fetches state and history via the connector.'));
    commit(false);
  } else if ((a === 'share' || a === 'unshare' || a === 'leave') && sel.kind === 'node') {
    nodeMenu = null; renderPop();
    if (a === 'unshare' && !confirm(tr('Teilen beenden? Die andere Seite verliert den Spiegel.', 'Stop sharing? The other side loses the mirror.'))) return;
    const txt = await dgText({ cmd: a, args: [sel.id], as: OWNER_ID });
    if (a === 'share' && /#/.test(txt)) { const inv = txt.trim().split('\n').pop()!; copy(inv, tr('Einladung kopiert – an die andere Person schicken.', 'Invitation copied – send it to the other person.')); }
    else note(txt.trim());
    return refresh(true);
  } else if (a === 'reich') { modelMenu = false; nodeMenu = nodeMenu === 'reich' ? null : 'reich'; renderPop();
  } else if (a === 'reich-save' && sel.kind === 'node') {
    const n = nodeById(s, sel.id)!;
    const dirs = (document.getElementById('reich-dirs') as HTMLTextAreaElement).value.split('\n').map((x) => x.trim()).filter(Boolean);
    const bad = dirs.find((d) => !/^(~|\/)/.test(d));
    if (bad) { note(tr(`Pfad bitte absolut oder mit ~/ angeben: ${bad}`, `Please give the path as absolute or with ~/: ${bad}`)); return; }
    if (dirs.some((d) => /^~\/?$|^\/$|^\/Users\/[^/]+\/?$/.test(d)) && !confirm(tr('Ganzer Home-Ordner als Arbeitsordner – der Ast darf dann überall schreiben. Wirklich?', 'Entire home folder as work folder – the branch may then write anywhere. Really?'))) return;
    const priv = (document.getElementById('reich-priv') as HTMLInputElement).checked;
    if (dirs.length) n.workDirs = dirs; else delete n.workDirs;
    if (priv) n.private = true; else delete n.private;
    touch(s, n.id, 'bot', tr(`Reich: ${dirs.length ? `Arbeitsordner ${dirs.join(', ')}` : 'keine eigenen Arbeitsordner'}${priv ? ' · privat' : ''}.`, `Realm: ${dirs.length ? `work folders ${dirs.join(', ')}` : 'no own work folders'}${priv ? ' · private' : ''}.`));
    nodeMenu = null; note(tr('Reich gespeichert – gilt ab dem nächsten Lauf.', 'Realm saved – applies from the next run.'));
    commit(false);
  } else if (a === 'arch') { nodeMenu = 'archive'; renderPop(); (document.getElementById('arch-text') as HTMLTextAreaElement)?.focus();
  } else if (a === 'clink') { nodeMenu = 'link'; renderPop();
  } else if (a === 'ctx' && sel.kind === 'node') {
    const txt = await dgText({ cmd: 'show', args: [sel.id], as: OWNER_ID });
    nodeMenu = null; renderPop();
    copy(tr(`${txt}\n\n---\nKontext aus ${OWNER()}s Mind-Karte. Arbeite hier weiter; das Ergebnis archiviert ${OWNER()} danach am Knoten „${nodeById(s, sel.id)?.title}“.`, `${txt}\n\n---\nContext from ${OWNER()}'s Mind map. Continue working here; ${OWNER()} will then archive the result at the node "${nodeById(s, sel.id)?.title}".`), tr('Kontext kopiert – in einem neuen Chat einfügen.', 'Context copied – paste it into a new chat.'));
  } else if (a === 'arch-save' && sel.kind === 'node') {
    const text = (document.getElementById('arch-text') as HTMLTextAreaElement).value.trim();
    const link = (document.getElementById('arch-link') as HTMLInputElement).value.trim();
    if (!text) { note(tr('Erst den Chat-Auszug einfügen.', 'Paste the chat excerpt first.')); return; }
    const n = nodeById(s, sel.id)!;
    const id = `chat:${n.id}:${Date.now().toString(36)}`;
    const day = new Date().toISOString().slice(0, 10);
    s.sources.push({ id, title: `${tr('Chat-Auszug', 'Chat excerpt')} · ${day}${link ? ' · ' + (link.match(/claude|chatgpt|openai/)?.[0] ?? 'Chat') : ''}`, kind: 'chat', date: day, link, path: null, location: tr(`archiviert an ${n.title}`, `archived at ${n.title}`), excerpt: text, missing: link ? [] : [tr('Direktlink zum Chat', 'Direct link to the chat')] });
    n.sourceIds.push(id);
    touch(s, n.id, 'archiv', tr(`Chat-Auszug archiviert (${text.length} Zeichen).`, `Chat excerpt archived (${text.length} characters).`), id);
    nodeMenu = null;
    note(tr('Chat-Auszug am Knoten archiviert (Quelle, im Detail sichtbar).', 'Chat excerpt archived at the node (source, visible in the details).'));
    commit(false);
  } else if (a === 'clink-save' && sel.kind === 'node') {
    const v = (document.getElementById('chat-link') as HTMLInputElement).value.trim();
    if (v && !/^https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com)\//.test(v)) { note(tr('Bitte einen claude.ai- oder chatgpt.com-Link.', 'Please enter a claude.ai or chatgpt.com link.')); return; }
    const n = nodeById(s, sel.id)!;
    n.agentProfile = { ...(n.agentProfile ?? { name: `Bot ${n.title}`, provider: '', model: '', workdir: '', allowedSourceIds: [], instructions: '' }), chatUrl: v || undefined };
    nodeMenu = null;
    note(v ? tr('↗ öffnet jetzt dieses Gespräch.', '↗ now opens this conversation.') : tr('Chat-Link entfernt.', 'Chat link removed.'));
    commit(false);
  } else if (a === 'runtime' && sel.kind === 'node') {
    const n = nodeById(s, sel.id)!;
    const next = RUNTIMES[(RUNTIMES.indexOf(runtimeOf(n.id)) + 1) % RUNTIMES.length];
    n.agentProfile = { ...(n.agentProfile ?? { name: `Bot ${n.title}`, model: '', workdir: '', allowedSourceIds: [], instructions: '' }), provider: next };
    commit(false);
  } else if (a === 'child') { childInput = !childInput; nodeMenu = null; renderPop(); }
  else if (a === 'fold' && sel.kind === 'node') {
    nodeMenu = null;
    if (collapsed.has(sel.id)) collapsed.delete(sel.id); else collapsed.add(sel.id);
    saveFold();
    draw();
  } else if (a === 'mic') toggleMic();
  else if (a === 'send') sendInput();
  else if (a === 'ok') { if (!t.closest('.off')) send('OK', 'text'); }
  else if (a === 'plus') { menuOpen = !menuOpen; renderPop(); }
  else if (a === 'save-preset') {
    const v = (document.getElementById('prompt') as HTMLInputElement)?.value.trim();
    if (!v) { note(tr('Erst Text eingeben, dann als Vorlage speichern.', 'Enter text first, then save as template.')); return; }
    if (!s.promptPresets.includes(v)) s.promptPresets.push(v);
    note(tr('Vorlage gespeichert.', 'Template saved.'));
    commit(false);
  }
});

$('pop').addEventListener('keydown', async (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'chatlink-inline' && ev.key === 'Enter' && sel?.kind === 'node') {
    const v = t.value.trim();
    if (!/^https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com)\//.test(v)) { note(tr('Bitte den Link aus der Adresszeile von claude.ai oder chatgpt.com einfügen.', 'Please paste the link from the address bar of claude.ai or chatgpt.com.')); return; }
    const n = nodeById(S(), sel.id)!;
    n.agentProfile = { ...(n.agentProfile ?? { name: `Bot ${n.title}`, provider: '', model: '', workdir: '', allowedSourceIds: [], instructions: '' }), chatUrl: v };
    askLink.delete(n.id);
    note(tr('Chat-Link gespeichert – ↗ führt bei diesem Knoten jetzt immer in diesen Chat.', 'Chat link saved – ↗ on this node now always leads to this chat.'));
    return commit(false);
  }
  if (t.id === 'chat-model' && ev.key === 'Enter' && sel?.kind === 'node') {
    const ms = [...membersOf(sel.id)];
    const i = Number(t.getAttribute('data-chatm'));
    ms[i] = { ...ms[i], chatModel: t.value.trim() || undefined };
    setMembers(sel.id, ms);
    note(tr('Modell im Chat gespeichert – wird bei Antworten mitprotokolliert.', 'Model in chat saved – it is logged along with replies.'));
    modelMenu = false;
    return commit(false);
  }
  if (t.id === 'reply-text' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && replyKey && t.value.trim()) {
    const r = await dgText({ cmd: 'reply', args: [replyKey, t.value.trim()] });
    note(r.trim());
    replyKey = null;
    return refresh(true);
  }
  if (ev.key !== 'Enter') return;
  if (t.id === 'prompt') sendInput();
  if (t.id === 'child-title' && sel?.kind === 'node' && t.value.trim()) {
    const n = addChild(S(), sel.id, t.value.trim());
    if (sel.id === root(S()) && planeView() && plane) n.plane = plane;
    collapsed.delete(sel.id);
    childInput = false;
    sel = { kind: 'node', id: n.id };
    commit();
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!modelMenu && !nodeMenu && !menuOpen && !big && $('rules').hidden) delete $('pop').dataset.dragged;
    if (!$('rules').hidden) { $('rules').hidden = true; return; }
    if (!$('reader').hidden) { $('reader').hidden = true; return; }
    if (!$('cockpit').hidden) { $('cockpit').hidden = true; return; }
    if (modelMenu || nodeMenu || menuOpen) { modelMenu = false; nodeMenu = null; menuOpen = false; renderPop(); return; }
    if (big) { big = false; renderPop(); return; }
    if (focusId && !sel) { setFocus(null); return; }
    sel = null; rec?.stop(); draw();
  }
});

// Pan & Zoom
let drag: { x: number; y: number; vx: number; vy: number } | null = null;
let dragged = false;
let rotDrag: { a: number; rot: number } | null = null;
const angleAt = (x: number, y: number) => Math.atan2(y - view.y, x - view.x); // centre = owner (origin)
svg.addEventListener('pointerdown', (ev) => {
  if ((ev.target as Element).closest('[data-node],[data-edge]')) return;
  if (ev.altKey && mode === 'circle' && !focusId) { rotDrag = { a: angleAt(ev.clientX, ev.clientY), rot }; dragged = false; return; }
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  dragged = false;
});
addEventListener('pointermove', (ev) => {
  if (!rotDrag) return;
  dragged = true;
  setRotation(rotDrag.rot + angleAt(ev.clientX, ev.clientY) - rotDrag.a);
});
addEventListener('pointerup', () => { rotDrag = null; });
addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) { dragged = true; svg.classList.add('panning'); }
  view.x = drag.vx + dx;
  view.y = drag.vy + dy;
  applyView();
});
addEventListener('pointerup', () => {
  drag = null;
  svg.classList.remove('panning');
  setTimeout(() => (dragged = false), 0);
});
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  // pinch (ctrl) or mouse wheel zooms; trackpad swipe pans
  const mouseWheel = ev.deltaMode !== 0 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50);
  if (ev.ctrlKey || ev.metaKey || mouseWheel) {
    const f = Math.exp(-ev.deltaY * 0.0025);
    const k = Math.min(3, Math.max(0.25, view.k * f));
    view.x = ev.clientX - (ev.clientX - view.x) * (k / view.k);
    view.y = ev.clientY - (ev.clientY - view.y) * (k / view.k);
    view.k = k;
  } else {
    view.x -= ev.deltaX;
    view.y -= ev.deltaY;
  }
  applyView();
}, { passive: false });
addEventListener('resize', () => { fit(); placePop(true); });

// Drag the window by its header (stays put until it is closed)
let popDrag: { dx: number; dy: number } | null = null;
$('pop').addEventListener('pointerdown', (ev) => {
  const t = ev.target as HTMLElement;
  const r = $('pop').getBoundingClientRect();
  // bottom-right handle: lift the height limit so the window can be dragged as tall as desired
  if (!$('pop').classList.contains('big') && ev.clientX > r.right - 22 && ev.clientY > r.bottom - 22) { $('pop').style.maxHeight = 'none'; return; }
  if (!t.closest('.mhead, .head') || t.closest('[data-a], button, input, select, textarea, .dd-btn')) return;
  popDrag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
  $('pop').classList.add('dragging');
  ev.preventDefault();
});
addEventListener('pointermove', (ev) => {
  if (!popDrag) return;
  const pop = $('pop');
  pop.style.left = `${Math.max(0, Math.min(innerWidth - 60, ev.clientX - popDrag.dx))}px`;
  pop.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - popDrag.dy))}px`;
  pop.dataset.dragged = pop.dataset.key ?? '';
});
addEventListener('pointerup', () => { if (popDrag) { popDrag = null; $('pop').classList.remove('dragging'); } });

// ───────── Rotation slider (right, vertical): full turn over its length; scrolling turns finely; double-click = 0 ─────────
function updateDial() {
  const sl = document.getElementById('rot-slider') as HTMLInputElement | null;
  if (sl && document.activeElement !== sl) sl.value = String((rot * 180) / Math.PI);
}
{
  const sl = $('rot-slider') as HTMLInputElement;
  sl.addEventListener('input', () => setRotation((Number(sl.value) * Math.PI) / 180));
  sl.addEventListener('change', () => sl.blur());
  sl.addEventListener('dblclick', () => { setRotation(0); sl.value = '0'; });
  $('rotor').addEventListener('wheel', (ev) => { ev.preventDefault(); ev.stopPropagation(); setRotation(rot + ev.deltaY * 0.003); }, { passive: false });
}

// ───────── Planes: rotate about the vertical through the owner onto the next (perpendicular) circle plane ─────────
function updatePlaneBtn() {
  const b = $('plane-btn');
  const tot = planeTotal(S());
  if (plane >= tot) plane = 0;
  b.hidden = !planeView();
  const empty = !children(S(), root(S())).some((c) => (nodeById(S(), c)?.plane ?? 0) === plane);
  b.textContent = `⟳ ${planeName(S(), plane)}${empty ? tr(' (leer)', ' (empty)') : ''} · ${plane + 1}/${tot}`;
  b.title = tr(`Um die Senkrechte drehen: nächste Kreis-Ebene (${tot - 1} belegt + 1 leere zum Befüllen). Neue Hauptäste an ${OWNER()} landen auf der Ebene, die du gerade siehst.`, `Rotate about the vertical: next circle plane (${tot - 1} used + 1 empty to fill). New main branches on ${OWNER()} land on the plane you are currently viewing.`);
}
let flipping = false;
function flipPlane(to?: number) {
  if (flipping || !planeView()) return;
  const tot = planeTotal(S());
  const next = to ?? (plane + 1) % tot;
  if (next === plane) return;
  flipping = true;
  const fg = $('flip');
  const T = 420, t0 = performance.now();
  const step = (now: number) => {
    const u = Math.min(1, (now - t0) / T);
    if (u < 0.5) fg.setAttribute('transform', `scale(${Math.cos(u * Math.PI)},1)`);
    else {
      if (plane !== next) {
        plane = next;
        try { localStorage.setItem(PLANE_KEY, String(plane)); } catch { /* */ }
        if (sel?.kind === 'node' && sel.id !== root(S()) && planeOf(S(), sel.id) !== plane) sel = null;
        if (sel?.kind === 'edge') sel = null;
        draw(); fit(); updatePlaneBtn();
      }
      fg.setAttribute('transform', `scale(${Math.sin((u - 0.5) * Math.PI)},1)`);
    }
    if (u < 1) requestAnimationFrame(step);
    else { fg.removeAttribute('transform'); flipping = false; }
  };
  requestAnimationFrame(step);
}
$('plane-btn').addEventListener('click', (ev) => { ev.preventDefault(); flipPlane(); });
$('edges').addEventListener('click', (ev) => { const p = (ev.target as Element).closest('[data-plane]'); if (p) flipPlane(Number(p.getAttribute('data-plane'))); });

// ───────── Window sizes: drag bottom-right, size is remembered ─────────
function persistSize(el: HTMLElement, key: string, skip: () => boolean) {
  try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); if (v && v.w >= 240) { el.style.width = `${v.w}px`; if (v.h) el.style.height = `${v.h}px`; el.classList.add('sized'); } } catch { /* */ }
  let first = true;
  new ResizeObserver(() => {
    if (first) { first = false; return; }
    if (skip() || el.hidden || el.offsetWidth < 240 || !el.style.width) return;
    try { localStorage.setItem(key, JSON.stringify({ w: Math.round(el.offsetWidth), h: el.style.height ? Math.round(el.offsetHeight) : 0 })); } catch { /* */ }
    el.classList.add('sized');
  }).observe(el);
}
function resetSize(el: HTMLElement, key: string) { try { localStorage.removeItem(key); } catch { /* */ } el.style.width = ''; el.style.height = ''; el.classList.remove('sized'); }
persistSize($('pop'), 'mind-pop-size', () => $('pop').classList.contains('big'));
{ const rw = () => $('rules').querySelector('.rwrap') as HTMLElement | null; new MutationObserver(() => { const w = rw(); if (w && !w.dataset.sz) { w.dataset.sz = '1'; persistSize(w, 'mind-rules-size', () => false); } }).observe($('rules'), { childList: true }); }

const FOLD_KEY = 'quant-map-collapsed';
function saveFold() { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...collapsed])); } catch { /* optional */ } }

(async () => {
  await store.load();
  applyLang();
  const lb = document.createElement('a');
  lb.href = '#'; lb.id = 'layout-btn';
  const MODES = (): Record<Mode, [string, string]> => ({ circle: ['◯', tr('Kreis', 'Circle')], arc: ['◠', tr('Halbkreis', 'Semicircle')], ltr: ['→', tr('links nach rechts', 'left to right')] });
  const NEXT: Record<Mode, Mode> = { circle: 'arc', arc: 'ltr', ltr: 'circle' };
  const setLb = () => { lb.textContent = MODES()[mode][0]; lb.title = tr(`Ansicht: ${MODES()[mode][1]} – klicken für ${MODES()[NEXT[mode]][1]}`, `View: ${MODES()[mode][1]} – click for ${MODES()[NEXT[mode]][1]}`); $('rotor').hidden = mode !== 'circle'; updatePlaneBtn(); };
  setLb();
  lb.addEventListener('click', (ev) => { ev.preventDefault(); mode = NEXT[mode]; try { localStorage.setItem(LAYOUT_KEY, mode); } catch { /* */ } setLb(); draw(); fit(); });
  $('hud').prepend(lb);
  const ls = document.createElement('a');
  ls.href = '#'; ls.id = 'lines-btn';
  const LS = (): Record<string, [string, string]> => ({ curve: ['∿', tr('Linien: geschwungen', 'Lines: curved')], straight: ['╱', tr('Linien: gerade', 'Lines: straight')], step: ['⌐', tr('Linien: gestuft', 'Lines: stepped')] });
  const setLs = () => { ls.textContent = LS()[lineStyle][0]; ls.title = `${LS()[lineStyle][1]} – ${tr('klicken zum Wechseln', 'click to switch')}`; };
  setLs();
  ls.addEventListener('click', (ev) => { ev.preventDefault(); lineStyle = lineStyle === 'curve' ? 'straight' : lineStyle === 'straight' ? 'step' : 'curve'; try { localStorage.setItem(LINES_KEY, lineStyle); } catch { /* */ } setLs(); render(); });
  $('hud').prepend(ls);
  { const cb = document.createElement('a'); cb.href = '#'; cb.textContent = 'Cockpit'; cb.title = tr('Wo du gebraucht wirst, Bei-OK-Liste, Autorun', 'Where you are needed, On-OK list, autorun'); cb.addEventListener('click', (ev) => { ev.preventDefault(); openCockpit(); }); $('rules-btn').before(cb); }
  fetch('/api/health').then((r) => r.json()).then((h) => {
    if (location.port && location.port !== '5180') {
      const b = document.createElement('span');
      b.className = 'testbadge';
      b.textContent = tr('Test-Instanz', 'Test instance');
      b.title = `${tr('Nicht deine Live-Daten', 'Not your live data')}: ${h.dataDir}`;
      $('hud').prepend(b);
    }
  }).catch(() => {});
  store.onConflict = () => { store.dirty = false; refresh(true); };
  try {
    const f = localStorage.getItem(FOLD_KEY);
    (f ? JSON.parse(f) : []).forEach((x: string) => collapsed.add(x));
  } catch { /* empty */ }
  S().botMessages.forEach((m) => spokenMsgs.add(m.id));
  updateDial();
  loadTts();
  draw();
  fit();
  setInterval(() => refresh(), 1500);
  setInterval(() => {
    spinIdx++;
    document.querySelectorAll('#pop .spin .word').forEach((w) => (w.textContent = SPIN_WORDS()[spinIdx % SPIN_WORDS().length]));
  }, 2600);
  (window as unknown as { __map: unknown }).__map = { store, sel: () => sel };
})();
