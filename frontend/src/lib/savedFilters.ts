import type { Period } from '../pages/Reports';

/**
 * Saved report filters — a personal shortcut for the filter combination on
 * Reports (report type + period/event/city), so ACCT/MGR stop re-entering
 * "this quarter, Vancouver only" on every visit.
 *
 * Client-only by design: there is no server record of these, so a saved view
 * lives in this browser alone and does not follow the user to another device
 * (Reports carries a one-line note saying so). That also means a save can
 * silently outlive the thing it points to — a report type an admin later
 * removes from the catalog — so every read here is defensive: a malformed or
 * stale entry is dropped or shown disabled rather than crashing the screen.
 *
 * The pure list operations (upsert/remove) are exported separately from the
 * localStorage read/write so the save-and-overwrite logic can be unit tested
 * without touching storage at all.
 */

const KEY = 'vfw.reports.savedFilters';

export interface SavedFilter {
  name: string;
  reportKey: string;
  period: Period;
  savedAt: string;
}

function isPeriod(v: unknown): v is Period {
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => x === undefined || typeof x === 'string',
  );
}

function isSavedFilter(v: unknown): v is SavedFilter {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.name === 'string' && f.name.length > 0 &&
    typeof f.reportKey === 'string' && f.reportKey.length > 0 &&
    typeof f.savedAt === 'string' &&
    isPeriod(f.period)
  );
}

/**
 * Add or overwrite (by name — the simplest, least surprising collision rule)
 * a saved filter. Pure: takes the current list, returns the next one. Kept
 * free of localStorage so it can be tested as plain data in/data out.
 */
export function upsertSavedFilter(
  list: SavedFilter[],
  name: string,
  reportKey: string,
  period: Period,
): SavedFilter[] {
  const trimmed = name.trim();
  const next = list.filter((f) => f.name !== trimmed);
  next.push({ name: trimmed, reportKey, period, savedAt: new Date().toISOString() });
  next.sort((a, b) => a.name.localeCompare(b.name));
  return next;
}

/** Pure: drop the saved filter with this name, if any. */
export function removeSavedFilter(list: SavedFilter[], name: string): SavedFilter[] {
  return list.filter((f) => f.name !== name);
}

/**
 * Whether a saved filter still points at something real. The only thing that
 * can go stale under a client-only save is the report type — an admin can
 * retire one from the catalog after it was saved — so that is the one check
 * this makes; period fields (event/city ids) are left to the report query
 * itself, which already renders an empty table rather than erroring on an
 * id that no longer exists.
 */
export function isSavedFilterValid(filter: SavedFilter, validReportKeys: readonly string[]): boolean {
  return validReportKeys.includes(filter.reportKey);
}

/** Reads the saved list from localStorage. Never throws — a corrupted or
 *  hand-edited value is treated as "no saved filters" rather than crashing
 *  the Reports screen on mount. */
export function loadSavedFilters(): SavedFilter[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedFilter);
  } catch {
    return [];
  }
}

export function persistSavedFilters(list: SavedFilter[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}
