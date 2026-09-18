import { describe, it, expect } from 'vitest';
import { normalizeApi, dedupeBatch, type DmrUpsertRow } from './dmrBulkUpsert.js';

/**
 * The DMR reference table is keyed on API number, and keeping it that way is
 * what stops every re-import from stacking a second copy of all ~60k wells.
 * Three things have to hold, and none of them was covered by a test:
 *
 *   1. normalizeApi collapses every format ND ships to ONE canonical key.
 *      DMR CSVs carry dashed 10-digit APIs, the OGD shapefile carries bare
 *      14-digit ones. If those don't normalize to the same string they are
 *      two different rows in a table whose uniqueness is api_number.
 *
 *   2. dedupeBatch collapses rows sharing a key WITHIN one file, because
 *      Postgres refuses `ON CONFLICT DO UPDATE` twice on one row in a single
 *      multi-row INSERT.
 *
 *   3. Merging keeps what it already had. A sparse pull (no lat/long column)
 *      must fill gaps, never blank out a richer earlier import.
 */

function row(over: Partial<DmrUpsertRow> & { apiNumber: string }): DmrUpsertRow {
  return {
    dmrFileNumber: null, apiShort: null, operatorName: null, wellName: null,
    wellNameBase: null, totalDepth: null, spudDate: null, fieldName: null,
    quarterQuarter: null, section: null, township: null, range: null,
    feetNs: null, nsLine: null, feetEw: null, ewLine: null,
    latitude: null, longitude: null, wellType: null, wellStatus: null,
    county: null, symbol: null, rawData: null,
    importBatchDate: new Date('2026-09-08T00:00:00Z'),
    ...over,
  };
}

describe('normalizeApi — one canonical key per physical well', () => {
  it('collapses the formats ND actually ships to the same 14-digit key', () => {
    // A dashed 10-digit DMR CSV value and the bare 14-digit OGD value are the
    // SAME well. If these ever diverge, one re-import doubles the table.
    const expected = '33053012340000';
    expect(normalizeApi('33-053-01234')).toBe(expected);
    expect(normalizeApi('3305301234')).toBe(expected);
    expect(normalizeApi('33053012340000')).toBe(expected);
    expect(normalizeApi(' 33-053-01234 ')).toBe(expected);
    expect(normalizeApi('33/053/01234')).toBe(expected);
  });

  it('right-pads 10-to-13 digit forms rather than truncating anything', () => {
    expect(normalizeApi('3305301234')).toBe('33053012340000');      // 10 → 14
    expect(normalizeApi('330530123400')).toBe('33053012340000');    // 12 → 14
    expect(normalizeApi('3305301234000')).toBe('33053012340000');   // 13 → 14
  });

  it('leaves an already-14-digit key untouched', () => {
    expect(normalizeApi('33053012340001')).toBe('33053012340001');
  });

  it('does NOT pad a value shorter than 10 digits into a plausible key', () => {
    // Padding a 5-digit fragment to 14 would mint a confident-looking key for
    // a value that isn't an API number, and collide unrelated wells onto it.
    expect(normalizeApi('12345')).toBe('12345');
    expect(normalizeApi('33053')).toBe('33053');
  });

  it('returns null for anything with no digits at all', () => {
    for (const junk of [null, undefined, '', '   ', 'N/A', '--', 'unknown']) {
      expect(normalizeApi(junk)).toBeNull();
    }
  });

  it('keeps genuinely different wells apart', () => {
    // Same operator, adjacent APIs — must not normalize together.
    expect(normalizeApi('33-053-01234')).not.toBe(normalizeApi('33-053-01235'));
  });
});

describe('dedupeBatch — one row per key inside a single file', () => {
  it('collapses duplicate keys and reports how many it merged', () => {
    const out = dedupeBatch([
      row({ apiNumber: 'A', wellName: 'FIRST' }),
      row({ apiNumber: 'A', wellName: 'SECOND' }),
      row({ apiNumber: 'B', wellName: 'OTHER' }),
    ]);
    expect(out.rows).toHaveLength(2);
    expect(out.mergedInFile).toBe(1);
  });

  it('lets a later non-null value win', () => {
    const out = dedupeBatch([
      row({ apiNumber: 'A', wellName: 'OLD NAME', operatorName: 'CONTINENTAL' }),
      row({ apiNumber: 'A', wellName: 'NEW NAME' }),
    ]);
    expect(out.rows[0]!.wellName).toBe('NEW NAME');
  });

  it('does NOT let a later null blank out a value already collected', () => {
    // This is the merge-not-clobber rule, in-file. A second sparse row for the
    // same well must fill gaps, never erase the richer first one.
    const out = dedupeBatch([
      row({ apiNumber: 'A', operatorName: 'CONTINENTAL', latitude: 48.1, longitude: -103.2 }),
      row({ apiNumber: 'A', wellName: 'SOME WELL 1-2H' }),
    ]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      operatorName: 'CONTINENTAL',
      latitude: 48.1,
      longitude: -103.2,
      wellName: 'SOME WELL 1-2H',
    });
  });

  it('merges across more than two rows for one key', () => {
    const out = dedupeBatch([
      row({ apiNumber: 'A', operatorName: 'CHORD' }),
      row({ apiNumber: 'A', wellName: 'W 1' }),
      row({ apiNumber: 'A', county: 'MCKENZIE' }),
      row({ apiNumber: 'A', wellStatus: 'A' }),
    ]);
    expect(out.rows).toHaveLength(1);
    expect(out.mergedInFile).toBe(3);
    expect(out.rows[0]).toMatchObject({
      operatorName: 'CHORD', wellName: 'W 1', county: 'MCKENZIE', wellStatus: 'A',
    });
  });

  it('passes a clean batch through untouched', () => {
    const rows = [row({ apiNumber: 'A' }), row({ apiNumber: 'B' }), row({ apiNumber: 'C' })];
    const out = dedupeBatch(rows);
    expect(out.rows).toHaveLength(3);
    expect(out.mergedInFile).toBe(0);
  });

  it('handles an empty batch', () => {
    expect(dedupeBatch([])).toEqual({ rows: [], mergedInFile: 0 });
  });
});

describe('normalizeApi + dedupeBatch together — the actual re-import guarantee', () => {
  it('collapses the same well arriving in two formats into one row', () => {
    // The scenario the user asked to be sure of: a DMR CSV row and an OGD row
    // for one physical well, in one upload, must produce ONE reference well.
    const fromCsv = normalizeApi('33-053-01234')!;
    const fromOgd = normalizeApi('33053012340000')!;
    expect(fromCsv).toBe(fromOgd);

    const out = dedupeBatch([
      row({ apiNumber: fromCsv, operatorName: 'CONTINENTAL RESOURCES', wellName: 'BURLINGTON 1-2H' }),
      row({ apiNumber: fromOgd, latitude: 48.12, longitude: -103.25, county: 'WILLIAMS' }),
    ]);

    expect(out.rows).toHaveLength(1);
    expect(out.mergedInFile).toBe(1);
    // And it kept everything from both.
    expect(out.rows[0]).toMatchObject({
      apiNumber: '33053012340000',
      operatorName: 'CONTINENTAL RESOURCES',
      wellName: 'BURLINGTON 1-2H',
      latitude: 48.12,
      longitude: -103.25,
      county: 'WILLIAMS',
    });
  });
});
