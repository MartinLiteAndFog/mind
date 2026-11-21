// Data model of the quant decision graph (schema version 2).
//
// Sign convention: maxDrawdownPct is NEGATIVE (e.g. -46.3 = 46.3 % below the high).
// Field names are unambiguous: periodStart/periodEnd are dates, finalWealthEur is final wealth.
import { OWNER, tr } from './i18n.ts';

export const SCHEMA = 'quant-decision-graph';
export const SCHEMA_VERSION = 2;

export type ISO = string;

export interface GraphNode {
  id: string;
  title: string;
  type: string; // topic, strategy, strategy variant, decision, counter-calculation, open question, backtest, … (German labels in older data)
  summary: string;
  openPoints: string[];
  sourceIds: string[];
  lastWorkedAt: ISO | null; // last content change or documented work run
  createdAt: ISO;
  agentProfile?: AgentProfile;
  isBot?: boolean; // node works as a bot (green ring)
  /** Work instruction of the zone (management protocol), applies downwards. */
  instruction?: { text: string; at: ISO; by: string };
  /** Short status: positive to-dos (successes, things to build on) and negative ones (problems), each with a short why. */
  todos?: { pos: string[]; neg: string[]; at: ISO; by: string };
  pos2d?: { x: number; y: number }; // taken over from the 2D pilot
  /** Circle plane (0 = first) – only on main branches directly under the owner; child nodes inherit it. */
  plane?: number;
  /** "On OK I will …" – next action the bot carries out on approval (max. 8 words). */
  okNext?: { text: string; at: ISO; by: string };
  /** OK budget per day (assigned by the boss; the owner's root uses GraphState.okPool) and today's usage. */
  okBudget?: number;
  okUsed?: { day: string; n: number };
  /** Human blocker: the owner is needed here (decision, access, data …). */
  blocker?: { text: string; at: ISO; by: string };
  /** Work folders (absolute or ~/…) in which the bots of this branch may work – apply to all child nodes. */
  workDirs?: string[];
  /** Private branch: invisible to bots outside this branch (search, read, folders). */
  private?: boolean;
  /** Mirror of a branch another Mind shares with us (read-only, refreshed by the hub). */
  remote?: { share: string; origin: string; origId: string; bot: boolean; online: boolean; at: string; files?: string[]; msgs?: { at: string; from: string; text: string }[] };
  /** This branch is shared through the hub (share id). */
  sharedAs?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string; // UNTERTHEMA (subtopic), VARIANTE (variant), ERGEBNIS (result), NICHT_PARITAETISCH (not parity), … – persisted values
  sourceIds: string[];
  primary: boolean; // exactly one primary (hierarchy) edge per child node
}

export interface SourceVersion {
  hash: string; // sha256 hex
  fileName: string;
  importedAt: ISO;
  size: number;
  rowCount: number;
  storedPath: string | null; // relative to data/ – imported copy
  originPath: string | null; // deliberately given origin path (CLI)
  header: string[];
  rows: string[][]; // complete rows for the row view
}

export interface Source {
  id: string;
  title: string;
  kind: 'chat' | 'archive' | 'csv' | 'file' | 'agent-report' | 'note';
  date: string | null;
  link: string;
  path: string | null;
  location: string; // location of the evidence
  excerpt: string | null;
  parentSourceId?: string;
  versions?: SourceVersion[];
  missing?: string[]; // explicitly missing parts of the evidence
}

export interface Observation {
  sourceId: string;
  versionHash: string;
  rowIndex: number; // 0-based, without header
  key: string;
  importedAt: ISO;
  values: Record<string, string>;
}

export interface RunConfig {
  startCapitalEur: number | null;
  reset: string | null;
  botPool: string | null;
  signalSource: string | null;
  leverage: number | null;
  costs: string | null;
  rules: string | null;
  extra: Record<string, string>;
}

export interface Metric { value: number | null; unit: string }

