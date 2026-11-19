import { describe, expect, it } from 'vitest';
import { rentalInvoiceLineNotes, rentalInvoiceNoteLines } from '../qbRentalNotes.js';
import { buildInvoiceAdd, buildSalesOrderAdd, parseInvoiceDiffResponse } from '../qbxmlBuilder.js';

const d = (date: string) => new Date(`${date}T00:00:00Z`);
const unit = (name: string, serial: string, out: string, back: string | null = null) => ({
  product: { name }, serializedEquipment: { serialNumber: serial },
  deployedDate: d(out), returnedDate: back ? d(back) : null,
});

describe('rental invoice documentation', () => {
  it('includes prior manual deployments and ignores future or non-deployment ticket equipment', () => {
    const manual = { workType: 'rental_deploy', manualEquipment: [{ type: 'Trailer', serial: 'Air Trailer 6', deployedAt: '2026-09-01T21:00:00Z' }] };
    const notes = rentalInvoiceNoteLines(d('2026-09-01'), d('2026-09-30'), [], [
      { serviceDate: d('2026-09-01'), customData: manual },
      { serviceDate: d('2026-10-01'), customData: { ...manual, manualEquipment: [{ serial: 'future' }] } },
      { serviceDate: d('2026-09-01'), customData: { ...manual, workType: 'rental_return' } },
    ]);
    expect(notes).toEqual(['Rental dates: 09/01/2026 to 09/30/2026', 'Equipment: Trailer - Air Trailer 6']);
    expect(rentalInvoiceLineNotes(d('2026-09-01'), d('2026-09-30'), [],
      [{ description: 'Trailer rental package' }], null,
      [{ serviceDate: d('2026-09-01'), customData: manual }]))
      .toEqual([['Trailer #Air Trailer 6']]);
  });

  it('retains swept serial notes only for the same invoice period, and adds newly captured serials', () => {
    const snapshot = { periodStart: '2026-09-01', periodEnd: '2026-09-30', lines: ['Rental dates: old', 'Equipment: Trailer - recorded', 1] };
    expect(rentalInvoiceNoteLines(d('2026-09-01'), d('2026-09-30'), [unit('Monitor', 'new', '2026-09-20')], [], snapshot))
      .toEqual(['Rental dates: 09/01/2026 to 09/30/2026', 'Equipment: Monitor - new', 'Equipment: Trailer - recorded']);
    expect(rentalInvoiceNoteLines(d('2026-10-01'), d('2026-10-31'), [], [], snapshot))
      .toEqual(['Rental dates: 10/01/2026 to 10/31/2026']);
  });


  it('keeps four included monitors under the package and the fifth plus its replacement under overage', () => {
    const monitors = ['1', '2', '3', '4', '5'].map(serial => ({
      ...unit('Monitor', serial, '2026-10-01', serial === '5' ? '2026-10-03' : null),
      id: serial, productId: 'monitor', product: { name: 'Monitor', category: 'area_monitor' },
    }));
    const replacement = { ...unit('Monitor', '6', '2026-10-03'), id: '6', replacesItemId: '5',
      productId: 'monitor', product: { name: 'Monitor', category: 'area_monitor' } };
    expect(rentalInvoiceLineNotes(d('2026-10-01'), d('2026-10-06'), [...monitors, replacement], [
      { description: 'Rental Package', productId: 'package' },
      { description: 'Rental - Additional monitor', productId: 'extra' },
      { description: 'Delivery' },
    ], {
      bomPackage: { label: 'Rental Package', productId: 'package' },
      bom: [{ label: 'Monitors', qty: 4, equipmentCategory: 'area_monitor' }],
      bomExtras: [{ label: 'Additional monitor', qty: 1, productId: 'extra', equipmentCategory: 'area_monitor' }],
    })).toEqual([
      ['Monitor #1', 'Monitor #2', 'Monitor #3', 'Monitor #4'],
      ['Monitor #5', 'Monitor #6'], [],
    ]);
  });

  it('places individual units below their own charges and bundled units below the package', () => {
    const items = [
      { ...unit('Trailer', '4', '2026-09-29'), productId: 'trailer' },
      { ...unit('Monitor', 'SDF$#@%', '2026-09-29'), productId: 'bundled-monitor' },
      { ...unit('BZ1', '006', '2026-09-29'), productId: 'bz1' },
      { ...unit('BZ1', 'old', '2026-09-01', '2026-09-30'), productId: 'bz1' },
    ];
    const lines = [
      { description: 'Delivery' },
      { description: 'BZ1 rental', productId: 'bz1' },
      { description: 'Trailer rental package', productId: 'package' },
    ];
    expect(rentalInvoiceLineNotes(d('2026-10-01'), d('2026-10-06'), items, lines,
      { bomPackage: { label: 'Trailer rental package', productId: 'package' } })).toEqual([
      [], ['BZ1 #006'], ['Monitor #SDF$#@%', 'Trailer #4'],
    ]);
  });

  it('includes period-specific serials, including returned equipment and excluding other periods', () => {
    const notes = rentalInvoiceNoteLines(d('2026-10-01'), d('2026-10-06'), [
      unit('Air trailer', 'ATR-10', '2026-09-29', '2026-10-06'),
      unit('BZ1', '17012VJ-006', '2026-09-29', '2026-10-03'),
      unit('BZ1', 'old', '2026-09-01', '2026-09-30'),
      unit('BZ1', 'future', '2026-10-07'),
      unit('BZ1', '17012VJ-006', '2026-09-29', '2026-10-03'),
    ]);
    expect(notes).toEqual([
      'Rental dates: 10/01/2026 to 10/06/2026',
      'Equipment: Air trailer - ATR-10',
      'Equipment: BZ1 - 17012VJ-006',
    ]);
  });

  it('preserves SafeCore identification and dates even without serialized equipment', () => {
    const item = unit('Monitor', 'asset-1', '2026-09-29');
    expect(rentalInvoiceNoteLines(d('2026-09-29'), d('2026-09-30'), [
      { ...item, serializedEquipment: { serialNumber: 'asset-1', safeCoreSerial: 'serial-1' } },
    ])).toContain('Equipment: Monitor - asset-1 / SafeCore #serial-1');
    expect(rentalInvoiceNoteLines(d('2026-09-29'), d('2026-09-30'), []))
      .toEqual(['Rental dates: 09/29/2026 to 09/30/2026']);
    expect(rentalInvoiceNoteLines(null, null, [item])).toEqual([]);
  });

  it.each([
    ['InvoiceLineAdd', buildInvoiceAdd], ['SalesOrderLineAdd', buildSalesOrderAdd],
  ] as const)('exports %s notes without billing fields or fallback items', (tag, build) => {
    const xml = build({
      customerFullName: 'Customer', txnDate: '2026-10-13', refNumber: 'INV-2026-00111',
      noteLines: ['Rental dates: 10/01/2026 to 10/06/2026'],
      lines: [{ qbItemFullName: '0411003', description: 'Air Trailer - Base Rental (Daily)', quantity: 6, rate: '500', amount: '3000', isTaxable: true,
        noteLines: ['Monitor & trailer #<serial>'] }],
    });
    const rows = [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(match => match[1]);
    expect(rows).toHaveLength(3);
    expect(rows[0].trim()).toBe('<Desc>Rental dates: 10/01/2026 to 10/06/2026</Desc>');
    expect(rows[2].trim()).toBe('<Desc>Monitor &amp; trailer #&lt;serial&gt;</Desc>');
    expect(rows[1]).toContain('<Quantity>6</Quantity>');
    expect(rows[1]).toContain('<Rate>500.00</Rate>');
    expect(rows[1]).toContain('<SalesTaxCodeRef><FullName>Tax</FullName></SalesTaxCodeRef>');
  });

  it('ignores documentation in QB line comparisons while counting zero-priced items and added charges', () => {
    const response = `<InvoiceQueryRs statusCode="0"><InvoiceRet><Subtotal>3000</Subtotal><SalesTaxTotal>150</SalesTaxTotal>
      <InvoiceLineRet><Desc>Rental dates</Desc></InvoiceLineRet>
      <InvoiceLineRet><Desc>Equipment serial</Desc><Amount>0.00</Amount></InvoiceLineRet>
      <InvoiceLineRet><ItemRef><FullName>Rental</FullName></ItemRef><Amount>3000</Amount></InvoiceLineRet>
      <InvoiceLineRet><ItemRef><FullName>Included</FullName></ItemRef><Amount>0</Amount></InvoiceLineRet>
      <InvoiceLineRet><Amount>10</Amount></InvoiceLineRet>
    </InvoiceRet></InvoiceQueryRs>`;
    expect(parseInvoiceDiffResponse(response)).toMatchObject({ qbTotal: 3150, qbLineCount: 3 });
  });
});
