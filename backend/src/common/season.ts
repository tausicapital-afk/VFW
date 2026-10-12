import { BadRequestException } from '@nestjs/common';

/**
 * "Spring/Summer 27" -> { initials: "SS", year: "27" }. Shared by show ids
 * (AdminService.eventId), Season create/update, and a season typed on a new
 * submission, so a season is rejected at the moment it is added to the
 * catalogue rather than the moment someone tries to build a show out of it.
 */
export function seasonParts(season: string): { initials: string; year: string } {
  const year = season.match(/(\d{2,4})\s*$/)?.[1]?.slice(-2) ?? '';
  const initials = season
    .replace(/\d+/g, '')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  if (!initials || !year) {
    throw new BadRequestException(
      'Season must look like "Spring/Summer 27" or "Fall/Winter 26" — initials followed by a year',
    );
  }
  return { initials, year };
}

/**
 * What two spellings of the same season have in common, so "fall-Winter 27",
 * "Fall/Winter 2027" and "FW27" all compare equal to "Fall/Winter 27". Case,
 * punctuation and a four-digit year are ignored; a word of one or two letters
 * counts in full (the "FW" in "FW27"), a longer word by its initial. Null when
 * the text has no year or no letters, i.e. nothing worth comparing.
 *
 * Mirrored in frontend/src/lib/season.ts, which uses it to suggest an existing
 * season while the rep types; this copy is the one that decides.
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