export interface Run {
  id: string;
  nodeId: string;
  variantLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  config: RunConfig;
  metrics: { finalWealthEur: Metric; maxDrawdownPct: Metric; [k: string]: Metric };
  sourceIds: string[];
  evidence: 'seed-uebernommen' | 'csv-belegt' | 'agent-bericht';
  adapterKey: string | null;
  observations: Observation[];
}

export interface Decision {
  id: string;
  nodeId: string;
  date: string | null;
  kind: 'entscheidung' | 'korrektur' | 'annahme';
  content: string;
  rationale: string | null;
  sourceIds: string[];
  refersTo: string | null; // earlier decision/assumption
  affectedNodeIds: string[];
  /** who recorded it and when (bot id or owner) */
  by?: string;
  at?: ISO;
}

export interface CameraState { x: number; y: number; z: number; lx: number; ly: number; lz: number }

export interface ViewState {
  focus: string;
  depth: number;
  expanded: string[];
  collapsed: string[];
  camera: CameraState | null;
  pinned: Record<string, { x: number; y: number; z: number }>;
  selected: string | null;
  history: { focus: string; expanded: string[]; camera: CameraState | null }[];
}

export interface AgentProfile {
  name: string;
  provider: string; // e.g. anthropic, openai, local
  model: string; // model profile, e.g. haiku / opus / fable / gpt
  workdir: string;
  allowedSourceIds: string[];
  instructions: string;
  /** Several models for one bot: first = chair (forms the consensus and writes). */
  members?: BotMember[];
  /** Thinking level (claude --effort) and access level of the bot runs. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** obsolete (before the realm model) – no longer evaluated. */
  access?: 'knoten' | 'lesen' | 'voll';
  /** Sending email (also reply/forward, Drive sharing, calendar invitations): only after OK (default) or permanently allowed. */
  mailSend?: 'ok' | 'immer';
  /** Memory: running Claude session (continued with --resume) and section counter. */
  session?: { id: string; startedAt: ISO; runs: number } | null;
  section?: number;
  /** Stored conversation link (claude.ai/chat/…, chatgpt.com/c/…) for "Open chat". */
  chatUrl?: string;
}

export interface BotMember { runtime: 'claude' | 'codex' | 'test' | 'chat'; model: string; chatModel?: string }

export type TaskStatus = 'wartend' | 'läuft' | 'fertig' | 'fehlgeschlagen';

export interface AgentReport {
  taskId: string;
  nodeId: string;
  status: TaskStatus;
  provider: string | null;
  model: string | null;
  summary: string;
  usedConfig: Record<string, string>;
  evidence: { title: string; path?: string; location?: string; excerpt?: string }[];
  artifacts: { title: string; path: string }[];
  deviations: string[];
  nextQuestions: string[];
  receivedAt: ISO;
  rawPath: string;
}

export interface AgentTask {
  id: string;
  nodeId: string; // executing node
  requestedBy: string; // OWNER_ID or node id of the boss agent
  parentTaskId: string | null;
  profile: AgentProfile;
  instruction: string;
  requestedConfig: Record<string, string>;
  sourceIds: string[];
  status: TaskStatus;
  createdAt: ISO;
  updatedAt: ISO;
  exportedPath: string | null;
  report: AgentReport | null;
}

export interface Delegation { from: string; to: string }

export interface LogEntry { at: ISO; nodeId: string | null; kind: string; text: string; ref?: string }

export interface GraphState {
  schema: typeof SCHEMA;
  version: number;
  revision: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sources: Source[];
  runs: Run[];
  decisions: Decision[];
  delegations: Delegation[];
  agentTasks: AgentTask[];
  log: LogEntry[];
  view: ViewState;
  legacyExports: { importedAt: ISO; fileName: string; payload: unknown }[];
  branchPrompts: BranchPrompt[];
  botMessages: BotMessage[];
  promptPresets: string[];
  updatePrompt?: string;
  /** System-wide ground rules, apply to every bot run. */
  globalInstruction?: string;
  /** Language of the interface and the bot instructions (default: en). */
  lang?: 'de' | 'en';
  /** First-time setup completed (name, ground rules, zones). */
  setup?: { done: boolean; at: ISO };
  /** The owner's OK budget per day for all bots together (bosses pass it on). */
  okPool?: number;
  /** Names of the circle planes (index = plane). */
  planeNames?: string[];
  /** Trash: removed branches (restorable). */
  trash?: TrashItem[];
}

