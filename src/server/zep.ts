// Zep-Cloud-Adapter (bot-neutral): Gedächtnis je Bot/Person über User + Thread.
// Key nur aus Umgebungsvariable ZEP_API_KEY. Ohne Key bleibt alles aus (enabled() = false).
const BASE = process.env.ZEP_API_URL || 'https://api.getzep.com/api/v2';

export const zepEnabled = (): boolean => !!process.env.ZEP_API_KEY;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const key = process.env.ZEP_API_KEY;
  if (!key) throw new Error('ZEP_API_KEY fehlt');
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zep ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const uid = (botId: string, person: string) => `${botId}:${person}`;

/** Key-Test: listet höchstens einen User. */
export const zepPing = () => call('GET', '/users-ordered?pageSize=1');

export async function zepEnsure(botId: string, person: string, threadId: string): Promise<void> {
  const user_id = uid(botId, person);
  try { await call('POST', '/users', { user_id, first_name: person }); } catch (e) { if (!/ 40[09] /.test(String(e))) throw e; }
  try { await call('POST', '/threads', { thread_id: threadId, user_id }); } catch (e) { if (!/ 40[09] /.test(String(e))) throw e; }
}

export interface ZepMsg { role: 'user' | 'assistant'; name?: string; content: string; created_at?: string }

export const zepAdd = (threadId: string, messages: ZepMsg[]) =>
  call('POST', `/threads/${encodeURIComponent(threadId)}/messages`, { messages });

/** Kontext-Block, der vor der Antwort in den Prompt gehört. */
export async function zepContext(threadId: string): Promise<string> {
  const r = await call('GET', `/threads/${encodeURIComponent(threadId)}/context`);
  return String(r.context || '');
}

/** Löschen/Korrigieren im Knotenfenster. */
export const zepDeleteThread = (threadId: string) => call('DELETE', `/threads/${encodeURIComponent(threadId)}`);
export const zepDeleteUser = (botId: string, person: string) => call('DELETE', `/users/${encodeURIComponent(uid(botId, person))}`);

/** Import mit Hash-Muster: gleicher Inhalt wird nicht doppelt gesendet. */
export async function zepImport(botId: string, person: string, threadId: string, msgs: ZepMsg[], seenHashes: Set<string>) {
  const { createHash } = await import('node:crypto');
  const fresh = msgs.filter((m) => {
    const h = createHash('sha256').update(`${threadId}|${m.role}|${m.content}`).digest('hex');
    if (seenHashes.has(h)) return false;
    seenHashes.add(h);
    return true;
  });
  await zepEnsure(botId, person, threadId);
  for (let i = 0; i < fresh.length; i += 30) await zepAdd(threadId, fresh.slice(i, i + 30));
  return { sent: fresh.length, skipped: msgs.length - fresh.length };
}

// ───────── Memory of a contact person (one Zep user per person node, speakers named) ─────────

export const personUser = (nodeId: string) => `person:${nodeId}`;
export const personThread = (nodeId: string) => `person-${nodeId}-talks`;

/** Create the person in Zep (idempotent). */
export async function personEnsure(nodeId: string, fullName: string): Promise<void> {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const user_id = personUser(nodeId);
  try { await call('POST', '/users', { user_id, first_name: first || fullName, last_name: rest.join(' ') || undefined }); } catch (e) { if (!/ 40[09] /.test(String(e))) throw e; }
  try { await call('POST', '/threads', { thread_id: personThread(nodeId), user_id }); } catch (e) { if (!/ 40[09] /.test(String(e))) throw e; }
}

/**
 * A conversation as text, lines like "Anna: …" / "Ben: …" (lines without a speaker continue the previous one).
 * The person's lines become role "user", everybody else "assistant" – always with the speaker's name.
 */
export function parseTalk(text: string, personName: string, ownerName: string): ZepMsg[] {
  const first = (x: string) => x.trim().split(/\s+/)[0].toLowerCase();
  const out: ZepMsg[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(/^([A-Za-zÄÖÜäöüß][\wÄÖÜäöüß .'-]{0,40}?)\s*:\s+(.+)$/);
    if (m) {
      const who = m[1].trim();
      const isPerson = first(who) === first(personName) || who.toLowerCase() === personName.toLowerCase();
      out.push({ role: isPerson ? 'user' : 'assistant', name: isPerson ? personName : (first(who) === first(ownerName) ? ownerName : who), content: m[2] });
    } else if (out.length) out[out.length - 1].content += `\n${line}`;
    else out.push({ role: 'assistant', name: `${ownerName} (Notiz)`, content: line });
  }
  return out.map((x) => ({ ...x, content: x.content.slice(0, 4000) }));
}

export async function personAdd(nodeId: string, fullName: string, msgs: ZepMsg[]) {
  await personEnsure(nodeId, fullName);
  for (let i = 0; i < msgs.length; i += 30) await zepAdd(personThread(nodeId), msgs.slice(i, i + 30));
  return msgs.length;
}
export const personContext = (nodeId: string) => zepContext(personThread(nodeId));
export const personDelete = (nodeId: string) => call('DELETE', `/users/${encodeURIComponent(personUser(nodeId))}`);
/** Removes the old, wrongly attributed memory (bot runs saved as the person). */
export const legacyDelete = (botId: string, person: string) => call('DELETE', `/users/${encodeURIComponent(uid(botId, person))}`);
