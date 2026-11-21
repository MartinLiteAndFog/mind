import type { GraphState } from '../core/model.ts';
import { starterState } from '../core/seed.ts';
import { tr } from '../core/i18n.ts';
import { normalize } from '../core/io.ts';

const LS_KEY = 'quant-decision-graph-v2';

export type Backend = 'datei' | 'browser';

export class Store {
  state!: GraphState;
  backend: Backend = 'browser';
  conflict = false;
  dirty = false;
  offline = false;
  private timer: number | undefined;
  onConflict: () => void = () => {};
  onSaved: (rev: number) => void = () => {};

  async load(): Promise<string> {
    try {
      const h = await fetch('/api/health');
      if (h.ok) this.backend = 'datei';
    } catch { /* no local API */ }
    if (this.backend === 'datei') {
      const r = await fetch('/api/state');
      if (r.ok) { this.state = normalize(await r.json()); return tr('Stand aus data/state.json geladen.', 'Loaded data/state.json.'); }
      this.state = starterState();
      await this.saveNow();
      return tr('Neuer Stand angelegt (data/state.json).', 'New map created (data/state.json).');
    }
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { this.state = normalize(JSON.parse(raw)); return tr('Stand aus Browser-Speicher geladen (keine lokale API).', 'Loaded from browser storage (no local API).'); }
    } catch { /* empty */ }
    this.state = starterState();
    return tr('Neuer Stand (Browser-Speicher, keine lokale API).', 'New map (browser storage, no local API).');
  }

  save() {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.saveNow(), 300);
  }

  async saveNow(force = false) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.state)); } catch { /* Kontingent */ }
    clearTimeout(this.timer);
    if (this.backend !== 'datei' || (this.conflict && !force)) { this.dirty = false; return; }
    let r: Response;
    try { r = await fetch(`/api/state${force ? '?force=1' : ''}`, { method: 'PUT', body: JSON.stringify(this.state) }); }
    catch { this.offline = true; return; } // bleibt dirty, wird nach Wiederverbindung nachgereicht
    if (r.status === 409) { this.conflict = true; this.onConflict(); return; }
    if (r.ok) { const j = await r.json(); this.state.revision = j.revision; this.conflict = false; this.dirty = false; this.offline = false; this.onSaved(j.revision); }
  }

  async reload() {
    this.conflict = false;
    await this.load();
  }

  replace(s: GraphState) {
    s.revision = this.state.revision;
    this.state = s;
    this.save();
  }
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
