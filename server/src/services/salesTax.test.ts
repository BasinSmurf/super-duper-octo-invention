import { describe, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ prisma: {} }));
import { countyFromTicketLocations } from './salesTax.js';

describe('countyFromTicketLocations', () => {
  it('gives a county-less pad the county its wells agree on (Vihon 44-8H: pad blank, well DUNN)', () => {
    expect(countyFromTicketLocations({ well: null, pad: { county: null, wells: [{ county: 'DUNN' }] } })).toBe('DUNN');
    expect(countyFromTicketLocations({ pad: { county: ' ', wells: [{ county: 'Dunn' }, { county: 'DUNN ' }, { county: null }] } })).toBe('DUNN');
  });
  it('does not guess when the pad\'s wells sit in different counties', () => {
    expect(countyFromTicketLocations({ pad: { county: null, wells: [{ county: 'Dunn' }, { county: 'McKenzie' }] },
      field: { county: 'Williams' } })).toBe('Williams');
    expect(countyFromTicketLocations({ pad: { county: null, wells: [] } })).toBeNull();
  });
  it('keeps the ticket well, then the pad\'s own county, ahead of the pad\'s wells', () => {
    const pad = { county: 'Mountrail', wells: [{ county: 'Dunn' }] };
    expect(countyFromTicketLocations({ well: { county: 'Stark' }, pad })).toBe('Stark');
    expect(countyFromTicketLocations({ well: { county: '' }, pad })).toBe('Mountrail');
  });
});
