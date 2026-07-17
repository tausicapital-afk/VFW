/**
 * A show carries its season as free text with a trailing year, e.g.
 * "Fall/Winter 26". The intake form shows that text without the year and lets a
 * rep narrow the show list to one of two coarse seasons. Both live here so New
 * and Edit submission stay in step.
 */

/** The two coarse seasons the intake form filters shows by. */
export type SeasonTab = 'SS' | 'FW';

export const SEASON_TABS: { key: SeasonTab; label: string }[] = [
  { key: 'SS', label: 'Summer/Spring' },
  { key: 'FW', label: 'Winter/Fall' },
];

/** Which tab a show belongs to. "Fall/Winter 26" → 'FW', "Spring/Summer 27" → 'SS'. */
export function seasonTab(season: string): SeasonTab {
  return /spring|summer/i.test(season) ? 'SS' : 'FW';
}

/** A show's season for display, without the trailing year. "Fall/Winter 26" → "Fall/Winter". */
export function seasonLabel(season: string): string {
  return season.replace(/\s*\d{2,4}\s*$/, '').trim();
}
