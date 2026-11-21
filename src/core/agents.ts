import { OWNER_ID, OWNER, tr } from './i18n.ts';
import { now, type GraphState, type AgentTask, type AgentProfile, type AgentReport, type TaskStatus } from './model.ts';
import { nodeById, touch, ancestors } from './graph.ts';

export const defaultProfile = (): AgentProfile => ({
  name: tr('Lokaler Agent', 'Local agent'), provider: tr('lokal (manuelle Übergabe)', 'local (manual handover)'), model: tr('unbestimmt', 'undetermined'),
  workdir: '', allowedSourceIds: [], instructions: '',
});
/** @deprecated German values, kept for older callers (src/ui/main.ts) – use defaultProfile(). */
export const DEFAULT_PROFILE: AgentProfile = {
  name: 'Lokaler Agent', provider: 'lokal (manuelle Übergabe)', model: 'unbestimmt',
  workdir: '', allowedSourceIds: [], instructions: '',
};

/** Would the delegation from → to create a cycle? */
export function wouldCycle(s: GraphState, from: string, to: string): boolean {
  if (from === to) return true;
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length) {
    const c = stack.pop()!;
    if (c === from) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    s.delegations.filter((d) => d.from === c).forEach((d) => stack.push(d.to));
  }
  return false;
}

export function addDelegation(s: GraphState, from: string, to: string): string | null {
  if (s.delegations.some((d) => d.from === from && d.to === to)) return null;
  if (wouldCycle(s, from, to)) return tr(`Delegation ${from} → ${to} würde einen Zyklus erzeugen.`, `Delegation ${from} → ${to} would create a cycle.`);
  s.delegations.push({ from, to });
  touch(s, from, 'agent', tr(`Delegation an ${to} eingerichtet.`, `Delegation to ${to} set up.`));
  return null;
}

let seq = 0;
export function newTaskId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `task-${stamp}-${(++seq).toString().padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;
}

export function createTask(
  s: GraphState,
  args: { nodeId: string; requestedBy: string; parentTaskId?: string | null; instruction: string; requestedConfig: Record<string, string>; sourceIds?: string[] },
): AgentTask | string {
  const node = nodeById(s, args.nodeId);
  if (!node) return tr(`Knoten ${args.nodeId} fehlt.`, `Node ${args.nodeId} is missing.`);
  if (args.requestedBy !== OWNER_ID) {
    if (!s.delegations.some((d) => d.from === args.requestedBy && d.to === args.nodeId)) {
      return tr(`Keine Delegation ${args.requestedBy} → ${args.nodeId}. Zuerst Delegation anlegen.`, `No delegation ${args.requestedBy} → ${args.nodeId}. Create the delegation first.`);
    }
  }
  const profile = { ...(node.agentProfile ?? defaultProfile()) };
  const sourceIds = args.sourceIds ?? (profile.allowedSourceIds.length ? profile.allowedSourceIds : node.sourceIds);
  const t: AgentTask = {
    id: newTaskId(), nodeId: args.nodeId, requestedBy: args.requestedBy, parentTaskId: args.parentTaskId ?? null,
    profile, instruction: args.instruction, requestedConfig: args.requestedConfig, sourceIds: [...sourceIds],
    status: 'wartend', createdAt: now(), updatedAt: now(), exportedPath: null, report: null,
  };
  s.agentTasks.push(t);
  touch(s, args.nodeId, 'agent', tr(`Auftrag ${t.id} angelegt (von ${args.requestedBy}).`, `Task ${t.id} created (by ${args.requestedBy}).`), t.id);
  if (args.requestedBy !== OWNER_ID) touch(s, args.requestedBy, 'agent', tr(`Auftrag ${t.id} an ${args.nodeId} delegiert.`, `Task ${t.id} delegated to ${args.nodeId}.`), t.id);
  return t;
}

export const reportSchemaHint = () => ({
  taskId: tr('<Auftrags-ID, unverändert>', '<task id, unchanged>'),
  nodeId: tr('<Knoten-ID, unverändert>', '<node id, unchanged>'),
  status: 'läuft | fertig | fehlgeschlagen', // persisted values, stay German
  provider: tr('tatsächlich verwendeter Anbieter, z. B. anthropic / openai', 'provider actually used, e.g. anthropic / openai'),
  model: tr('tatsächlich verwendetes Modell', 'model actually used'),
  summary: tr('kurzes Ergebnis in 2–5 Sätzen', 'short result in 2–5 sentences'),
  usedConfig: { [tr('<Feld aus requestedConfig>', '<field from requestedConfig>')]: tr('<tatsächlich verwendeter Wert>', '<value actually used>') },
  evidence: [{ title: tr('Beleg', 'Evidence'), path: tr('relativer Pfad oder URL', 'relative path or URL'), location: tr('Zeile/Abschnitt', 'line/section'), excerpt: tr('optional', 'optional') }],
  artifacts: [{ title: tr('Artefakt', 'Artifact'), path: tr('relativer Pfad', 'relative path') }],
  deviations: [tr('Abweichung vom Auftrag, falls vorhanden', 'deviation from the task, if any')],
  nextQuestions: [tr('nächste offene Frage', 'next open question')],
});
/** @deprecated German text, kept for older callers – use reportSchemaHint(). */
export const REPORT_SCHEMA_HINT = {
  taskId: '<Auftrags-ID, unverändert>',
  nodeId: '<Knoten-ID, unverändert>',
  status: 'läuft | fertig | fehlgeschlagen',
  provider: 'tatsächlich verwendeter Anbieter, z. B. anthropic / openai',
  model: 'tatsächlich verwendetes Modell',
  summary: 'kurzes Ergebnis in 2–5 Sätzen',
  usedConfig: { '<Feld aus requestedConfig>': '<tatsächlich verwendeter Wert>' },
  evidence: [{ title: 'Beleg', path: 'relativer Pfad oder URL', location: 'Zeile/Abschnitt', excerpt: 'optional' }],
  artifacts: [{ title: 'Artefakt', path: 'relativer Pfad' }],
  deviations: ['Abweichung vom Auftrag, falls vorhanden'],
  nextQuestions: ['nächste offene Frage'],
};

export function taskMarkdown(s: GraphState, t: AgentTask): string {
  const node = nodeById(s, t.nodeId)!;
  const path = [...ancestors(s, t.nodeId), t.nodeId].map((id) => nodeById(s, id)?.title ?? id).join(' › ');
  const srcLines = t.sourceIds.map((id) => {
    const src = s.sources.find((x) => x.id === id);
    if (!src) return `- \`${id}\` (${tr('unbekannt', 'unknown')})`;
    const v = src.versions?.at(-1);
    return `- \`${id}\` — ${src.title} · ${src.location}${src.link ? ` · ${src.link}` : ''}${v?.storedPath ? ` · ${tr('Datei', 'File')}: data/${v.storedPath} (sha256 ${v.hash.slice(0, 12)}…)` : ''}${src.excerpt ? `\n  > ${src.excerpt.replace(/\n/g, '\n  > ')}` : ''}`;
  });
  const cfg = Object.entries(t.requestedConfig).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  return tr(`# Agentenauftrag ${t.id}

- **Knoten:** \`${t.nodeId}\` — ${node.title} (${path})
- **Auftraggeber:** ${t.requestedBy === OWNER_ID ? OWNER() : `Knoten \`${t.requestedBy}\``}${t.parentTaskId ? ` · übergeordneter Auftrag \`${t.parentTaskId}\`` : ''}
- **Agentenprofil:** ${t.profile.name} · Anbieter ${t.profile.provider} · Modell ${t.profile.model}
- **Arbeitsordner:** ${t.profile.workdir || '(nicht festgelegt)'}
- **Angelegt:** ${t.createdAt}

