import { describe, expect, it } from 'vitest';
import { buildPagedItemQuery, nextItemQueryIterators, ITEM_QUERY_TYPES } from '../qbItemPaging.js';

describe('bounded QuickBooks item queries', () => {
  it('starts four typed iterators with at most 100 total items per response', () => {
    const xml = buildPagedItemQuery();
    expect(xml.match(/iterator="Start"/g)).toHaveLength(4);
    expect(xml.match(/<MaxReturned>25<\/MaxReturned>/g)).toHaveLength(4);
    expect(xml.match(/<ActiveStatus>All<\/ActiveStatus>/g)).toHaveLength(5);
    expect(xml).toContain('<SalesTaxCodeQueryRq><ActiveStatus>All</ActiveStatus></SalesTaxCodeQueryRq>');
  });
  it('continues only unfinished types and stops after the last page', () => {
    const xml = ITEM_QUERY_TYPES.map(type => `<${type}QueryRs statusCode="0" iteratorRemainingCount="${type === 'ItemService' ? 40 : 0}" iteratorID="{service}"/>`).join('');
    const next = nextItemQueryIterators(xml);
    expect(next).toEqual({ ItemService: '{service}' });
    const continuation = buildPagedItemQuery(next);
    expect(continuation).toContain('iterator="Continue" iteratorID="{service}"');
    expect(continuation).not.toContain('ItemInventoryQueryRq');
    expect(nextItemQueryIterators('<ItemServiceQueryRs statusCode="0" iteratorRemainingCount="0"/>', next)).toEqual({});
  });
  it('accepts empty item types but rejects errors and incomplete iterator metadata', () => {
    expect(nextItemQueryIterators('<ItemServiceQueryRs statusCode="1"/>', { ItemService: 'id' })).toEqual({});
    expect(() => nextItemQueryIterators('<ItemServiceQueryRs statusCode="500"/>', { ItemService: 'id' })).toThrow('query failed');
    expect(() => nextItemQueryIterators('', { ItemService: 'id' })).toThrow('Missing ItemServiceQueryRs');
    expect(() => nextItemQueryIterators('<ItemServiceQueryRs statusCode="0" iteratorRemainingCount="2"/>', { ItemService: 'id' })).toThrow('iteratorID');
    expect(() => nextItemQueryIterators('<ItemServiceQueryRs statusCode="0"/>', { ItemService: 'id' })).toThrow('iteratorRemainingCount');
  });
});
