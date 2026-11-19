import { describe, expect, it } from 'vitest';
import { mergeManualRentalEquipment, applyManualEquipmentVisit } from './manualRentalEquipment.js';

const entry = { id: 'gear-1', serial: 'ABC-001', type: 'Trailer', testDate: '10/01/2026', deployedAt: '2026-10-08T14:00:00Z' };
describe('temporary rental equipment capture', () => {
  it('preserves dispatch pricing and other deployment entries on retry', () => {
    const original = { trailer: { manned: true, rate: 300 }, manualEquipment: [{ ...entry, id: 'gear-2' }] };
    const result = mergeManualRentalEquipment(original, [entry]);
    expect(result.trailer).toEqual(original.trailer);
    expect(result.manualEquipment).toHaveLength(2);
    expect(mergeManualRentalEquipment(result, [entry])).toEqual(result);
    expect(original.manualEquipment).toHaveLength(1);
  });
  it('accepts free-text types, serials and test dates without inventory lookups', () => {
    const result = mergeManualRentalEquipment(null, [{ ...entry, type: 'Custom setup', testDate: '10/2026 — see tag' }]);
    expect(result.manualEquipment[0].testDate).toBe('10/2026 — see tag');
  });
  it('rejects incomplete records and duplicate IDs', () => {
    expect(() => mergeManualRentalEquipment({}, [{ ...entry, serial: ' ' }])).toThrow('Enter Serial');
    expect(() => mergeManualRentalEquipment({}, [entry, entry])).toThrow('Duplicate');
  });
});

const inspection = { overallCondition: 'good', physicalDamage: false, cleanlinessOk: true, calibrationCurrent: true, accessoriesReturned: true };
const visit = { workType: 'rental_return' as const, selections: [{ itemId: entry.id, expected: entry }], serviceDate: '2026-10-08', requestId: 'visit', inspection, userId: 'tech' };
describe('manual rental visits', () => {
  it('replaces only selected text while preserving row identity, deployment and pricing', () => {
    const original = { trailer: { rate: 300 }, manualEquipment: [entry, { ...entry, id: 'other' }] };
    const result = applyManualEquipmentVisit(original, { ...visit, workType: 'rental_swap', selections: [{ itemId: entry.id, expected: entry, replacement: { serial: 'NEW', type: 'Custom', testDate: 'see tag' } }] });
    expect(result.composition.manualEquipment[0]).toMatchObject({ id: entry.id, deployedAt: entry.deployedAt, serial: 'NEW', type: 'Custom', testDate: 'see tag' });
    expect(result.composition.manualEquipment[1]).toEqual(original.manualEquipment[1]);
    expect(result.composition.trailer).toEqual(original.trailer);
    expect(result.records[0].before).toEqual(entry);
    expect(original.manualEquipment[0].serial).toBe('ABC-001');
    // A stale deploy retry cannot resurrect an outgoing serial or returned row.
    expect(mergeManualRentalEquipment(result.composition, [entry])).toEqual(result.composition);
  });
  it('returns a selected batch using one inspection reference, preserving unselected rows', () => {
    const result = applyManualEquipmentVisit({ manualEquipment: [entry, { ...entry, id: 'second' }, { ...entry, id: 'third' }] }, {
      ...visit, selections: [{ itemId: entry.id }, { itemId: 'second' }],
    });
    expect(result.composition.manualEquipment.slice(0, 2).map(row => row.returnInspectionId)).toEqual(['visit', 'visit']);
    expect(result.composition.manualEquipment[2].status).toBeUndefined();
    expect(result.allReturned).toBe(false);
    expect(applyManualEquipmentVisit(result.composition, { ...visit, selections: [{ itemId: 'third' }] }).allReturned).toBe(true);
    expect(mergeManualRentalEquipment(result.composition, [entry])).toEqual(result.composition);
  });
  it('keeps a separate condition for each item in a mixed return batch', () => {
    const result = applyManualEquipmentVisit({ manualEquipment: [entry, { ...entry, id: 'damaged', serial: 'BAD' }] }, {
      ...visit, inspection: undefined, selections: [
        { itemId: entry.id, inspection },
        { itemId: 'damaged', inspection: { ...inspection, overallCondition: 'needs_repair', physicalDamage: true } },
      ],
    });
    expect(result.records.map(row => row.inspection.overallCondition)).toEqual(['good', 'needs_repair']);
    expect(result.allReturned).toBe(true);
  });
  it('rejects stale, duplicate, missing, already returned and backdated selections', () => {
    const original = { manualEquipment: [entry] };
    expect(() => applyManualEquipmentVisit(original, { ...visit, selections: [{ itemId: entry.id, expected: { ...entry, serial: 'stale' } }] })).toThrow('Equipment changed');
    expect(() => applyManualEquipmentVisit(original, { ...visit, selections: [{ itemId: entry.id }, { itemId: entry.id }] })).toThrow('unique');
    expect(() => applyManualEquipmentVisit(original, { ...visit, selections: [{ itemId: 'missing' }] })).toThrow('no longer deployed');
    expect(() => applyManualEquipmentVisit({ manualEquipment: [{ ...entry, status: 'returned' }] }, visit)).toThrow('no longer deployed');
    expect(() => applyManualEquipmentVisit(original, { ...visit, serviceDate: '2026-10-07' })).toThrow('Visit date');
    expect(() => applyManualEquipmentVisit(original, { ...visit, inspection: null })).toThrow('an inspection');
    expect(() => applyManualEquipmentVisit(original, { ...visit, workType: 'rental_swap', selections: [{ itemId: entry.id, replacement: { serial: '', type: 'x', testDate: 'x' } }] })).toThrow('Enter Serial');
  });
});
