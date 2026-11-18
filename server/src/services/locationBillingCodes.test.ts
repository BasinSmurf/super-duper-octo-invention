import { describe, expect, it } from 'vitest';
import { invoiceBillingCodes, missingRequiredBillingFields, ticketBillingCodes } from './locationBillingCodes.js';

const fixed = { afeNumberSource: 'fixed', costCenterSource: 'fixed', defaultAfeNumber: 'BK', defaultCostCenter: 'DEF' } as const;
const fromLocation = { ...fixed, afeNumberSource: 'location', costCenterSource: 'location' } as const;
const beck = { well: { facilityCode: '3302500636', costCenter: 'US00098792' }, pad: { facilityCode: 'PADFC', costCenter: 'US00098794' } };

describe('location billing codes', () => {
  it('fixed profiles ignore the location and keep only what was typed on the ticket', () => {
    expect(ticketBillingCodes(fixed, beck)).toMatchObject({ afeNumber: null, costCenter: null });
    expect(ticketBillingCodes(fixed, { ...beck, afeNumber: 'AFE1', costCenter: ' CC1 ' })).toMatchObject({ afeNumber: 'AFE1', costCenter: 'CC1' });
    expect(ticketBillingCodes(null, beck)).toMatchObject({ afeNumber: null, costCenter: null });
  });

  it('location profiles prefer a typed value, then the well, then the pad', () => {
    expect(ticketBillingCodes(fromLocation, beck)).toMatchObject({ afeNumber: '3302500636', costCenter: 'US00098792' });
    expect(ticketBillingCodes(fromLocation, { ...beck, costCenter: 'TYPED' }).costCenter).toBe('TYPED');
    expect(ticketBillingCodes(fromLocation, { well: { facilityCode: ' ' }, pad: beck.pad }))
      .toMatchObject({ afeNumber: 'PADFC', costCenter: 'US00098794' });
  });

  it('a profile default pre-filled onto the ticket does not mask the location', () => {
    expect(ticketBillingCodes(fromLocation, { ...beck, afeNumber: 'BK', costCenter: 'DEF' }))
      .toMatchObject({ afeNumber: '3302500636', costCenter: 'US00098792' });
  });

  it('sources are independent per field', () => {
    expect(ticketBillingCodes({ ...fixed, costCenterSource: 'location' }, beck)).toMatchObject({ afeNumber: null, costCenter: 'US00098792' });
  });

  it('stamps the invoice only when the coded tickets agree', () => {
    const other = { well: { facilityCode: '3302500821', costCenter: 'US00101308' } };
    expect(invoiceBillingCodes(fromLocation, [beck, beck, {}])).toMatchObject({ afeNumber: '3302500636', costCenter: 'US00098792' });
    expect(invoiceBillingCodes(fromLocation, [beck, other])).toMatchObject({ afeNumber: null, costCenter: null });
    expect(invoiceBillingCodes(fromLocation, [])).toMatchObject({ afeNumber: null, costCenter: null });
  });

  it('subcompany and department come from the location only when the profile asks', () => {
    const kd = { well: { buyerSiteUuid: 'SITE-W', buyerDepartment: 'Killdeer Field Office' }, pad: { buyerSiteUuid: 'SITE-P', buyerDepartment: 'Tioga Field Office' } };
    expect(ticketBillingCodes(fixed, kd)).toMatchObject({ buyerSiteUuid: null, buyerDepartment: null });
    expect(ticketBillingCodes({ ...fixed, buyerSiteSource: 'location', buyerDepartmentSource: 'location' }, kd))
      .toMatchObject({ buyerSiteUuid: 'SITE-W', buyerDepartment: 'Killdeer Field Office' });
    expect(ticketBillingCodes({ buyerDepartmentSource: 'location' }, { pad: kd.pad }).buyerDepartment).toBe('Tioga Field Office');
    expect(invoiceBillingCodes({ buyerDepartmentSource: 'location' }, [kd, kd, {}]).buyerDepartment).toBe('Killdeer Field Office');
    expect(invoiceBillingCodes({ buyerDepartmentSource: 'location' }, [kd, { pad: kd.pad }]).buyerDepartment).toBeNull();
  });

  it('lists the required fields that are still empty', () => {
    const hess = { requiresPo: true, requiresBuyerSite: true };
    expect(missingRequiredBillingFields(hess, { poNumber: ' ' })).toEqual(['PO number', 'subcompany']);
    expect(missingRequiredBillingFields(hess, { poNumber: '4500123', buyerSiteUuid: 'S' })).toEqual([]);
    expect(missingRequiredBillingFields({ requiresAfe: true, requiresCostCenter: true, requiresBuyerDepartment: true }, {}))
      .toEqual(['AFE', 'cost center', 'department']);
    expect(missingRequiredBillingFields(null, {})).toEqual([]);
  });
});
