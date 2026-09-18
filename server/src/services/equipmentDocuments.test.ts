/**
 * The BlueLion docType vocabulary, as ServicePRO maps onto it.
 *
 * This is a CLOSED enum on BlueLion's side, global to the instance — an unknown
 * value is rejected, not stored. So the interesting claims are about the edges:
 * that the five mapped attachment kinds land on the agreed types, and that the
 * kinds with no agreed type are still not guessed at. Filing a record under a
 * plausible-sounding neighbour would put a permanent mislabel in an immutable
 * ledger, which is strictly worse than not filing it.
 */

import { describe, it, expect } from 'vitest';
import {
  blueLionDocType,
  blueLionDocTypeForAttachmentKind,
  BLUELION_PUSHABLE_ATTACHMENT_KINDS,
} from './equipmentDocuments.js';

describe('attachment kind → BlueLion docType', () => {
  it.each([
    ['ue_report', 'ultrasonic_exam'],
    ['photo', 'condition_photo'],
    // flow_test, NOT posi_check: Posi-Check is one vendor's instrument, and a
    // record type outlives the brand of the box in the shop.
    ['pozi_report', 'flow_test'],
    ['test_paperwork', 'test_paperwork'],
  ])('%s → %s', (kind, docType) => {
    expect(blueLionDocTypeForAttachmentKind(kind)).toBe(docType);
  });

  it.each(['packing_slip', 'signature', 'document', 'other', 'not_a_kind'])(
    'leaves %s unmapped rather than guessing',
    (kind) => {
      expect(blueLionDocTypeForAttachmentKind(kind)).toBeUndefined();
    },
  );

  it('does NOT push vendor invoices, though BlueLion has a docType for them', () => {
    // Max's call 2026-09-01. The Vault is the unit's condition history; a
    // vendor invoice is what Basin paid, which is not condition. The service
    // record already says an outside repair happened and what was done.
    expect(blueLionDocTypeForAttachmentKind('vendor_invoice')).toBeUndefined();
    expect(BLUELION_PUSHABLE_ATTACHMENT_KINDS).not.toContain('vendor_invoice');
  });

  it('exposes exactly the mapped kinds for the backfill drain', () => {
    expect([...BLUELION_PUSHABLE_ATTACHMENT_KINDS].sort()).toEqual(
      ['photo', 'pozi_report', 'test_paperwork', 'ue_report'],
    );
  });
});

describe('EquipmentDocument docType → BlueLion docType', () => {
  it('maps the two that have agreed homes', () => {
    expect(blueLionDocType('ultrasonic_exam')).toBe('ultrasonic_exam');
    expect(blueLionDocType('condemnation')).toBe('condemnation');
  });

  it('does NOT file a hydrostatic test under flow_test or test_paperwork', () => {
    // A hydro is a pressure test of a cylinder — neither a flow check nor
    // paperwork. There is no seventh docType yet; asking for one is the fix.
    expect(blueLionDocType('hydrostatic_test')).toBeUndefined();
    expect(blueLionDocType('other')).toBeUndefined();
  });
});