export interface TrashItem { id: string; at: ISO; by: string; rootId: string; title: string; parentId: string | null; nodes: GraphNode[]; edges: GraphEdge[] }

export const now = () => new Date().toISOString();

export function emptyConfig(): RunConfig {
  return { startCapitalEur: null, reset: null, botPool: null, signalSource: null, leverage: null, costs: null, rules: null, extra: {} };
}

/** Config field labels in the current language (call at render time). */
export const configFields = (): [keyof Omit<RunConfig, 'extra'>, string][] => [
  ['startCapitalEur', tr('Startkapital', 'Start capital')],
  ['reset', tr('Reset', 'Reset')],
  ['botPool', tr('Bot-Pool', 'Bot pool')],
  ['signalSource', tr('Signalquelle', 'Signal source')],
  ['leverage', tr('Hebel', 'Leverage')],
  ['costs', tr('Kosten', 'Costs')],
  ['rules', tr('Regeln', 'Rules')],
];
/** @deprecated German labels, kept for older callers (src/ui/main.ts) – use configFields(). */
export const CONFIG_FIELDS: [keyof Omit<RunConfig, 'extra'>, string][] = [
  ['startCapitalEur', 'Startkapital'], ['reset', 'Reset'], ['botPool', 'Bot-Pool'], ['signalSource', 'Signalquelle'],
  ['leverage', 'Hebel'], ['costs', 'Kosten'], ['rules', 'Regeln'],
];

/** Instruction on a connection line (branch = edge to the child node and everything below). */
export interface BranchPrompt {
  id: string;
  edgeId: string;
  text: string;
  kind: 'einmalig' | 'dauerhaft';
  via: 'text' | 'stimme' | 'vorlage';
  createdAt: ISO;
  botNodeId: string | null; // responsible bot at the time of sending
  taskId: string | null;
}

export const defaultPresets = () => [
  tr('Prüfe, ob es auf dieser Branch etwas Neues gibt.', 'Check whether there is anything new on this branch.'),
  tr('Fasse neu zusammen, was auf dieser Branch bisher gemacht wurde.', 'Summarize anew what has been done on this branch so far.'),
];
/** @deprecated German values, kept for older callers – use defaultPresets(). */
export const DEFAULT_PRESETS = [
  'Prüfe, ob es auf dieser Branch etwas Neues gibt.',
  'Fasse neu zusammen, was auf dieser Branch bisher gemacht wurde.',
];

/** Conversation message between the owner and bots or between bots. */
export interface BotMessage {
  id: string;
  threadId: string;
  from: string; // OWNER_ID or node id
  to: string;
  text: string;
  at: ISO;
  edgeId: string | null;
  runId: string;
  kind: 'frage' | 'antwort' | 'fehler' | 'vorschlag';
  via?: 'text' | 'stimme' | 'vorlage' | 'bot';
  runtime?: string;
  steps?: string[]; // work steps of the run (tools, intermediate texts)
  about?: string | null; // child node in question (question to the boss bot)
  section?: number; // conversation section
}

