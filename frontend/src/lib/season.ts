import type { Season } from './types';

/**
 * What two spellings of the same season have in common, so "fall-Winter 27",
 * "Fall/Winter 2027" and "FW27" all compare equal to "Fall/Winter 27". A mirror
 * of backend/src/common/season.ts — this copy only drives the suggestion on the
 * form; the server makes the same check and its answer is the one that counts.
 */
export function seasonKey(label: string): string | null {
  const year = label.match(/(\d{2,4})\s*$/)?.[1]?.slice(-2);
  const initials = label
    .replace(/\d+/g, ' ')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w : w[0]!))
    .join('')
    .toLowerCase();
  if (!year || !initials) return null;
  return initials + year;
}

export type SeasonMatch =
  | { kind: 'empty' }
  /** Typed exactly as a season in the list (case aside). */
  | { kind: 'existing'; season: Season }
  /** A different spelling of one or more seasons already in the list. */
  | { kind: 'similar'; seasons: Season[] }
  /** Nothing like it in the list; it would be added. */
  | { kind: 'new'; valid: boolean };

export function matchSeason(typed: string, seasons: Season[]): SeasonMatch {
  const t = typed.trim();
  if (!t) return { kind: 'empty' };
  const exact = seasons.find((s) => s.label.toLowerCase() === t.toLowerCase());
  if (exact) return { kind: 'existing', season: exact };
  const key = seasonKey(t);
  if (!key) return { kind: 'new', valid: false };
  const similar = seasons.filter((s) => seasonKey(s.label) === key);
  return similar.length ? { kind: 'similar', seasons: similar } : { kind: 'new', valid: true };
}
