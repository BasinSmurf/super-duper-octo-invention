import { describe, it, expect } from 'vitest';
import { normalizeWellName, wellNameBase } from './wellDmrMatch.js';

describe('normalizeWellName', () => {
  // The state's own data is not clean — these are real NDIC strings.
  it('collapses the double spaces NDIC ships', () => {
    expect(normalizeWellName('FBIR LAWRENCE  24X-26A')).toBe('FBIR LAWRENCE 24X-26A');
    expect(normalizeWellName('FBIR BAKER   34X-25')).toBe('FBIR BAKER 34X-25');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeWellName('  FBIR WALKER 31X-36D  ')).toBe('FBIR WALKER 31X-36D');
  });

  it('flattens tabs and newlines, not just spaces', () => {
    expect(normalizeWellName('FBIR\tWALKER\n31X-36D')).toBe('FBIR WALKER 31X-36D');
  });

  // Lettering is authoritative and must survive untouched — the whole point
  // is that 31X-36DXA and 31X36DX2 are different claims about reality.
  it('leaves lettering, case and punctuation alone', () => {
    expect(normalizeWellName('FBIR YELLOWWOLF 31X-10DXA')).toBe('FBIR YELLOWWOLF 31X-10DXA');
    expect(normalizeWellName('J.H. SKARPHOL 1-31H')).toBe('J.H. SKARPHOL 1-31H');
    expect(normalizeWellName('Hellickson Paluck 2-25H')).toBe('Hellickson Paluck 2-25H');
  });

  it('is idempotent', () => {
    const once = normalizeWellName('FBIR LAWRENCE  24X-26A');
    expect(normalizeWellName(once)).toBe(once);
  });

  it('returns null for nothing-there, so a blank DMR name never blanks a well', () => {
    expect(normalizeWellName(null)).toBeNull();
    expect(normalizeWellName(undefined)).toBeNull();
    expect(normalizeWellName('')).toBeNull();
    expect(normalizeWellName('   ')).toBeNull();
  });
});

describe('wellNameBase over normalized names', () => {
  it('strips the well designation to the lease/family name', () => {
    expect(wellNameBase('FBIR WALKER 31X-36DXA')).toBe('FBIR WALKER');
    expect(wellNameBase('FBIR YELLOWWOLF 31X-10DXA')).toBe('FBIR YELLOWWOLF');
    expect(wellNameBase('FBIR YOUNGBEAR 31X-9B')).toBe('FBIR YOUNGBEAR');
  });

  // Normalizing first is what makes the base stable: the double-spaced form
  // used to leave a trailing space behind on the base.
  it('agrees for the spaced and unspaced forms of the same name', () => {
    const messy = normalizeWellName('FBIR LAWRENCE  24X-26A');
    expect(wellNameBase(messy)).toBe(wellNameBase('FBIR LAWRENCE 24X-26A'));
    expect(wellNameBase(messy)).toBe('FBIR LAWRENCE');
  });

  it('falls back to the whole name when there is no designation to strip', () => {
    expect(wellNameBase('ARNEGARD STATE')).toBe('ARNEGARD STATE');
  });

  it('returns empty string for no name', () => {
    expect(wellNameBase(null)).toBe('');
  });
});