const updatePromptText = (t: (de: string, en: string) => string) => t(`Aktualisieren. Du bist für diesen Bereich verantwortlich: deinen Knoten und alle Unterknoten ohne eigenen Bot. Ignoriere alle anderen Knoten außer deinem Chefknoten. Handle entsprechend deiner Knotendefinition.

1. Anweisungen lesen: die Arbeitsanweisung deines Chefs und deine eigene (stehen unten). Bei Widerspruch gilt die des Chefs, außer deine regelt bewusst eine lokale Ausnahme – dann begründe sie. Gute Ideen werden belohnt.
2. Lage prüfen: Stand, offene Punkte, Läufe, letzte Gespräche, Unterknoten. Was ist erledigt, neu, veraltet oder falsch? Braucht jemand dein OK und kannst du es ihm geben? Hast du genug OK-Budget und verdient er es?
3. Daten auf Stand bringen: Zusammenfassung (dg set-summary), offene Punkte (erledigte mit dg close-open schließen, neue mit dg add-open), Kurzlage (dg set-todos, stichpunktartig je Punkt "Befund → To-do": 3× + Chance ausbauen, 2× – Problem beheben, To-do mit Verb zuerst, je max. 10 Wörter, überholte Punkte ersetzen). Ziel ist Wahrhaftigkeit und Vollständigkeit, nicht die Liste zu füllen: keine Probleme erfinden, Zahlen nur mit Beleg.
4. Arbeitsanweisung pflegen (dg set-instruction) – hast du noch keine, lege sie jetzt an: kurz – Zweck, Prioritäten, Arbeitsweise, Qualitätsmaßstab, wann ${OWNER()} gefragt wird, lokale Abweichungen. Änderungen deines Chefs übernehmen.
5. Unterbereiche: Für jeden Unterknoten mit eigenem Bot prüfen, ob seine Anweisung zu deiner passt; anpassen (dg set-instruction --node …) oder direkt anweisen (dg ask …), und sein Aktualisieren anstoßen (dg update …). Unterknoten ohne Bot pflegst du selbst (--node …).
6. Kurzer Lagebericht: was geändert, was offen, was du von ${OWNER()} brauchst.
7. Lege deine nächste Handlung bei Freigabe fest. Dein "bei OK werde ich...". Priorisiere sie anhand deiner neuen Übersicht und gestalte sie handlich und nicht allzu groß. Große Vorhaben zerlegst du dafür in Einzelteile und hinterlegst Zwischenberichte. Dieses Vorhaben in maximal 8 Worten formulieren.`, `Update. You are responsible for this zone: your node and all child nodes without a bot of their own. Ignore all other nodes except your boss node. Act according to your node definition.

1. Read instructions: your boss's work instruction and your own (shown below). On conflict the boss's applies, unless yours deliberately sets a local exception – then justify it. Good ideas are rewarded.
2. Check the situation: state, open items, runs, latest conversations, child nodes. What is done, new, outdated or wrong? Does anyone need your OK and can you give it? Do you have enough OK budget and does the recipient deserve it?
3. Bring the data up to date: summary (dg set-summary), open items (close finished ones with dg close-open, add new ones with dg add-open), short status (dg set-todos, in bullet form per item "finding → to-do": 3× + opportunity to build on, 2× – problem to fix, to-do starting with a verb, max. 10 words each, replace outdated items). The goal is truthfulness and completeness, not filling the list: do not invent problems, numbers only with evidence.
4. Maintain the work instruction (dg set-instruction) – if you do not have one yet, create it now: short – purpose, priorities, way of working, quality standard, when ${OWNER()} is asked, local deviations. Adopt changes from your boss.
5. Sub-zones: for every child node with its own bot, check whether its instruction fits yours; adjust it (dg set-instruction --node …) or instruct it directly (dg ask …), and trigger its update (dg update …). You maintain child nodes without a bot yourself (--node …).
6. Short status report: what changed, what is open, what you need from ${OWNER()}.
7. Define your next action on approval. Your "on OK I will...". Prioritize it based on your new overview and keep it handy and not too large. Break large undertakings into parts for this and store interim reports. Phrase this undertaking in at most 8 words.`);
/** Default update prompt in the current language (call at use time, not at import). */
export const defaultUpdatePrompt = () => updatePromptText(tr);
/** @deprecated Evaluated at import (German text, default owner name) – use defaultUpdatePrompt(). */
export const DEFAULT_UPDATE_PROMPT = updatePromptText((de) => de);

export const DEFAULT_OK_POOL = 30;
export const DEFAULT_PLANE_NAMES = ['Work', 'Live'];
export const planeName = (s: { planeNames?: string[] }, k: number) => s.planeNames?.[k] || DEFAULT_PLANE_NAMES[k] || tr(`Ebene ${k + 1}`, `Plane ${k + 1}`);
export const okDay = () => new Date().toISOString().slice(0, 10);
