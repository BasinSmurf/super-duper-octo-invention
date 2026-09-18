import { describe, it, expect } from 'vitest';
import {
  buildShopBillingLines,
  buildWoExtraLines,
  hydrateShopPartCatalogPrices,
  isBillableShopItem,
  isChargeableShopItem,
  type ShopBillingItem,
} from './shopBillingLines.js';

// Minimal ShopBillingItem factory — only the fields the line builder reads.
function item(overrides: Partial<ShopBillingItem> = {}): ShopBillingItem {
  return {
    id: overrides.id ?? 'i1',
    status: overrides.status ?? 'shop_complete',
    isWarranty: overrides.isWarranty ?? false,
    parentItemId: overrides.parentItemId ?? null,
    serialNumber: overrides.serialNumber ?? 'SN-1',
    equipmentCategory: overrides.equipmentCategory ?? 'fire_extinguisher',
    equipmentDescription: overrides.equipmentDescription ?? null,
    serviceType: overrides.serviceType ?? 'inspection',
    productId: overrides.productId ?? 'p1',
    partsUsed: overrides.partsUsed ?? null,
    billing: overrides.billing ?? null,
    customData: overrides.customData ?? null,
    product: overrides.product ?? { id: 'p1', partNumber: 'FEX-INSP', name: 'FEX Inspection', defaultSellPrice: 25 },
    ...(overrides.hardClosesAt !== undefined ? { hardClosesAt: overrides.hardClosesAt } : {}),
  };
}

describe('isBillableShopItem — WI-05 soft-close gate', () => {
  const HOUR = 3_600_000;

  it('withholds a unit that is still inside its 48-hour correction window', () => {
    // The whole point of the window: an invoice raised against a record the
    // shop is still correcting is worse than one raised two days later.
    const now = new Date('2026-08-28T12:00:00Z');
    const stillOpen = item({ status: 'shop_complete', hardClosesAt: new Date(now.getTime() + HOUR) });
    expect(isBillableShopItem(stillOpen, now)).toBe(false);
  });

  it('bills the unit once the window has shut', () => {
    const now = new Date('2026-08-28T12:00:00Z');
    const closed = item({ status: 'shop_complete', hardClosesAt: new Date(now.getTime() - 1) });
    expect(isBillableShopItem(closed, now)).toBe(true);
  });

  it('bills exactly AT the deadline', () => {
    const now = new Date('2026-08-28T12:00:00Z');
    expect(isBillableShopItem(item({ status: 'returned', hardClosesAt: now }), now)).toBe(true);
  });

  it('bills a unit with no close stamp at all', () => {
    // Pre-feature rows. Failing "safe" here would look cautious and be wrong —
    // it would pull every historical unit OUT of billing.
    expect(isBillableShopItem(item({ status: 'returned', hardClosesAt: null }))).toBe(true);
  });

  it('still refuses warranty units and child components regardless of the window', () => {
    const past = new Date('2020-01-01T00:00:00Z');
    expect(isBillableShopItem(item({ status: 'returned', hardClosesAt: past, isWarranty: true }))).toBe(false);
    expect(isBillableShopItem(item({ status: 'returned', hardClosesAt: past, parentItemId: 'p1' }))).toBe(false);
  });

  it('still refuses a unit that has not reached a terminal state', () => {
    expect(isBillableShopItem(item({ status: 'in_work', hardClosesAt: null }))).toBe(false);
  });
});

