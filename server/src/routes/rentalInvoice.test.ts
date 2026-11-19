import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  rentalAgreement: { findUnique: vi.fn() },
  invoice: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  invoiceLineItem: { findFirst: vi.fn() },
  serviceTicket: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  product: { findMany: vi.fn(), findUnique: vi.fn() },
  company: { findUnique: vi.fn() },
  salesTaxRate: { findUnique: vi.fn() },
  customerBillingProfile: { findMany: vi.fn() },
}));

vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), prisma }));
vi.mock('../utils/ticketNumber.js', () => ({ generateInvoiceNumber: vi.fn(async () => 'INV-TEST') }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
vi.mock('../services/billingLineage.js', () => ({ upsertDocRefAndLines: vi.fn() }));
import { invoicesRouter } from './invoices.js';
import { generateInvoiceNumber } from '../utils/ticketNumber.js';

const d = (value: string) => new Date(value);
const daily = (id: string, day: string, status = 'completed') => ({ id, ticketNumber: `FS-${id}`, serviceDate: d(day), status, customData: { onSiteSubtype: 'manned_trailer' } });
let rental: any;
async function generate(start = '2026-09-18', end = '2026-09-22') {
  const layer = invoicesRouter.stack.find(entry => entry.route?.path === '/generate/from-rental');
  const json = vi.fn();
  await layer!.route.stack[0].handle({ body: { rentalAgreementId: 'r1', periodStart: start, periodEnd: end } }, { status: () => ({ json }) });
  return prisma.invoice.create.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async action => action(prisma));
  prisma.$queryRaw.mockResolvedValue([]);
  rental = { id: 'r1', companyId: 'c1', company: { name: 'Customer', taxExempt: true }, status: 'completed',
    pickupType: 'walk_in', startDate: d('2026-09-18'), endDate: d('2026-09-22'), billingRateType: 'daily',
    billingPolicy: { pauses: [{ startDate: '2026-09-19', endDate: '2026-09-20' }], ticketRates: { manned: 500, unmanned: 200 } },
    composition: { trailer: { manned: true, rate: 999 }, bomPackage: { label: 'Air package', rate: 999 } }, items: [] };
  prisma.rentalAgreement.findUnique.mockImplementation(async () => rental);
  prisma.invoice.findFirst.mockResolvedValue(null);
  prisma.invoice.count.mockResolvedValue(0);
  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.product.findUnique.mockResolvedValue(null);
  prisma.invoice.create.mockResolvedValue({ id: 'invoice1' });
  prisma.product.findMany.mockResolvedValue([]);
  prisma.company.findUnique.mockResolvedValue(null);
  prisma.salesTaxRate.findUnique.mockResolvedValue({ id: 'nd_state', rate: 0.08 });
  prisma.customerBillingProfile.findMany.mockResolvedValue([]);
  prisma.serviceTicket.findMany.mockReset().mockResolvedValue([]);
  prisma.serviceTicket.count.mockResolvedValue(0);
});