## Auftrag

${t.instruction}

${t.profile.instructions ? `## Profilanweisung\n\n${t.profile.instructions}\n` : ''}
## Angeforderte Konfiguration

| Feld | Wert |
|---|---|
${cfg || '| – | – |'}

Melde im Bericht unter \`usedConfig\` für **jedes** dieser Felder den tatsächlich verwendeten Wert. Abweichungen zusätzlich unter \`deviations\`.

## Zugängliche Quellen

${srcLines.join('\n') || '- keine'}

## Knotenstand

${node.summary}

Offene Punkte:
${node.openPoints.map((p) => `- ${p}`).join('\n') || '- keine'}

## Rückbericht

Schreibe den Bericht als JSON nach \`data/agent/reports/${t.id}.json\` (relativ zu apps/decision-graph). Zwischenstand mit \`"status": "läuft"\` ist erlaubt.

\`\`\`json
${JSON.stringify({ ...reportSchemaHint(), taskId: t.id, nodeId: t.nodeId }, null, 2)}
\`\`\`
`, `# Agent task ${t.id}

- **Node:** \`${t.nodeId}\` — ${node.title} (${path})
- **Requested by:** ${t.requestedBy === OWNER_ID ? OWNER() : `node \`${t.requestedBy}\``}${t.parentTaskId ? ` · parent task \`${t.parentTaskId}\`` : ''}
- **Agent profile:** ${t.profile.name} · provider ${t.profile.provider} · model ${t.profile.model}
- **Work folder:** ${t.profile.workdir || '(not set)'}
- **Created:** ${t.createdAt}

## Task

${t.instruction}

${t.profile.instructions ? `## Profile instruction\n\n${t.profile.instructions}\n` : ''}
## Requested configuration

| Field | Value |
|---|---|
${cfg || '| – | – |'}

In the report, state under \`usedConfig\` the value actually used for **each** of these fields. Also list deviations under \`deviations\`.

## Accessible sources

${srcLines.join('\n') || '- none'}

## Node state

${node.summary}

Open items:
${node.openPoints.map((p) => `- ${p}`).join('\n') || '- none'}

## Report back

Write the report as JSON to \`data/agent/reports/${t.id}.json\` (relative to apps/decision-graph). An interim state with \`"status": "läuft"\` (running) is allowed.

\`\`\`json
${JSON.stringify({ ...reportSchemaHint(), taskId: t.id, nodeId: t.nodeId }, null, 2)}
\`\`\`
`);
}

