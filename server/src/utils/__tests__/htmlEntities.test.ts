import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities, decodeHtmlEntitiesOrNull } from '../htmlEntities.js';

describe('decodeHtmlEntities', () => {
  it('leaves entity-free text untouched', () => {
    expect(decodeHtmlEntities('Breathing Air System Inspection - Primary'))
      .toBe('Breathing Air System Inspection - Primary');
    expect(decodeHtmlEntities('')).toBe('');
  });

  it('decodes the named entities QuickBooks emits', () => {
    expect(decodeHtmlEntities('PEC Safeland &amp; H2S')).toBe('PEC Safeland & H2S');
    expect(decodeHtmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeHtmlEntities('6&quot; hose')).toBe('6" hose');
  });

  // The whole reason this module exists: QB emits WINDOWS-1252 code points as
  // numeric refs. Decoding 151 as Unicode gives U+0097, an invisible control
  // character — strictly worse than leaving the entity visible.
  it('remaps CP1252 punctuation instead of emitting control characters', () => {
    expect(decodeHtmlEntities('Inspection &#151; Primary')).toBe('Inspection — Primary');
    expect(decodeHtmlEntities('Inspection &#150; Additional')).toBe('Inspection – Additional');
    expect(decodeHtmlEntities('Scott&#153;')).toBe('Scott™');
    expect(decodeHtmlEntities('6&#148;')).toBe('6”');

    // None of the above may leave a C1 control character behind.
    const decoded = decodeHtmlEntities('a&#151;b&#150;c&#153;d&#148;e');
    expect(decoded).not.toMatch(/[\u0080-\u009F]/);
  });

  it('passes through numeric refs that are already valid Unicode', () => {
    expect(decodeHtmlEntities('Nomex&#174;')).toBe('Nomex®');
    expect(decodeHtmlEntities('&#65;&#66;')).toBe('AB');
    expect(decodeHtmlEntities('&#x41;&#x42;')).toBe('AB');
  });

  it('decodes in a single pass, so an escaped entity is not double-decoded', () => {
    // "&amp;#151;" is a literal "&#151;" — it must NOT become an em dash.
    expect(decodeHtmlEntities('&amp;#151;')).toBe('&#151;');
  });

  it('leaves anything it has no mapping for visible rather than dropping it', () => {
    expect(decodeHtmlEntities('50 &pound; load')).toBe('50 &pound; load');
    expect(decodeHtmlEntities('&#129;')).toBe('&#129;');      // unassigned CP1252 slot
    expect(decodeHtmlEntities('&#xD800;')).toBe('&#xD800;');  // lone surrogate
    expect(decodeHtmlEntities('&#99999999;')).toBe('&#99999999;');
    expect(decodeHtmlEntities('bare & ampersand')).toBe('bare & ampersand');
  });

  it('is idempotent, so the backfill can be re-run safely', () => {
    const once = decodeHtmlEntities('PEC Safeland &amp; H2S &#151; Spanish');
    expect(decodeHtmlEntities(once)).toBe(once);
    expect(once).toBe('PEC Safeland & H2S — Spanish');
  });

  it('handles the real catalog strings this was written for', () => {
    expect(decodeHtmlEntities('Breathing Air System Inspection &#151; Primary'))
      .toBe('Breathing Air System Inspection — Primary');
    expect(decodeHtmlEntities('Breathing Air System Inspection &#151; Additional (each)'))
      .toBe('Breathing Air System Inspection — Additional (each)');
    expect(decodeHtmlEntities('Field Services &#151; Labor (Technician)'))
      .toBe('Field Services — Labor (Technician)');
  });
});

describe('decodeHtmlEntitiesOrNull', () => {
  it('passes null and undefined through', () => {
    expect(decodeHtmlEntitiesOrNull(null)).toBeNull();
    expect(decodeHtmlEntitiesOrNull(undefined)).toBeNull();
  });

  it('decodes a present value', () => {
    expect(decodeHtmlEntitiesOrNull('a &#151; b')).toBe('a — b');
  });
});
