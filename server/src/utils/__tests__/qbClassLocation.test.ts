// The two things QB invoices were missing: header CLASS and header LOCATION.
//
// CLASS comes from the division, and the wizard only asks for one on the
// field-service step — so these tests pin the derivation that keeps IH / shop /
// rental work from pushing classless. LOCATION is the <Other> field, capped at
// 29 chars by QB.

import { describe, it, expect } from 'vitest';
import { resolveQbClassFullName, defaultDivisionForWork, SERVICE_DIVISIONS, isServiceDivision } from '../qbClass.js';
import { qbLocationLabel, truncateQbOther, QB_OTHER_MAX_LEN } from '../qbLocation.js';
import {
  divisionLaborPartNumber, divisionMileagePartNumber, parsePartNumber, divisionNumber,
} from '../partNumber.js';

describe('defaultDivisionForWork', () => {
  it('derives the division for work types the wizard never asks about', () => {
    // IH testing rides on `inspection` tickets — field safety service.
    expect(defaultDivisionForWork({ ticketType: 'inspection', serviceSubtype: 'ih_h2s' })).toBe('D3');
    // Shop + FEX work.
    expect(defaultDivisionForWork({ ticketType: 'repair', serviceSubtype: null })).toBe('D6');
    expect(defaultDivisionForWork({ ticketType: 'field_service', serviceSubtype: 'inspection' })).toBe('D6');
    // In-shop air fill bills as safety service (ADR-0017), not FEX.
    expect(defaultDivisionForWork({ ticketType: 'field_service', serviceSubtype: 'air_fill' })).toBe('D3');
    expect(defaultDivisionForWork({ ticketType: 'field_service', serviceSubtype: 'shop_repair' })).toBe('D6');
    expect(defaultDivisionForWork({ ticketType: 'rental', serviceSubtype: null })).toBe('D4');
    // Legacy field-service tickets from before the picker was mandatory.
    expect(defaultDivisionForWork({ ticketType: 'field_service', serviceSubtype: 'gas_detection' })).toBe('D3');
  });

  it('maps the people-and-counter work types QB has classes for', () => {
    expect(defaultDivisionForWork({ ticketType: 'training', serviceSubtype: 'safety_training' })).toBe('D1');
    // Occ Health testing people, however the subtype is spelled.
    expect(defaultDivisionForWork({ ticketType: 'training', serviceSubtype: 'fit_test' })).toBe('D8');
    expect(defaultDivisionForWork({ ticketType: 'inspection', serviceSubtype: 'ih_audiometric' })).toBe('D8');
    expect(defaultDivisionForWork({ ticketType: 'sale', serviceSubtype: null })).toBe('D5');
  });

  it('returns null when the work type says nothing about the division', () => {
    expect(defaultDivisionForWork({})).toBeNull();
    expect(defaultDivisionForWork({ ticketType: 'something_new', serviceSubtype: null })).toBeNull();
  });

  it('every division in the enum has an exact QB Class string', () => {
    // Transcribed from QB's Class list — QB rejects a ClassRef that doesn't
    // match character-for-character (3140), including its own inconsistent
    // plurals and spacing.
    expect(SERVICE_DIVISIONS.map(d => resolveQbClassFullName(d, false))).toEqual([
      'D1 Basin Safety Training',
      'D2 Basin Consulting',
      'D3 Basin Safety Service',
      'D4 Basin On Site Services',
      'D5 Basin Safety Store',
      'D6 - FEX Services',
      'D7 Sky Shield',
      'D8 Occupational Health',
    ]);
    expect(SERVICE_DIVISIONS.map(d => resolveQbClassFullName(d, true))).toEqual([
      'Dickinson:Dickinson1 Training',
      'Dickinson:Dickinson2 Consulting',
      'Dickinson:Dickinson3 Safety Service',
      'Dickinson:Dickinson4 On Site Service',
      'Dickinson:Dickinson5 Store',
      'Dickinson:Dickinson6 FEX',
      // D7 / D8 have no Dickinson child class in QB yet — base class, never an
      // invented "Dickinson7" name that QB would reject.
      'D7 Sky Shield',
      'D8 Occupational Health',
    ]);
  });

  it('resolves nothing for a missing or unknown division', () => {
    expect(resolveQbClassFullName(null, false)).toBeNull();
    expect(resolveQbClassFullName(undefined, true)).toBeNull();
    expect(isServiceDivision('D9')).toBe(false);
    expect(isServiceDivision('D0')).toBe(false);
    expect(isServiceDivision('D8')).toBe(true);
  });

  it('every derived division resolves to a real QB Class string', () => {
    for (const work of [
      { ticketType: 'inspection', serviceSubtype: 'ih_h2s' },
      { ticketType: 'repair', serviceSubtype: null },
      { ticketType: 'rental', serviceSubtype: null },
      { ticketType: 'field_service', serviceSubtype: 'air_fill' },
      { ticketType: 'training', serviceSubtype: 'safety_training' },
      { ticketType: 'training', serviceSubtype: 'fit_test' },
      { ticketType: 'sale', serviceSubtype: null },
    ]) {
      const division = defaultDivisionForWork(work);
      expect(resolveQbClassFullName(division, false)).toBeTruthy();
      expect(resolveQbClassFullName(division, true)).toBeTruthy();
    }
  });
});