describe('buildShopBillingLines', () => {
  it('bills vendor-performed work once under our SKU and selling price, keeping cost off the invoice', () => {
    const unit = { ...item({ billing: {
      services: [{ productId: 'ue', partNumber: 'UE-SERVICE', name: 'UE Test', quantity: 1, rate: 100 }],
      vendor: { mode: 'catalog_service', serviceProductId: 'ue', cost: 50, markupPct: 20, freight: 10 },
    } }), vendorInvoiceTotal: 50, vendorDisposition: 'pass_thru_repair' as const };
    const lines = buildShopBillingLines([unit]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: 'ue', partNumber: 'UE-SERVICE', rate: 100, total: 100 });
    expect(lines[0].description).not.toMatch(/vendor|50/);
  });

  it('refuses a catalog vendor charge whose linked service was removed', () => {
    expect(() => buildShopBillingLines([item({ billing: { vendor: { mode: 'catalog_service', serviceProductId: 'missing', cost: 50 } } })])).toThrow('linked catalog service');
  });

  it('reconciles SW-2026-00146: parts, entered labor, vendor receipt and mileage all bill', () => {
    const unit = { ...item({ serialNumber: 'dsfg', billing: { labor: { hours: 2, rate: 85 } },
      partsUsed: [800, 443, 1].map((unitCost, i) => ({ name: `Sensor ${i}`, quantity: 1, unitCost })) }),
      vendorDisposition: 'pass_thru_repair' as const, vendorInvoiceTotal: 35 };
    const lines = [...buildShopBillingLines([unit]), ...buildWoExtraLines({ mileage: { miles: 7, rate: 1.5 } }, 6)];
    expect(lines.reduce((sum, l) => sum + l.total, 0)).toBe(1459.5);
    expect(lines.filter(l => l.lineType === 'part').reduce((sum, l) => sum + l.total, 0)).toBe(1244);
    expect(lines.filter(l => l.lineType === 'part').every(l => l.serialNumber === 'dsfg' && l.description.includes('used on S/N dsfg'))).toBe(true);
    expect(lines.find(l => l.chargeKind === 'labor')?.total).toBe(170);
    expect(lines.find(l => l.chargeKind === 'vendor')?.total).toBe(35);
  });

  it('charges a selected catalog service once, alongside parts, labor and vendor cost', () => {
    const lines = buildShopBillingLines([{ ...item({ billing: {
      services: [{ productId: 'cal', partNumber: '0631001', name: '4 Gas Calibration', quantity: 1, rate: 35 }],
      labor: { hours: 2, rate: 85 },
    }, partsUsed: [{ name: 'Sensor', quantity: 1, unitCost: 443 }] }), vendorInvoiceTotal: 20 }]);
    expect(lines.reduce((sum, l) => sum + l.total, 0)).toBe(668);
    expect(lines.find(l => l.chargeKind === 'service')).toMatchObject({ productId: 'cal', partNumber: '0631001', lineType: 'labor', total: 35 });
  });

  it('uses the explicit condemn fee instead of charging a second implicit inspection', () => {
    const lines = buildShopBillingLines([item({ status: 'condemned', billing: {
      services: [{ productId: 'disposal', partNumber: '0614002', name: 'Disposal', quantity: 1, rate: 10 }],
    } })]);
    expect(lines).toHaveLength(1);
    expect(lines[0].total).toBe(10);
  });

  it('previews unfinished work without releasing warranty, goodwill or component charges', () => {
    expect(isChargeableShopItem(item({ status: 'in_work' }))).toBe(true);
    expect(isBillableShopItem(item({ status: 'in_work' }))).toBe(false);
    expect(isChargeableShopItem({ ...item(), vendorDisposition: 'no_charge' })).toBe(false);
    expect(isChargeableShopItem(item({ isWarranty: true }))).toBe(false);
    expect(isChargeableShopItem(item({ parentItemId: 'parent' }))).toBe(false);
  });
  it('rolls up bare passes by product+rate into one N×rate line', () => {
    const lines = buildShopBillingLines([
      item({ id: 'a', serialNumber: 'S1' }),
      item({ id: 'b', serialNumber: 'S2' }),
      item({ id: 'c', serialNumber: 'S3' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ lineType: 'labor', quantity: 3, rate: 25, total: 75 });
    expect(lines[0].description).toContain('S1, S2, S3');
  });

  it('collapses 10 unpriced inspection passes into ONE $0 line, serials preserved (no CSV receipt)', () => {
    const zeroProduct = { id: 'scba', partNumber: 'SCBA-INSP', name: 'SCBA', defaultSellPrice: 0 }
    const items = Array.from({ length: 10 }, (_, i) =>
      item({ id: `u${i}`, serialNumber: `SN${i}`, equipmentCategory: 'scba', productId: 'scba', product: zeroProduct }),
    )
    const lines = buildShopBillingLines(items)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ quantity: 10, rate: 0, total: 0 })
    // Every serial still shows on the single line.
    for (let i = 0; i < 10; i++) expect(lines[0].description).toContain(`SN${i}`)
  })

  it('prices the roll-up via the rate override even when the product is $0', () => {
    const zeroProduct = { id: 'scba', partNumber: 'SCBA-INSP', name: 'SCBA', defaultSellPrice: 0 }
    const items = Array.from({ length: 10 }, (_, i) =>
      item({ id: `u${i}`, serialNumber: `SN${i}`, productId: 'scba', product: zeroProduct, billing: { rollup: { enabled: true, rate: 15 } } }),
    )
    const lines = buildShopBillingLines(items)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ quantity: 10, rate: 15, total: 150 })
  })

  it('emits structured labor as hours × rate (UOM HR)', () => {
    const lines = buildShopBillingLines([
      item({ serviceType: 'repair', billing: { labor: { hours: 2.5, rate: 90 } } }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ lineType: 'labor', unitOfMeasure: 'HR', quantity: 2.5, rate: 90, total: 225 });
  });

  it('emits a labor line + a part line for an in-house repair with parts', () => {
    const lines = buildShopBillingLines([
      item({
        serviceType: 'repair',
        billing: { labor: { hours: 1, rate: 90 } },
        partsUsed: [{ partNumber: 'O2-CELL', name: 'O2 Sensor', quantity: 2, unitCost: 40 }],
      }),
    ]);
    expect(lines.map(l => l.lineType)).toEqual(['labor', 'part']);
    expect(lines[1]).toMatchObject({ lineType: 'part', quantity: 2, rate: 40, total: 80, partNumber: 'O2-CELL' });
  });

  it('hydrates missing catalog part price before billing legacy saved parts', () => {
    const [priced] = hydrateShopPartCatalogPrices(
      [
        item({
          serviceType: 'repair',
          partsUsed: [{ productId: 'sensor-1', quantity: 2 }],
        }),
      ],
      [{ id: 'sensor-1', partNumber: 'SEN-O2', name: 'O2 Sensor', defaultSellPrice: 45, unitOfMeasure: 'EA' }],
    );

    const lines = buildShopBillingLines([priced]);
    expect(lines.map(l => l.lineType)).toEqual(['labor', 'part']);
    expect(lines[1]).toMatchObject({
      lineType: 'part',
      productId: 'sensor-1',
      description: 'O2 Sensor — used on S/N SN-1',
      quantity: 2,
      rate: 45,
      total: 90,
      partNumber: 'SEN-O2',
    });
  });

  it('keeps the legacy flat labor charge when parts exist but no time entered', () => {
    const lines = buildShopBillingLines([
      item({ partsUsed: [{ partNumber: 'X', name: 'X', quantity: 1, unitCost: 10 }] }),
    ]);
    expect(lines.map(l => l.lineType)).toEqual(['labor', 'part']);
    expect(lines[0]).toMatchObject({ unitOfMeasure: 'EA', quantity: 1, rate: 25 });
  });

  it('marks up outside-vendor cost + freight and notes the invoice attachment', () => {
    const lines = buildShopBillingLines([
      item({
        status: 'returned',
        billing: { vendor: { cost: 100, freight: 15, markupPct: 20, attachmentName: 'vendor-inv.pdf' } },
      }),
    ]);
    expect(lines).toHaveLength(1);
    // 100 * 1.20 + 15 = 135
    expect(lines[0]).toMatchObject({ lineType: 'misc_charge', rate: 135, total: 135 });
    expect(lines[0].description).toContain('vendor-inv.pdf');
  });

  it('still reads the legacy customData.vendorBilling shape', () => {
    const lines = buildShopBillingLines([
      item({ customData: { vendorBilling: { cost: 50, freight: 0, markupPct: 0 } } }),
    ]);
    expect(lines[0]).toMatchObject({ lineType: 'misc_charge', rate: 50, total: 50 });
  });

  it('emits per-unit misc lines', () => {
    const lines = buildShopBillingLines([
      item({ billing: { misc: [{ description: 'Shop supplies', amount: 12.5 }] } }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ lineType: 'misc_charge', rate: 12.5, total: 12.5 });
    expect(lines[0].description).toContain('Shop supplies');
  });

  it('honors an explicit roll-up flag with a rate override', () => {
    const lines = buildShopBillingLines([
      item({ id: 'a', serialNumber: 'S1', billing: { rollup: { enabled: true, rate: 30 } } }),
      item({ id: 'b', serialNumber: 'S2', billing: { rollup: { enabled: true, rate: 30 } } }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 2, rate: 30, total: 60 });
  });

  it('bills parts alongside a roll-up line (inspection charge + replaced part)', () => {
    // The exact field case: a $20 FEX inspection (roll-up) that also swapped a part.
    const lines = buildShopBillingLines([
      item({
        serialNumber: 'FEX-1',
        billing: { rollup: { enabled: true, rate: 20 } },
        partsUsed: [{ partNumber: 'SEN-CO', name: 'CO Replacement Sensor', quantity: 1, unitCost: 45 }],
      }),
    ]);
    const rollup = lines.find(l => l.lineType === 'labor');
    const part = lines.find(l => l.lineType === 'part');
    expect(rollup).toMatchObject({ quantity: 1, rate: 20, total: 20 });
    expect(part).toMatchObject({ quantity: 1, rate: 45, total: 45, partNumber: 'SEN-CO' });
  });

  it('rolls up condemned units into an inspection-labor line', () => {
    const lines = buildShopBillingLines([item({ status: 'condemned', serialNumber: 'S9' })]);
    expect(lines).toHaveLength(1);
    expect(lines[0].description).toContain('condemned');
    expect(lines[0]).toMatchObject({ quantity: 1, rate: 25 });
  });
});

describe('buildWoExtraLines', () => {
  it('returns [] for no extras', () => {
    expect(buildWoExtraLines(null, 1)).toEqual([]);
    expect(buildWoExtraLines({}, 1)).toEqual([]);
  });

  it('emits mileage as miles × rate', () => {
    const lines = buildWoExtraLines({ mileage: { miles: 40, rate: 2.5 } }, 5);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ lineType: 'travel', unitOfMeasure: 'MI', quantity: 40, rate: 2.5, total: 100, lineNumber: 5 });
  });

  it('emits a flat trip charge when no per-mile rate', () => {
    const lines = buildWoExtraLines({ mileage: { flat: 75 } }, 1);
    expect(lines[0]).toMatchObject({ lineType: 'travel', quantity: 1, rate: 75, total: 75 });
  });

  it('emits WO-level misc lines and numbers from startAt', () => {
    const lines = buildWoExtraLines({ misc: [{ description: 'Disposal fee', amount: 20 }] }, 3);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ lineType: 'misc_charge', rate: 20, total: 20, lineNumber: 3 });
  });
});
