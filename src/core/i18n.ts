// Language and owner: one codebase, German or English, no hard-coded owner name.
// tr(de, en) picks the text for the current language; OWNER() is the owner's display name (title of the root node).

export type Lang = 'de' | 'en';

/** Technical id of the root node (the owner). Older states used the owner's first name; see migrateOwner in io.ts. */
export const OWNER_ID = 'owner';
/** Older ids that still mean the owner (still accepted as input). */
export const OWNER_ALIASES: string[] = [];
export const isOwnerId = (id: string | null | undefined) => !!id && (id === OWNER_ID || OWNER_ALIASES.includes(id));
export const ownerIdOf = (id: string) => (OWNER_ALIASES.includes(id) ? OWNER_ID : id);

let lang: Lang = 'en';
let owner = 'Owner';

export function setLang(l: Lang | undefined | null) { lang = l === 'de' ? 'de' : 'en'; }
export function getLang(): Lang { return lang; }
export function setOwner(name: string | undefined | null) { owner = name?.trim() || (lang === 'de' ? 'Besitzer' : 'Owner'); }
/** Display name of the owner (root node title). */
export const OWNER = () => owner;

/** Text in the current language. */
export const tr = (de: string, en: string) => (lang === 'de' ? de : en);
