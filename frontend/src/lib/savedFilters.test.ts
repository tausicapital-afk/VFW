import { beforeEach, describe, expect, it } from 'vitest';
import {
  isSavedFilterValid,
  loadSavedFilters,
  persistSavedFilters,
  removeSavedFilter,
  upsertSavedFilter,
  type SavedFilter,
} from './savedFilters';

/**
 * The saved-filters logic behind Reports' "pin a filter set" feature. Pinned
 * here: saving under a name that already exists overwrites rather than
 * duplicating, the list survives a reload via localStorage, and a saved
 * filter whose report type has since been removed is reported invalid
 * instead of applied blindly — the three things the localStorage-only
 * design (see the module doc) depends on to never crash Reports.
 */

describe('upsertSavedFilter', () => {
  it('adds a new saved filter', () => {
    const next = upsertSavedFilter([], 'Vancouver Q3', 'revenue', { cityId: 'van' });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: 'Vancouver Q3', reportKey: 'revenue', period: { cityId: 'van' } });
    expect(next[0].savedAt).toEqual(expect.any(String));
  });

  it('overwrites, rather than duplicates, a save under an existing name', () => {
    const first = upsertSavedFilter([], 'This quarter', 'revenue', { cityId: 'van' });
    const second = upsertSavedFilter(first, 'This quarter', 'commissions', { cityId: 'tor' });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ reportKey: 'commissions', period: { cityId: 'tor' } });
  });

  it('trims the name before saving and matching', () => {
    const first = upsertSavedFilter([], '  Padded  ', 'revenue', {});
    expect(first[0].name).toBe('Padded');
    const second = upsertSavedFilter(first, 'Padded', 'commissions', {});
    expect(second).toHaveLength(1);
  });

  it('leaves other saved filters untouched', () => {
    const list = upsertSavedFilter(
      upsertSavedFilter([], 'A', 'revenue', {}),
      'B',
      'commissions',
      {},
    );
    const next = upsertSavedFilter(list, 'A', 'payroll', {});
    expect(next.find((f) => f.name === 'B')).toMatchObject({ reportKey: 'commissions' });
    expect(next.find((f) => f.name === 'A')).toMatchObject({ reportKey: 'payroll' });
  });
});

describe('removeSavedFilter', () => {
  it('drops the named filter and keeps the rest', () => {
    const list: SavedFilter[] = [
      { name: 'A', reportKey: 'revenue', period: {}, savedAt: '2026-01-01' },
      { name: 'B', reportKey: 'commissions', period: {}, savedAt: '2026-01-01' },
    ];
    expect(removeSavedFilter(list, 'A')).toEqual([list[1]]);
  });

  it('is a no-op when the name is not saved', () => {
    const list: SavedFilter[] = [{ name: 'A', reportKey: 'revenue', period: {}, savedAt: '2026-01-01' }];
    expect(removeSavedFilter(list, 'Missing')).toEqual(list);
  });
});

describe('isSavedFilterValid', () => {
  it('is valid when the report key is still in the catalog', () => {
    const f: SavedFilter = { name: 'A', reportKey: 'revenue', period: {}, savedAt: '2026-01-01' };
    expect(isSavedFilterValid(f, ['revenue', 'commissions'])).toBe(true);
  });

  it('is invalid once the report type has been retired', () => {
    const f: SavedFilter = { name: 'A', reportKey: 'discontinued', period: {}, savedAt: '2026-01-01' };
    expect(isSavedFilterValid(f, ['revenue', 'commissions'])).toBe(false);
  });
});

describe('localStorage read/write', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a saved list through localStorage', () => {
    const list = upsertSavedFilter([], 'Vancouver Q3', 'revenue', { cityId: 'van' });
    persistSavedFilters(list);
    expect(loadSavedFilters()).toEqual(list);
  });

  it('returns an empty list when nothing has been saved yet', () => {
    expect(loadSavedFilters()).toEqual([]);
  });

  it('drops a hand-edited entry missing required fields instead of crashing', () => {
    localStorage.setItem(
      'vfw.reports.savedFilters',
      JSON.stringify([{ name: 'Broken' }, { name: 'OK', reportKey: 'revenue', period: {}, savedAt: 'x' }]),
    );
    expect(loadSavedFilters()).toEqual([{ name: 'OK', reportKey: 'revenue', period: {}, savedAt: 'x' }]);
  });

  it('treats non-JSON garbage in the key as no saved filters', () => {
    localStorage.setItem('vfw.reports.savedFilters', '{not json');
    expect(loadSavedFilters()).toEqual([]);
  });

  it('treats a JSON value that is not an array as no saved filters', () => {
    localStorage.setItem('vfw.reports.savedFilters', JSON.stringify({ name: 'not-a-list' }));
    expect(loadSavedFilters()).toEqual([]);
  });
});
