// The QB item pull used to drop every item that had no counterpart in Sundog —
// 1,208 of 2,497 on the last real pull — which is why a part renumbered in QB
// never appeared in Products or the ticket line picker. These pin the mapping
// that mints those rows, and the leaf-name rule that also fixes the matching.

import { describe, it, expect } from 'vitest';
import {
  qbItemLeafName,
  guessProductCategory,
  normalizeUoM,
  productCreateFromQbItem,
  PRODUCT_TYPE_FOR_QB_ITEM_TYPE,
  QB_PULL_PROVENANCE,
  type QbPulledItem,
} from '../qbItemMapping.js';
import { parsePartNumber } from '../../utils/partNumber.js';

const PULLED_AT = new Date('2026-08-25T20:34:13.000Z');

function item(overrides: Partial<QbPulledItem> = {}): QbPulledItem {
  return {
    listId: '80000123-1512680195',
    fullName: '0800001',
    isActive: true,
    description: 'Occ Health Mileage',
    price: 1.5,
    unitOfMeasure: 'Mile',
    itemType: 'service',
    ...overrides,
  };
}

describe('qbItemLeafName', () => {
  it('takes the item name out of a QB sub-item path', () => {
    expect(qbItemLeafName('Parts:0800001')).toBe('0800001');
    expect(qbItemLeafName('Rentals:Monitors:0400100')).toBe('0400100');
    expect(qbItemLeafName('0800001')).toBe('0800001');
  });
});

describe('productCreateFromQbItem', () => {
  it('numbers the product by QB item name, not the sub-item path', () => {
    const row = productCreateFromQbItem(item({ fullName: 'Parts:0800001' }), PULLED_AT);
    expect(row.partNumber).toBe('0800001');
    // Full path stays as the QB ref, so the push still points at the right item.
    expect(row.qbItemFullName).toBe('Parts:0800001');
    expect(parsePartNumber(row.partNumber)).toEqual({ division: 8, family: 0, subgroup: 0 });
  });

  it('carries QB name, price and UoM, and marks its provenance', () => {
    const row = productCreateFromQbItem(item(), PULLED_AT);
    expect(row.name).toBe('Occ Health Mileage');
    expect(row.defaultSellPrice).toBe(1.5);
    expect(row.unitOfMeasure).toBe('MI');
    expect(row.productType).toBe('service');
    expect(row.qbItemType).toBe('service');
    expect(row.customData).toEqual({ createdBy: QB_PULL_PROVENANCE, pulledAt: PULLED_AT.toISOString() });
  });

  it('falls back to the part number when QB has no description, and drops a $0 price', () => {
    const row = productCreateFromQbItem(item({ description: null, price: 0 }), PULLED_AT);
    expect(row.name).toBe('0800001');
    expect(row.defaultSellPrice).toBeNull();
  });

  it('maps every QB item type to a product type', () => {
    for (const [qbType, productType] of Object.entries(PRODUCT_TYPE_FOR_QB_ITEM_TYPE)) {
      expect(productCreateFromQbItem(item({ itemType: qbType }), PULLED_AT).productType).toBe(productType);
    }
    // An item type we don't recognize still lands somewhere sane.
    expect(productCreateFromQbItem(item({ itemType: 'something_new' }), PULLED_AT).qbItemType).toBe('non_inventory');
  });

  it('keeps a legacy (non-conforming) number, just with no division facets', () => {
    const row = productCreateFromQbItem(item({ fullName: '406' }), PULLED_AT);
    expect(row.partNumber).toBe('406');
    expect(parsePartNumber(row.partNumber)).toBeNull();
  });
});

describe('guessProductCategory', () => {
  it('reads the description first, then the account, then the item type', () => {
    expect(guessProductCategory({ description: 'MX6 iBrid monitor' })).toBe('monitor_personal');
    expect(guessProductCategory({ description: 'RAE Guard area monitor' })).toBe('monitor_area');
    expect(guessProductCategory({ description: 'SCBA regulator' })).toBe('supplied_air_component');
    expect(guessProductCategory({ description: '4-gas cal gas' })).toBe('calibration_gas');
    expect(guessProductCategory({ description: 'H2S sensor' })).toBe('sensor');
    expect(guessProductCategory({ description: 'Class fee', account: 'Training Income' })).toBe('labor');
    expect(guessProductCategory({ description: 'Widget', isPart: true })).toBe('consumable');
    expect(guessProductCategory({ description: 'Kit', isAssembly: true })).toBe('assembly');
    expect(guessProductCategory({})).toBe('misc');
  });
});

describe('normalizeUoM', () => {
  it('shortens QB spellings and defaults to EA', () => {
    expect(normalizeUoM('Hour')).toBe('HR');
    expect(normalizeUoM('Mile')).toBe('MI');
    expect(normalizeUoM('Each')).toBe('EA');
    expect(normalizeUoM(null)).toBe('EA');
    expect(normalizeUoM('Bundle')).toBe('BUNDLE');
  });
});