describe('rental invoice generation', () => {
  it('uses the corrected baseline for October billing after removing an erroneous trailer package', async () => {
    const composition = { trailer: null, other: [{ label: '2 Bottle Breathing Air System', qty: 1, rate: 45 }] };
    rental.startDate = d('2026-10-22');
    rental.endDate = d('2026-10-31');
    rental.composition = composition;
    rental.billingPolicy = { pauses: [], ticketRates: null, compositionHistory: [{ effectiveDate: '0001-01-01', composition }] };
    const invoice = await generate('2026-10-22', '2026-10-31');
    expect(invoice.subtotal).toBe(450);
    expect(invoice.lineItems.create).toHaveLength(1);
    expect(invoice.lineItems.create[0]).toMatchObject({ quantity: 10, rate: 45, amount: 450 });
    expect(invoice.lineItems.create[0].description).not.toMatch(/trailer/i);
  });
  it.each(['other', 'gasMonitors'])('carries a la carte %s QB item identity and quoted rate onto the invoice', async field => {
    rental.billingPolicy.ticketRates = null;
    rental.composition = { [field]: [{ id: 'extra', productId: 'area', label: 'Area Gas Monitor Rental', productName: 'Area Gas Monitor Rental', qty: 1, rate: 150 }] };
    prisma.product.findMany.mockResolvedValue([{ id: 'area', partNumber: '0412004', name: 'Area Gas Monitor Rental', isSerialized: false, qbItemListId: 'qb-area', qbItemFullName: '0412004', isTaxable: true }]);
    const invoice = await generate();
    expect(invoice.lineItems.create).toContainEqual(expect.objectContaining({ productId: 'area', partNumber: '0412004', qbItemListId: 'qb-area', qbItemFullName: '0412004', rate: 150, amount: 450 }));
    expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['area'] } } }));
  });
  it('still tracks actual deployments when the QB product serialized flag is unset', async () => {
    rental.billingPolicy.ticketRates = null;
    rental.composition = { gasMonitors: [{ productId: 'area', qty: 1, rate: 150 }] };
    rental.items = [
      { id: 'monitor', productId: 'area', deployedDate: d('2026-09-18'), returnedDate: d('2026-09-18') },
      { id: 'other', productId: 'other', deployedDate: d('2026-09-18'), returnedDate: d('2026-09-22') },
    ];
    prisma.product.findMany.mockResolvedValue([{ id: 'area', isSerialized: false }]);
    expect((await generate()).subtotal).toBe(150);
  });
  it('uses imported product tax flags before freezing rental sweep tax and totals', async () => {
    rental.company.taxExempt = false;
    rental.billingPolicy.ticketRates = null;
    rental.composition = null;
    rental.items = [{ id: 'unit', productId: 'rental-product', deployedDate: d('2026-09-18'), returnedDate: d('2026-09-22'),
      rate: 200, rateType: 'daily', product: { name: 'Monitor', partNumber: '0411011' } }];
    prisma.product.findMany.mockResolvedValue([
      { id: 'rental-product', partNumber: '0411011', isTaxable: true },
      { id: 'labor', partNumber: '0400002', isTaxable: false },
    ]);
    prisma.serviceTicket.findMany.mockResolvedValueOnce([{ id: 'visit', ticketNumber: 'FS-1', lineItems: [
      { productId: 'labor', partNumber: '0400002', description: 'Labor', lineType: 'rental', quantity: 1, rate: 100, total: 100 },
    ] }]);
    const invoice = await generate();
    expect(invoice.lineItems.create.map((line: any) => line.isTaxable)).toEqual([true, false]);
    expect(invoice.subtotal).toBe(700);
    expect(invoice.taxAmount).toBe(48);
    expect(invoice.total).toBe(748);
    expect(invoice.invoiceDate).toEqual(invoice.periodEnd);
  });

  it('refuses a linked ticket whose charges already sit on another live invoice', async () => {
    rental.billingPolicy = { pauses: [], ticketRates: null };
    rental.composition = null;
    prisma.serviceTicket.findMany.mockResolvedValueOnce([{
      id: 'swap', ticketNumber: 'FS-SWAP', status: 'billing_queue', customData: { workType: 'rental_swap', recordOnly: false },
      lineItems: [{ lineType: 'labor', partNumber: '0400002', description: 'Swap labor', quantity: 1, rate: 85, total: 85, unitOfMeasure: 'HR' }],
    }]).mockResolvedValueOnce([]);
    prisma.invoiceLineItem.findFirst.mockResolvedValueOnce({ sourceTicketNumber: 'FS-SWAP', invoice: { invoiceNumber: 'INV-OTHER', status: 'draft' } });
    await expect(generate()).rejects.toThrow('INV-OTHER');
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it.each(['rental_deploy', 'rental_swap', 'rental_return'])('bills linked %s labor and mileage once through the rental invoice', async workType => {
    rental.billingPolicy = { pauses: [], ticketRates: null };
    rental.composition = null;
    prisma.serviceTicket.findMany.mockResolvedValueOnce([{
      id: 'swap', ticketNumber: 'FS-SWAP', status: 'billing_queue', customData: { workType, recordOnly: false },
      lineItems: [
        { lineType: 'labor', partNumber: '0400002', description: 'Swap labor', quantity: 1.5, rate: 85, total: 127.5, unitOfMeasure: 'HR' },
        { lineType: 'travel', partNumber: '0400001', description: 'Swap mileage', quantity: 20, rate: 3, total: 60, unitOfMeasure: 'MI' },
      ],
    }]).mockResolvedValueOnce([]);
    const invoice = await generate();
    expect(invoice.subtotal).toBe(187.5);
    expect(invoice.lineItems.create).toEqual([
      expect.objectContaining({ sourceTicketId: 'swap', quantity: 1.5, rate: 85, amount: 127.5 }),
      expect.objectContaining({ sourceTicketId: 'swap', quantity: 20, rate: 3, amount: 60 }),
    ]);
    // Only approved tickets ride an invoice; nothing unapproved, nothing already billed.
    expect(prisma.serviceTicket.findMany.mock.calls[0][0].where.status).toBe('billing_queue');
    expect(prisma.serviceTicket.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['swap'] } }, data: { status: 'invoiced' } });
  });
  it('takes AFE and cost center from the rental site only when the profile sources them from the location', async () => {
    rental.well = { facilityCode: '3302500636', costCenter: 'US00098792' };
    const profile = { id: 'bp1', companyId: 'c1', isActive: true, appliesToTicketTypes: [], appliesToDivisions: [],
      defaultAfeNumber: 'BK', afeNumberSource: 'location', costCenterSource: 'location' };
    prisma.customerBillingProfile.findMany.mockResolvedValue([profile]);
    expect(await generate()).toMatchObject({ afeNumber: '3302500636', costCenter: 'US00098792' });

    prisma.invoice.create.mockClear();
    prisma.customerBillingProfile.findMany.mockResolvedValue([{ ...profile, afeNumberSource: 'fixed', costCenterSource: 'fixed' }]);
    expect(await generate()).toMatchObject({ afeNumber: null, costCenter: null });
  });

  it('previews the same charges and paused days without reserving a number or changing records', async () => {
    const layer = invoicesRouter.stack.find(entry => entry.route?.path === '/generate/from-rental');
    const json = vi.fn();
    await layer!.route.stack[0].handle({ body: { rentalAgreementId: 'r1', periodStart: '2026-09-18', periodEnd: '2026-09-22', preview: true } }, { json });
    expect(json.mock.calls[0][0]).toMatchObject({ total: 600, days: { total: 5, paused: 2, manned: 0, unmanned: 3 } });
    expect(generateInvoiceNumber).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.serviceTicket.updateMany).not.toHaveBeenCalled();
    expect((await generate()).subtotal).toBe(json.mock.calls[0][0].subtotal);
  });
  it('replaces the package with manned/unmanned days, excludes pauses and deduplicates shifts', async () => {
    prisma.serviceTicket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      daily('a', '2026-09-18'), daily('b', '2026-09-18'), daily('c', '2026-09-19'), daily('d', '2026-09-21'),
    ]);
    const invoice = await generate();
    expect(invoice.subtotal).toBe(1200);
    expect(invoice.lineItems.create).toEqual([
      expect.objectContaining({ quantity: 2, rate: 500, amount: 1000, unitOfMeasure: 'DAY' }),
      expect.objectContaining({ quantity: 1, rate: 200, amount: 200, unitOfMeasure: 'DAY' }),
    ]);
    expect(prisma.serviceTicket.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b', 'd'] } }, data: { status: 'invoiced' } });
  });
  it('pauses legacy serialized equipment charges without returning equipment', async () => {
    rental.billingPolicy.ticketRates = null;
    rental.composition = null;
    rental.items = [{ id: 'item', productId: 'product', deployedDate: d('2026-09-18'), returnedDate: d('2026-09-22'),
      rate: 25, rateType: 'daily', product: { name: 'Monitor' } }];
    const invoice = await generate();
    expect(invoice.lineItems.create[0]).toMatchObject({ quantity: 3, amount: 75, sourceRentalItemId: 'item' });
    expect(rental.items[0].returnedDate).toEqual(d('2026-09-22'));
  });
  it('counts unrelated service visits as unmanned and retains their separate charges', async () => {
    const visit = { id: 'cal', ticketNumber: 'CAL', serviceDate: d('2026-09-18'), status: 'completed', customData: {},
      lineItems: [{ description: 'Calibration', quantity: 1, rate: 75, total: 75, lineType: 'labor' }] };
    prisma.serviceTicket.findMany.mockResolvedValueOnce([visit]).mockResolvedValueOnce([visit]);
    const invoice = await generate();
    expect(invoice.subtotal).toBe(675);
    expect(invoice.lineItems.create).toHaveLength(2);
  });
  it('allows a single day and refuses empty fully paused periods for active rentals', async () => {
    rental.status = 'active'; rental.endDate = null; rental.billingReleasedThrough = d('2026-09-22');
    expect((await generate('2026-09-18', '2026-09-18')).subtotal).toBe(200);
    await expect(generate('2026-09-19', '2026-09-20')).rejects.toThrow('No billable items');
  });
  it('bills a completed rental through its end date even when a shorter final period was requested', async () => {
    const invoice = await generate('2026-09-18', '2026-09-18');
    expect(invoice.periodEnd).toEqual(d('2026-09-22'));
    expect(invoice.subtotal).toBe(600);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    prisma.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-FINAL' });
    await expect(generate('2026-09-19', '2026-09-20')).rejects.toThrow('overlaps');
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
  });
  it('refuses overlapping invoices before computing or persisting charges', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-OLD' });
    await expect(generate()).rejects.toThrow('overlaps');
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
  it('does not reserve future days when billing an active rental', async () => {
    vi.useFakeTimers(); vi.setSystemTime(d('2026-09-24T12:00:00Z'));
    try {
      rental.status = 'active'; rental.endDate = null; rental.billingReleasedThrough = d('2026-09-21');
      const invoice = await generate('2026-09-21', '2026-09-30');
      expect(invoice.periodEnd).toEqual(d('2026-09-24'));
      expect(invoice.subtotal).toBe(800);
    } finally { vi.useRealTimers(); }
  });
  it('rejects scheduled rentals and invalid calendar dates', async () => {
    rental.status = 'scheduled';
    await expect(generate()).rejects.toThrow('not active');
    await expect(generate('2026-02-30')).rejects.toThrow('Invalid');
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
  it('preserves free equipment and uses rental rather than retail fallback prices', async () => {
    rental.billingPolicy = { pauses: [], ticketRates: null }; rental.composition = null;
    rental.items = [{ id: 'item', productId: 'p', deployedDate: d('2026-09-18'), returnedDate: null,
      rate: 0, rateType: 'daily', product: { name: 'Monitor', defaultSellPrice: 999, defaultRentalRateDaily: 10 } }];
    expect((await generate()).subtotal).toBe(0);
    prisma.invoice.create.mockClear(); rental.items[0].rate = null;
    expect((await generate()).subtotal).toBe(50);
  });
  it('charges composition equipment only while its slots are occupied', async () => {
    rental.billingPolicy = { pauses: [], ticketRates: null };
    rental.composition = { gasMonitors: [{ productId: 'p', qty: 2, rate: 10 }] };
    rental.items = [
      { id: 'a', productId: 'p', deployedDate: d('2026-09-18'), returnedDate: d('2026-09-19') },
      { id: 'b', productId: 'p', deployedDate: d('2026-09-18'), returnedDate: null },
    ];
    expect((await generate()).subtotal).toBe(70);
  });
  it('partitions an invoice across dated composition revisions without rewriting earlier days', async () => {
    const before={gasMonitors:[{productId:'p',qty:1,rate:10}]};
    const after={gasMonitors:[{productId:'p',qty:1,rate:20}]};
    rental.billingPolicy={pauses:[],ticketRates:null,compositionHistory:[{effectiveDate:'0001-01-01',composition:before},{effectiveDate:'2026-09-20',composition:after}]};
    rental.composition=after;
    rental.items=[{id:'a',productId:'p',deployedDate:d('2026-09-18'),returnedDate:null}];
    expect((await generate()).subtotal).toBe(80);
  });
  it('bills each package variant as its own QB item across an on-job package switch', async () => {
    // Unmanned, no monitors + 2 monitors as overages until the 20th; then the
    // customer's "w/ gas detection" variant, which covers the monitors.
    const before = { trailer: { manned: false, rate: 0 }, bomType: 'unmanned',
      bom: [], bomPackage: { label: 'Air Trailer - Base Rental (Daily)', productId: 'bare', rate: 200 },
      bomExtras: [{ id: 'bomx-monitor_area', label: 'Area Gas Monitor Rental (over baseline)', equipmentCategory: 'monitor_area', productId: 'mon', qty: 2, rate: 75 }] };
    const after = { trailer: { manned: false, rate: 0 }, bomType: 'unmanned',
      bom: [{ label: 'Area Monitor', qty: 2, equipmentCategory: 'monitor_area', productId: 'mon' }],
      bomPackage: { label: 'Unmanned Air Trailer w/ Gas Detection', productId: 'gas', rate: 300 } };
    rental.billingPolicy = { pauses: [], ticketRates: null, compositionHistory: [
      { effectiveDate: '0001-01-01', composition: before }, { effectiveDate: '2026-09-20', composition: after }] };
    rental.composition = after;
    rental.items = [{ id: 'a', productId: 'serial-mon', deployedDate: d('2026-09-18'), returnedDate: null }];
    prisma.product.findMany.mockResolvedValue([
      { id: 'bare', partNumber: '0411003', name: 'Air Trailer - Base Rental (Daily)', isSerialized: false, qbItemListId: 'qb-bare', qbItemFullName: '0411003' },
      { id: 'gas', partNumber: '0411004', name: 'Unmanned Air Trailer w/ Gas Detection', isSerialized: false, qbItemListId: 'qb-gas', qbItemFullName: '0411004' },
      { id: 'mon', partNumber: '0412004', name: 'Area Gas Monitor Rental', isSerialized: false, qbItemListId: 'qb-mon', qbItemFullName: '0412004' },
    ]);
    const invoice = await generate();
    const lines = invoice.lineItems.create;
    expect(lines).toContainEqual(expect.objectContaining({ qbItemFullName: '0411003', quantity: 2, rate: 200, amount: 400 }));
    expect(lines).toContainEqual(expect.objectContaining({ qbItemFullName: '0412004', quantity: 4, rate: 75, amount: 300 }));
    expect(lines).toContainEqual(expect.objectContaining({ qbItemFullName: '0411004', quantity: 3, rate: 300, amount: 900 }));
    // The covered trailer never prints as a $0 row, and monitors stop as overages on the switch.
    expect(lines.filter((l: any) => l.qbItemFullName === '0412004')).toHaveLength(1);
    expect(lines.some((l: any) => /Trailer \(/.test(l.description))).toBe(false);
    expect(invoice.subtotal).toBe(1600);
  });
  it('sweeps unbilled linked tickets back to the start of the job, not just the period', async () => {
    rental.billingPolicy = { pauses: [], ticketRates: null };
    rental.composition = null;
    // Dated the 18th, synced after the 18th-20th was already invoiced.
    prisma.serviceTicket.findMany.mockResolvedValueOnce([{
      id: 'late', ticketNumber: 'FS-LATE', serviceDate: d('2026-09-18'), status: 'billing_queue', customData: {},
      lineItems: [{ lineType: 'labor', description: 'Late service call', quantity: 2, rate: 85, total: 170, unitOfMeasure: 'HR' }],
    }]);
    const invoice = await generate('2026-09-21', '2026-09-22');
    expect(prisma.serviceTicket.findMany.mock.calls[0][0].where.serviceDate).toEqual({ lte: d('2026-09-22') });
    expect(invoice.lineItems.create).toEqual([expect.objectContaining({ sourceTicketId: 'late', amount: 170 })]);
    expect(prisma.serviceTicket.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['late'] } }, data: { status: 'invoiced' } });
  });
  describe('send-for-billing gate', () => {
    beforeEach(() => { rental.status = 'active'; rental.endDate = null; });
    it('refuses an active rental the field has not sent', async () => {
      await expect(generate('2026-09-18', '2026-09-18')).rejects.toThrow('has not been sent for billing');
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
    it('refuses a period that starts after the sent-through date', async () => {
      rental.billingReleasedThrough = d('2026-09-18');
      await expect(generate('2026-09-21', '2026-09-22')).rejects.toThrow('has not been sent for billing');
    });
    it('lets AR extend the period past the sent-through date, up to today', async () => {
      vi.useFakeTimers(); vi.setSystemTime(d('2026-09-24T12:00:00Z'));
      try {
        rental.billingReleasedThrough = d('2026-09-21');
        const invoice = await generate('2026-09-21', '2026-09-23');
        expect(invoice.periodEnd).toEqual(d('2026-09-23'));
      } finally { vi.useRealTimers(); }
    });
    it('still previews an unsent rental', async () => {
      const layer = invoicesRouter.stack.find(entry => entry.route?.path === '/generate/from-rental');
      const json = vi.fn();
      await layer!.route.stack[0].handle({ body: { rentalAgreementId: 'r1', periodStart: '2026-09-18', periodEnd: '2026-09-18', preview: true } }, { json });
      expect(json.mock.calls[0][0].subtotal).toBe(200);
    });
    it('holds a closed rental until its tickets are approved, unless forced', async () => {
      rental.status = 'completed'; rental.endDate = d('2026-09-22');
      prisma.serviceTicket.count.mockResolvedValue(2);
      await expect(generate()).rejects.toThrow('2 tickets on this rental still need supervisor approval');
      expect(prisma.serviceTicket.count.mock.calls[0][0].where.status).toEqual({ in: ['completed', 'supervisor_review'] });
      rental.billingReleasedThrough = d('2026-09-22'); rental.billingReleaseForceReason = 'Supervisor out; customer needs invoice';
      expect((await generate()).subtotal).toBe(600);
    });
  });
  describe('late manned dailies', () => {
    const prior = { invoiceNumber: 'INV-PRIOR', periodStart: d('2026-09-18'), periodEnd: d('2026-09-18') };
    it('flags a manned daily that arrives after its day billed unmanned, without billing the difference', async () => {
      prisma.invoice.findMany.mockResolvedValue([prior]);
      prisma.serviceTicket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([daily('late', '2026-09-18')]);
      const invoice = await generate('2026-09-21', '2026-09-22');
      expect(invoice.subtotal).toBe(400); // two unmanned days; the adjustment adds nothing on its own
      expect(invoice.lineItems.create).toEqual([
        expect.objectContaining({ quantity: 2, rate: 200, amount: 400 }),
        expect.objectContaining({ quantity: 0, rate: 300, amount: 0, unitOfMeasure: 'DAY',
          description: 'Manned day adjustment — 2026-09-18 (FS-late), billed unmanned on INV-PRIOR' }),
      ]);
      // Consumed so it flags once rather than on every later invoice.
      expect(prisma.serviceTicket.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['late'] } }, data: { status: 'invoiced' } });
    });
    it('names the late day in the preview', async () => {
      prisma.invoice.findMany.mockResolvedValue([prior]);
      prisma.serviceTicket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([daily('late', '2026-09-18')]);
      const layer = invoicesRouter.stack.find(entry => entry.route?.path === '/generate/from-rental');
      const json = vi.fn();
      await layer!.route.stack[0].handle({ body: { rentalAgreementId: 'r1', periodStart: '2026-09-21', periodEnd: '2026-09-22', preview: true } }, { json });
      expect(json.mock.calls[0][0].lateMannedDays).toEqual([
        { date: '2026-09-18', ticketNumbers: ['FS-late'], billedOn: 'INV-PRIOR', difference: 300 },
      ]);
    });
    it('consumes a late second shift silently when the day already billed manned', async () => {
      prisma.invoice.findMany.mockResolvedValue([prior]);
      prisma.serviceTicket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        daily('first', '2026-09-18', 'invoiced'), daily('second', '2026-09-18'),
      ]);
      const invoice = await generate('2026-09-21', '2026-09-22');
      expect(invoice.lineItems.create).toHaveLength(1);
      expect(prisma.serviceTicket.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['second'] } }, data: { status: 'invoiced' } });
    });
    it('leaves a manned daily alone when its day was never invoiced', async () => {
      prisma.serviceTicket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([daily('gap', '2026-09-18')]);
      const invoice = await generate('2026-09-21', '2026-09-22');
      expect(invoice.lineItems.create).toHaveLength(1);
      expect(prisma.serviceTicket.updateMany).not.toHaveBeenCalled();
    });
  });
  it('bills the replacement rate, once, on a serialized swap date', async () => {
    rental.billingPolicy = { pauses: [], ticketRates: null }; rental.composition = null;
    rental.items = [
      { id:'a', productId:'p', rate:10, rateType:'daily', deployedDate:d('2026-09-18'), returnedDate:d('2026-09-20'), product:{name:'A'} },
      { id:'b', productId:'p', rate:20, rateType:'daily', deployedDate:d('2026-09-20'), returnedDate:null, replacesItemId:'a', product:{name:'B'} },
    ];
    expect((await generate()).subtotal).toBe(80); // 2 old days + 3 replacement days
  });
});
