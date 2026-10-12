import { describe, expect, it } from 'vitest';
import { matchSeason, seasonKey } from './season';

const SEASONS = [
  { id: 's1', label: 'Fall/Winter 27' },
  { id: 's2', label: 'Spring/Summer 28' },
];

describe('seasonKey', () => {
  it('treats different spellings of one season alike', () => {
    expect(seasonKey('Fall/Winter 27')).toBe('fw27');
    expect(seasonKey('fall-Winter 27')).toBe('fw27');
    expect(seasonKey('Fall Winter 2027')).toBe('fw27');
    expect(seasonKey('FW27')).toBe('fw27');
  });

  it('has nothing to compare without a year', () => {
    expect(seasonKey('Fall/Winter')).toBeNull();
  });
});

describe('matchSeason', () => {
  it('takes an exact name regardless of case', () => {
    expect(matchSeason('fall/winter 27', SEASONS)).toEqual({ kind: 'existing', season: SEASONS[0] });
  });

  it('suggests the existing season for a different spelling', () => {
    expect(matchSeason('fall-Winter 2027', SEASONS)).toEqual({ kind: 'similar', seasons: [SEASONS[0]] });
  });

  it('calls a genuinely new season new', () => {
    expect(matchSeason('Fall/Winter 28', SEASONS)).toEqual({ kind: 'new', valid: true });
    expect(matchSeason('Winter', SEASONS)).toEqual({ kind: 'new', valid: false });
  });
});
