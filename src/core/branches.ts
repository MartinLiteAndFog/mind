import { OWNER_ID, tr } from './i18n.ts';
import { now, type GraphState, type BranchPrompt, type AgentTask } from './model.ts';
import { nodeById, ancestors, touch } from './graph.ts';
import { createTask } from './agents.ts';

/** Responsible bot of a branch: the target node itself or the next bot above it. */
export function responsibleBot(s: GraphState, edgeId: string): string | null {
  const e = s.edges.find((x) => x.id === edgeId);
  if (!e) return null;
  for (const id of [e.to, ...ancestors(s, e.to).reverse()]) if (nodeById(s, id)?.isBot) return id;
  return null;
}

export function standingPrompts(s: GraphState, edgeId: string): BranchPrompt[] {
  return s.branchPrompts.filter((p) => p.edgeId === edgeId && p.kind === 'dauerhaft');
}

const pid = () => `bp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function addStanding(s: GraphState, edgeId: string, text: string, via: BranchPrompt['via']): BranchPrompt | null {
  if (standingPrompts(s, edgeId).some((p) => p.text === text)) return null;
  const e = s.edges.find((x) => x.id === edgeId)!;
  const p: BranchPrompt = { id: pid(), edgeId, text, kind: 'dauerhaft', via, createdAt: now(), botNodeId: null, taskId: null };
  s.branchPrompts.push(p);
  touch(s, e.to, 'branch', tr(`Dauerhafte Anweisung für die Branch gesetzt: „${text}“`, `Standing instruction set for the branch: “${text}”`));
  return p;
}

export function removePrompt(s: GraphState, id: string) {
  s.branchPrompts = s.branchPrompts.filter((p) => p.id !== id);
}

/**
 * Send a one-time instruction to the branch. If there is a responsible bot, it becomes
 * an agent task (including the standing instructions of this branch).
 */
export function sendPrompt(s: GraphState, edgeId: string, text: string, via: BranchPrompt['via']): { prompt: BranchPrompt; task: AgentTask | null; note: string } {
  const e = s.edges.find((x) => x.id === edgeId)!;
  const bot = responsibleBot(s, edgeId);
  const p: BranchPrompt = { id: pid(), edgeId, text, kind: 'einmalig', via, createdAt: now(), botNodeId: bot, taskId: null };
  s.branchPrompts.push(p);
  const from = nodeById(s, e.from)?.title ?? e.from;
  const to = nodeById(s, e.to)?.title ?? e.to;
  if (!bot) {
    touch(s, e.to, 'branch', tr(`Anweisung notiert (kein Bot zuständig): „${text}“`, `Instruction noted (no bot responsible): “${text}”`));
    return { prompt: p, task: null, note: tr(`Notiert. Auf „${to}“ und darüber ist noch kein Bot – Knoten anklicken und „Bot“ einschalten.`, `Noted. There is no bot on “${to}” or above it yet – click the node and switch “Bot” on.`) };
  }
  const standing = standingPrompts(s, edgeId).map((x) => `- ${x.text}`).join('\n');
  const t = createTask(s, {
    nodeId: bot, requestedBy: OWNER_ID, requestedConfig: {},
    instruction: tr(`Branch ${from} → ${to} (Kante \`${edgeId}\`):\n\n${text}${standing ? `\n\nDauerhafte Anweisungen dieser Branch:\n${standing}` : ''}`, `Branch ${from} → ${to} (edge \`${edgeId}\`):\n\n${text}${standing ? `\n\nStanding instructions of this branch:\n${standing}` : ''}`),
  });
  if (typeof t === 'string') return { prompt: p, task: null, note: t };
  p.taskId = t.id;
  return { prompt: p, task: t, note: tr(`An Bot „${nodeById(s, bot)?.title}“ übergeben (${t.id}).`, `Handed to bot “${nodeById(s, bot)?.title}” (${t.id}).`) };
}
