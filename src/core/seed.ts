// Starting state for a fresh install: only the owner at the centre, default ground rules, setup still open.
import { SCHEMA, SCHEMA_VERSION, defaultPresets, now, type GraphState } from './model.ts';
import { OWNER_ID, tr } from './i18n.ts';

/** Default ground rules for all bots (shown and confirmed during setup). */
export const defaultRules = () => tr(
  `- Jeder Bot arbeitet frei in seinem Reich: eigener Knoten, Unterknoten und Arbeitsordner (Code, Python, PDFs, Web).
- Außerhalb seines Reichs fragt er seinen Chef (dg request); ganz oben entscheidet der Besitzer im Cockpit.
- E-Mails, Teilen und Einladungen nur als Entwurf – gesendet wird erst nach OK.
- Kein Geld, keine Zahlungen, keine Live-Systeme ohne ausdrückliches OK.
- Löschen nur in den Papierkorb, nie endgültig.
- Jede Antwort endet mit „Bei OK werde ich: …“ – dem nächsten Schritt, der nach einem OK ausgeführt wird.`,
  `- Each bot works freely in its realm: its own node, its sub-nodes and work folders (code, Python, PDFs, web).
- Outside its realm it asks its chief (dg request); at the top the owner decides in the cockpit.
- Emails, sharing and invitations only as drafts – nothing is sent before an OK.
- No money, payments or live systems without an explicit OK.
- Delete only to the trash, never permanently.
- Every answer ends with "On OK I will: …" – the next step, carried out once someone says OK.`);

export function starterState(name = tr('Besitzer', 'Owner')): GraphState {
  const at = now();
  return {
    schema: SCHEMA, version: SCHEMA_VERSION, revision: 0,
    nodes: [{ id: OWNER_ID, title: name, type: 'Thema', summary: tr('Zentrum: deine Bereiche als Äste, Unterthemen darunter.', 'Centre: your areas as branches, sub-topics below.'), openPoints: [], sourceIds: [], lastWorkedAt: null, createdAt: at, isBot: true }],
    edges: [], sources: [], runs: [], decisions: [],
    delegations: [], agentTasks: [], legacyExports: [], branchPrompts: [], botMessages: [], promptPresets: defaultPresets(),
    log: [{ at, nodeId: null, kind: 'seed', text: tr('Neue Mind-Installation.', 'New Mind install.') }],
    view: { focus: OWNER_ID, depth: 4, expanded: [], collapsed: [], camera: null, pinned: {}, selected: null, history: [] },
    globalInstruction: defaultRules(),
    lang: 'en',
    setup: { done: false, at },
  };
}