describe('qbLocationLabel', () => {
  it('takes the most specific site name, well before pad', () => {
    expect(qbLocationLabel({
      well: { wellName: 'Pronghorn 44-11PH' },
      pad: { name: 'Pronghorn Federal' },
    })).toBe('Pronghorn 44-11PH');
    expect(qbLocationLabel({ well: null, pad: { name: 'Pronghorn Federal' } })).toBe('Pronghorn Federal');
    expect(qbLocationLabel({ facility: { name: 'Tioga CGP' } })).toBe('Tioga CGP');
    expect(qbLocationLabel({ field: { name: 'Nesson' } })).toBe('Nesson');
  });

  it('falls back to the tail of the locationDisplay breadcrumb', () => {
    // Shop / air-fill tickets have no location FKs at all.
    expect(qbLocationLabel({
      locationDisplay: 'Chord Energy LLC > Pronghorn Federal > Pronghorn 44-11PH',
    })).toBe('Pronghorn 44-11PH');
    expect(qbLocationLabel({ locationDisplay: 'Unit 42 — J. Rivera' })).toBe('Unit 42 — J. Rivera');
  });

  it('is null when there is nothing to say', () => {
    expect(qbLocationLabel(null)).toBeNull();
    expect(qbLocationLabel({})).toBeNull();
    expect(qbLocationLabel({ pad: { name: '  ' }, locationDisplay: '' })).toBeNull();
  });

  it('caps at QB max 29 chars', () => {
    const label = qbLocationLabel({ well: { wellName: 'Pronghorn Federal 44-11PH 3BX North Unit' } });
    expect(label).toBe('Pronghorn Federal 44-11PH 3BX');
    expect(label!.length).toBe(QB_OTHER_MAX_LEN);
    expect(truncateQbOther('short')).toBe('short');
  });
});

// ── Division-scoped labor & mileage ─────────────────────────────────────────
// [DIV]00001 is always that division's mileage, [DIV]00002 always its labor —
// the whole point of the 2026 renumber. These pin the number-building and the
// 'D3' → 3 bridge between the QB class division and the parts division, so a
// ticket's division can't resolve to another division's labor rate.
describe('division part numbers follow the ticket division', () => {
  it('bridges the QB class division to the parts division', () => {
    expect(divisionNumber('D3')).toBe(3);
    expect(divisionNumber('D8')).toBe(8);
    expect(divisionNumber(6)).toBe(6);
    expect(divisionNumber(null)).toBeNull();
    expect(divisionNumber(undefined)).toBeNull();
  });

  it('builds each division its own mileage (01) and labor (02) numbers', () => {
    const rows = SERVICE_DIVISIONS.map(d => {
      const n = divisionNumber(d)!;
      return `${d}: ${divisionMileagePartNumber(n)} / ${divisionLaborPartNumber(n)}`;
    });
    expect(rows).toEqual([
      'D1: 0100001 / 0100002',
      'D2: 0200001 / 0200002',
      'D3: 0300001 / 0300002',
      'D4: 0400001 / 0400002',
      'D5: 0500001 / 0500002',
      'D6: 0600001 / 0600002',
      'D7: 0700001 / 0700002',
      'D8: 0800001 / 0800002',
    ]);
  });

  it('every generated pair parses back to its own division', () => {
    for (const d of SERVICE_DIVISIONS) {
      const n = divisionNumber(d)!;
      expect(parsePartNumber(divisionMileagePartNumber(n))?.division).toBe(n);
      expect(parsePartNumber(divisionLaborPartNumber(n))?.division).toBe(n);
    }
  });
});
