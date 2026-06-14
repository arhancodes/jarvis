// ---------------------------------------------------------------------------
// Contact Resolution — name -> phone number (E.164 digits)
// ---------------------------------------------------------------------------
// Baileys sends to a phone number, not a display name. web.whatsapp.com's
// search-by-name is gone in the Baileys path, so we resolve names ourselves:
//   1. Already a phone number?            -> use as-is
//   2. config/whatsapp-contacts.json map  -> explicit overrides (read FRESH)
//   3. macOS Contacts via osascript       -> system address book (TTL-cached)
//
// The config map is re-read every call so edits take effect immediately. Only
// the expensive macOS Contacts lookups are cached, and only for a short TTL.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readJsonConfig } from './config.js';
import { IS_MAC } from './platform.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('contacts');

// Cache ONLY macOS Contacts results (osascript is slow). TTL-bounded so a
// changed address book is picked up within the window, and explicitly flushable.
const CONTACTS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const contactsCache = new Map<string, { digits: string; ts: number }>();

/** Flush the macOS Contacts lookup cache (call after re-pairing / on demand). */
export function clearContactCache(): void {
  contactsCache.clear();
}

/** True if the string is already a phone number (mostly digits, optional +). */
function looksLikeNumber(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  return digits.length >= 7 && /^\+?[\d\s().-]+$/.test(s.trim());
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Resolve a contact name (or number) to E.164 digits suitable for Baileys.
 * Returns null if it can't be resolved.
 */
export async function resolveContactNumber(nameOrNumber: string): Promise<string | null> {
  const query = nameOrNumber.trim();
  if (!query) return null;

  // 1. Already a number
  if (looksLikeNumber(query)) {
    return digitsOnly(query);
  }

  const key = query.toLowerCase();

  // 2. Explicit config map (name -> number), read FRESH so edits apply at once.
  const map = readJsonConfig<Record<string, string>>('whatsapp-contacts.json', {});
  for (const [name, number] of Object.entries(map)) {
    if (name.toLowerCase() === key) {
      const digits = digitsOnly(number);
      if (digits) return digits;
    }
  }

  // 3. macOS Contacts lookup (TTL-cached)
  if (IS_MAC) {
    const cached = contactsCache.get(key);
    if (cached && Date.now() - cached.ts < CONTACTS_TTL_MS) {
      return cached.digits;
    }
    const fromContacts = await lookupMacContacts(query);
    if (fromContacts) {
      contactsCache.set(key, { digits: fromContacts, ts: Date.now() });
      return fromContacts;
    }
  }

  log.warn(`Could not resolve "${query}" to a phone number`);
  return null;
}

/**
 * Query macOS Contacts for the first phone number of a person whose name
 * contains `name`. The name is passed as a script ARGUMENT (not interpolated
 * into the source) so it can't break the AppleScript string literal and isn't
 * corrupted by escaping. Returns E.164 digits or null.
 */
async function lookupMacContacts(name: string): Promise<string | null> {
  const script = `
on run argv
  set theName to item 1 of argv
  tell application "Contacts"
    set matches to (every person whose name contains theName)
    if (count of matches) is 0 then return ""
    set p to item 1 of matches
    if (count of phones of p) is 0 then return ""
    return value of item 1 of phones of p
  end tell
end run`;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script, name], { timeout: 8000 });
    const raw = stdout.trim();
    if (!raw) return null;
    const digits = digitsOnly(raw);
    return digits.length >= 7 ? digits : null;
  } catch (err) {
    log.debug('macOS Contacts lookup failed', err);
    return null;
  }
}