const STATUS: TaskStatus[] = ['wartend', 'läuft', 'fertig', 'fehlgeschlagen'];

export interface IngestResult { taskId: string; ok: boolean; message: string }

export function ingestReport(s: GraphState, raw: unknown, rawPath: string): IngestResult {
  const r = raw as Partial<AgentReport> & Record<string, unknown>;
  const taskId = String(r?.taskId ?? '');
  const t = s.agentTasks.find((x) => x.id === taskId);
  if (!t) return { taskId, ok: false, message: tr(`Bericht ${rawPath}: Auftrags-ID ${taskId || '(leer)'} unbekannt.`, `Report ${rawPath}: task id ${taskId || '(empty)'} unknown.`) };
  if (r.nodeId && r.nodeId !== t.nodeId) return { taskId, ok: false, message: tr(`Bericht ${rawPath}: nodeId ${r.nodeId} passt nicht zu Auftrag (${t.nodeId}).`, `Report ${rawPath}: nodeId ${r.nodeId} does not match the task (${t.nodeId}).`) };
  const status = STATUS.includes(r.status as TaskStatus) ? (r.status as TaskStatus) : 'fehlgeschlagen';
  const sig = JSON.stringify(r);
  if (t.report && JSON.stringify((t.report as unknown as { _raw?: unknown })._raw ?? null) === sig) {
    return { taskId, ok: true, message: tr(`${taskId}: unverändert.`, `${taskId}: unchanged.`) };
  }
  const report: AgentReport & { _raw?: unknown } = {
    taskId, nodeId: t.nodeId, status,
    provider: (r.provider as string) ?? null, model: (r.model as string) ?? null,
    summary: String(r.summary ?? ''),
    usedConfig: (r.usedConfig as Record<string, string>) ?? {},
    evidence: Array.isArray(r.evidence) ? r.evidence : [],
    artifacts: Array.isArray(r.artifacts) ? r.artifacts : [],
    deviations: Array.isArray(r.deviations) ? r.deviations : [],
    nextQuestions: Array.isArray(r.nextQuestions) ? r.nextQuestions : [],
    receivedAt: now(), rawPath, _raw: raw,
  };
  // Automatically detected configuration deviations
  for (const [k, v] of Object.entries(t.requestedConfig)) {
    const used = report.usedConfig[k];
    if (used == null) report.deviations.push(tr(`[automatisch] ${k}: keine Rückmeldung (angefordert: ${v}).`, `[automatic] ${k}: no feedback (requested: ${v}).`));
    else if (String(used).trim() !== String(v).trim()) report.deviations.push(tr(`[automatisch] ${k}: angefordert „${v}“, verwendet „${used}“.`, `[automatic] ${k}: requested “${v}”, used “${used}”.`));
  }
  report.deviations = [...new Set(report.deviations)];
  // Store evidence as sources
  const evidenceIds: string[] = [];
  report.evidence.forEach((e, i) => {
    const id = `report:${taskId}:${i}`;
    evidenceIds.push(id);
    const existing = s.sources.find((x) => x.id === id);
    const src = {
      id, title: e.title || tr(`Beleg ${i + 1}`, `Evidence ${i + 1}`), kind: 'agent-report' as const, date: report.receivedAt.slice(0, 10),
      link: e.path && /^https?:/.test(e.path) ? e.path : '', path: e.path && !/^https?:/.test(e.path) ? e.path : null,
      location: e.location ?? tr(`Bericht ${taskId}`, `Report ${taskId}`), excerpt: e.excerpt ?? null, parentSourceId: undefined,
    };
    if (existing) Object.assign(existing, src); else s.sources.push(src);
  });
  t.report = report;
  t.status = status;
  t.updatedAt = now();
  for (const id of evidenceIds) if (!t.sourceIds.includes(id)) t.sourceIds.push(id);
  touch(s, t.nodeId, 'agent', tr(`Rückbericht ${taskId}: ${status}${report.provider ? ` · ${report.provider}/${report.model}` : ''}.`, `Report back ${taskId}: ${status}${report.provider ? ` · ${report.provider}/${report.model}` : ''}.`), taskId);
  if (t.requestedBy !== OWNER_ID) touch(s, t.requestedBy, 'agent', tr(`Rückbericht ${taskId} von ${t.nodeId}: ${status}.`, `Report back ${taskId} from ${t.nodeId}: ${status}.`), taskId);
  if (t.parentTaskId) {
    const p = s.agentTasks.find((x) => x.id === t.parentTaskId);
    if (p) {
      const subs = s.agentTasks.filter((x) => x.parentTaskId === p.id);
      if (subs.some((x) => x.status === 'fehlgeschlagen')) p.status = 'fehlgeschlagen';
      else if (subs.every((x) => x.status === 'fertig')) p.status = 'fertig';
      else p.status = 'läuft';
      p.updatedAt = now();
    }
  }
  return { taskId, ok: true, message: tr(`${taskId}: ${status}, ${report.deviations.length} Abweichung(en).`, `${taskId}: ${status}, ${report.deviations.length} deviation(s).`) };
}
