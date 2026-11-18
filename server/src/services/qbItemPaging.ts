// Each SOAP response contains at most 100 items (25 across four item types).
// Iterators belong to the current QuickBooks session; never persist them to a
// queue job that could be resumed in a different session.
export const ITEM_QUERY_TYPES = ['ItemService', 'ItemNonInventory', 'ItemInventory', 'ItemOtherCharge'] as const;
type ItemQueryType = typeof ITEM_QUERY_TYPES[number];
export type ItemQueryIterators = Partial<Record<ItemQueryType, string>>;
const PAGE_SIZE = 25;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildPagedItemQuery(iterators?: ItemQueryIterators): string {
  const queries = ITEM_QUERY_TYPES.filter(type => !iterators || iterators[type]).map(type => {
    const iterator = iterators?.[type];
    return `<${type}QueryRq iterator="${iterator ? 'Continue' : 'Start'}"${iterator ? ` iteratorID="${escapeAttribute(iterator)}"` : ''}>
      <MaxReturned>${PAGE_SIZE}</MaxReturned>
      <ActiveStatus>All</ActiveStatus>
    </${type}QueryRq>`;
  });
  if (!queries.length) throw new Error('No item query pages remaining');
  return `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="13.0"?>
<QBXML><QBXMLMsgsRq onError="continueOnError">${queries.join('\n')}
<SalesTaxCodeQueryRq><ActiveStatus>All</ActiveStatus></SalesTaxCodeQueryRq>
</QBXMLMsgsRq></QBXML>`;
}

// Reject errors/missing responses rather than recording a partial catalog pull
// as successful. Status 1 is QuickBooks' normal empty-query result.
export function nextItemQueryIterators(xml: string, previous?: ItemQueryIterators): ItemQueryIterators {
  const next: ItemQueryIterators = {};
  for (const type of ITEM_QUERY_TYPES.filter(type => !previous || previous[type])) {
    const tag = xml.match(new RegExp(`<${type}QueryRs\\b([^>]*)>`));
    if (!tag) throw new Error(`Missing ${type}QueryRs in item page`);
    const attr = (name: string) => tag[1].match(new RegExp(`\\b${name}=["']([^"']*)["']`))?.[1];
    const status = attr('statusCode');
    if (status !== '0' && status !== '1') throw new Error(`${type} query failed: ${status} ${attr('statusMessage') || ''}`);
    if (status === '1') continue;
    const remaining = attr('iteratorRemainingCount');
    if (remaining === undefined || !/^\d+$/.test(remaining)) throw new Error(`Invalid ${type} iteratorRemainingCount`);
    if (Number(remaining) > 0) {
      const id = attr('iteratorID');
      if (!id) throw new Error(`Missing ${type} iteratorID`);
      next[type] = id;
    }
  }
  return next;
}
