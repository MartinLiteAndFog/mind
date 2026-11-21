// Node-side storage under apps/decision-graph/data/ (gitignored).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr } from '../core/i18n.ts';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = process.env.DECISION_GRAPH_DATA ? resolve(process.env.DECISION_GRAPH_DATA) : join(APP_DIR, 'data');
export const STATE_FILE = join(DATA_DIR, 'state.json');

export function ensureDirs() {
  for (const d of ['', 'sources', 'agent/tasks', 'agent/reports', 'exports']) mkdirSync(join(DATA_DIR, d), { recursive: true });
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function readState(): any | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

/** Writes atomically; checks the base revision against the stored state. */
export function writeState(state: any, baseRevision: number | null): { ok: true; revision: number } | { ok: false; current: number } {
  ensureDirs();
  const cur = readState();
  const curRev = cur?.revision ?? 0;
  if (cur && baseRevision !== null && baseRevision !== curRev) return { ok: false, current: curRev };
  state.revision = curRev + 1;
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
  return { ok: true, revision: state.revision };
}

/** Stores an explicitly imported copy: data/sources/<hash12>-<name>. */
export function storeSourceFile(name: string, buf: Buffer): { hash: string; storedPath: string } {
  ensureDirs();
  const hash = sha256(buf);
  const storedPath = `sources/${hash.slice(0, 12)}-${basename(name).replace(/[^\w.\-]+/g, '_')}`;
  const abs = join(DATA_DIR, storedPath);
  if (!existsSync(abs)) writeFileSync(abs, buf);
  return { hash, storedPath };
}

export function safeDataPath(rel: string): string | null {
  const abs = resolve(DATA_DIR, rel);
  return relative(DATA_DIR, abs).startsWith('..') ? null : abs;
}

export function writeTask(id: string, markdown: string, json: unknown): string {
  ensureDirs();
  if (!/^[\w\-]+$/.test(id)) throw new Error(tr('ungültige Auftrags-ID', 'invalid task id'));
  writeFileSync(join(DATA_DIR, 'agent/tasks', `${id}.md`), markdown);
  writeFileSync(join(DATA_DIR, 'agent/tasks', `${id}.json`), JSON.stringify(json, null, 2));
  return `agent/tasks/${id}.md`;
}

export function listReports(): { path: string; json: unknown; error?: string }[] {
  ensureDirs();
  const dir = join(DATA_DIR, 'agent/reports');
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const path = `agent/reports/${f}`;
    try { return { path, json: JSON.parse(readFileSync(join(dir, f), 'utf8')) }; }
    catch (e) { return { path, json: null, error: String(e) }; }
  });
}
