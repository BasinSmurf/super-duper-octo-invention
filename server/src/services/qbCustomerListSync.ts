import { prisma } from '../db.js';
import { decodeHtmlEntities } from '../utils/htmlEntities.js';

// Bulk pull of the QuickBooks customer list. Separate from qbCustomerSync.ts,
// which adds / looks up ONE customer for a company that already exists here.
//
// Paged with a QB iterator: an unpaged CustomerQueryRq returns the whole list
// in one response, which is what makes large pulls time out or truncate. The
// iterator ID belongs to the current QuickBooks session — it lives on the
// in-memory QBWC session, never on the queue row.
//
// Manual only (Ops page "Customers" button), and always the whole list:
// scheduled pulls don't work against QB Desktop.
export const CUSTOMER_PAGE_SIZE = 100;

const RET_ELEMENTS = ['ListID', 'TimeModified', 'Name', 'FullName', 'IsActive', 'ParentRef', 'Sublevel', 'CompanyName', 'BillAddress', 'Phone', 'Email'];

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * One page of the customer list. qbXML is sequence-ordered: MaxReturned,
 * ActiveStatus, then IncludeRetElement — out of order is a 0x80040400 parse
 * reject.
 */
export function buildCustomerListQuery(iteratorId?: string): string {
  const iterator = iteratorId
    ? `iterator="Continue" iteratorID="${escapeXml(iteratorId)}"`
    : 'iterator="Start"';
  return `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="13.0"?>
<QBXML><QBXMLMsgsRq onError="stopOnError"><CustomerQueryRq ${iterator}>
<MaxReturned>${CUSTOMER_PAGE_SIZE}</MaxReturned>
<ActiveStatus>All</ActiveStatus>
${RET_ELEMENTS.map(e => `<IncludeRetElement>${e}</IncludeRetElement>`).join('')}
</CustomerQueryRq></QBXMLMsgsRq></QBXML>`;
}

export interface QbCustomerRecord {
  listId: string;
  fullName: string;
  name: string;
  sublevel: number;
  parentListId: string | null;
  isActive: boolean;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timeModified: string | null;
}

const tag = (xml: string, name: string): string | null => {
  const raw = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
  const value = raw == null ? '' : decodeHtmlEntities(raw).trim();
  return value || null;
};

/**
 * Parse one CustomerQueryRs page. Throws on a QB error or a malformed iterator
 * rather than letting a partial pull be recorded as complete. Status 1 is
 * QuickBooks' normal "nothing matched" (an empty customer list).
 */
export function parseCustomerListPage(xml: string): { customers: QbCustomerRecord[]; nextIteratorId: string | null } {
  const rs = xml.match(/<CustomerQueryRs\b([^>]*)>/);
  if (!rs) throw new Error('Missing CustomerQueryRs in customer page');
  const attr = (name: string) => rs[1].match(new RegExp(`\\b${name}=["']([^"']*)["']`))?.[1];
  const status = attr('statusCode');
  if (status === '1') return { customers: [], nextIteratorId: null };
  if (status !== '0') throw new Error(`Customer query failed: ${status ?? 'no status'} ${decodeHtmlEntities(attr('statusMessage') || '')}`.trim());

  const customers: QbCustomerRecord[] = [];
  for (const [, block] of xml.matchAll(/<CustomerRet>([\s\S]*?)<\/CustomerRet>/g)) {
    // ParentRef carries its own ListID/FullName; lift it out before reading
    // the customer's, or a job would be recorded under its parent's identity.
    const parent = block.match(/<ParentRef>([\s\S]*?)<\/ParentRef>/)?.[1] ?? '';
    const address = block.match(/<BillAddress>([\s\S]*?)<\/BillAddress>/)?.[1] ?? '';
    const own = block.replace(/<(\w+Ref)>[\s\S]*?<\/\1>/g, '').replace(/<(\w+Address)>[\s\S]*?<\/\1>/g, '');
    const listId = tag(own, 'ListID');
    const fullName = tag(own, 'FullName');
    if (!listId || !fullName) throw new Error('CustomerRet without ListID/FullName');
    // Addr1 is usually the customer name repeated; the street is the first
    // later line that isn't.
    const lines = ['Addr1', 'Addr2', 'Addr3', 'Addr4'].map(a => tag(address, a)).filter((l): l is string => !!l);
    const name = tag(own, 'Name') || fullName;
    const companyName = tag(own, 'CompanyName');
    const street = lines.find(l => ![name, companyName, fullName].some(n => n?.toLowerCase() === l.toLowerCase())) ?? null;
    customers.push({
      listId, fullName, name,
      sublevel: Number(tag(own, 'Sublevel') || 0) || 0,
      parentListId: tag(parent, 'ListID'),
      isActive: tag(own, 'IsActive') !== 'false',
      companyName,
      phone: tag(own, 'Phone'),
      email: tag(own, 'Email'),
      address: street,
      city: tag(address, 'City'),
      state: tag(address, 'State'),
      zip: tag(address, 'PostalCode'),
      timeModified: tag(own, 'TimeModified'),
    });
  }

  const remaining = attr('iteratorRemainingCount');
  if (remaining === undefined || !/^\d+$/.test(remaining)) throw new Error('Invalid customer iteratorRemainingCount');
  if (Number(remaining) === 0) return { customers, nextIteratorId: null };
  const id = attr('iteratorID');
  if (!id) throw new Error('Missing customer iteratorID');
  return { customers, nextIteratorId: id };
}

export interface CustomerPageResult { read: number; linked: number; renamed: number; created: number }

/**
 * Mirror one page into qb_customers and reconcile against companies:
 *  - a company already holding this ListID follows a QB rename (ListID is the
 *    identity; a stale FullName is what makes a later push miss);
 *  - an unlinked, active company whose name is exactly this customer's gets
 *    linked — only when it is the single candidate;
 *  - an active top-level QB customer that no company is named after is
 *    CREATED as a Sundog customer: QuickBooks owns the customer list, so one
 *    that exists there and not here is a gap, and it must show up under
 *    Customers. A near-duplicate ("Beaver Creek, LLC" next to "Beaver Creek
 *    Services") is deliberately created too — both then sit side by side in
 *    the customer list for the Dedupe & Merge tool, instead of one hiding;
 *  - jobs (sub-customers), inactive and ignored QB customers, and names that
 *    are ambiguous here, stay in the mirror for review.
 *
 * A row that fails to save throws and fails the whole pull, so a pull that
 * reports success really did read every customer.
 */
export async function applyCustomerListPage(customers: QbCustomerRecord[], now = new Date()): Promise<CustomerPageResult> {
  const result: CustomerPageResult = { read: customers.length, linked: 0, renamed: 0, created: 0 };
  for (const c of customers) {
    {
      const data = {
        fullName: c.fullName, name: c.name, sublevel: c.sublevel, parentQbListId: c.parentListId,
        isActive: c.isActive, companyName: c.companyName, phone: c.phone, email: c.email,
        address: c.address, city: c.city, state: c.state, zip: c.zip,
        qbTimeModified: c.timeModified && !Number.isNaN(Date.parse(c.timeModified)) ? new Date(c.timeModified) : null,
        lastSyncedAt: now,
      };
      const mirror = await prisma.qbCustomer.upsert({
        where: { qbListId: c.listId }, create: { qbListId: c.listId, ...data }, update: data,
      });

      const holder = await prisma.company.findFirst({
        where: { qbCustomerListId: c.listId }, select: { id: true, qbCustomerFullName: true },
      });
      if (holder) {
        if (holder.qbCustomerFullName !== c.fullName) {
          await prisma.company.update({ where: { id: holder.id }, data: { qbCustomerFullName: c.fullName } });
          result.renamed++;
        }
        continue;
      }
      if (!c.isActive || mirror.ignored) continue;

      const candidates = await prisma.company.findMany({
        where: {
          qbCustomerListId: null, isActive: true,
          OR: [
            { qbCustomerFullName: { equals: c.fullName, mode: 'insensitive' } },
            { qbCustomerFullName: null, name: { equals: c.fullName, mode: 'insensitive' } },
          ],
        },
        select: { id: true }, take: 2,
      });
      if (candidates.length === 1) {
        // Guarded on still-unlinked so a concurrent manual link wins.
        const linked = await prisma.company.updateMany({
          where: { id: candidates[0].id, qbCustomerListId: null },
          data: { qbCustomerListId: c.listId, qbCustomerFullName: c.fullName },
        });
        result.linked += linked.count;
        continue;
      }
      if (candidates.length > 1 || c.sublevel !== 0) continue;

      // Any active company already using this exact name (e.g. one linked to a
      // different QB customer) makes it ambiguous — leave that for a person.
      const sameName = await prisma.company.findFirst({
        where: { isActive: true, name: { equals: c.name, mode: 'insensitive' } }, select: { id: true },
      });
      if (sameName) continue;
      await prisma.company.create({
        data: {
          name: c.name, companyType: 'customer', isActive: true,
          phone: c.phone, email: c.email, address: c.address, city: c.city, state: c.state, zip: c.zip,
          qbCustomerListId: c.listId, qbCustomerFullName: c.fullName,
          customData: { createdVia: 'quickbooks_customer_pull' },
        },
      });
      result.created++;
    }
  }
  return result;
}

// Legal-entity noise only. Words like OIL / ENERGY / SERVICES stay: they tell
// real, different companies apart.
const LEGAL_NOISE = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'lp', 'llp', 'ltd', 'pllc', 'the']);

const nameTokens = (name: string): string[] =>
  name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter(t => t && !LEGAL_NOISE.has(t));

/**
 * Sundog companies that are probably this QuickBooks customer under a slightly
 * different name ("Beaver Creek, LLC" vs "Beaver Creek Services"): one name's
 * words, legal suffixes aside, are all contained in the other's. A SUGGESTION
 * for the review list only — a person confirms the link; this never auto-links.
 */
export function suggestCompanyMatches<T extends { id: string; name: string }>(qbName: string, companies: T[], limit = 3): T[] {
  const qb = nameTokens(qbName);
  if (!qb.length) return [];
  const scored: Array<{ company: T; extra: number }> = [];
  for (const company of companies) {
    const co = nameTokens(company.name);
    if (!co.length) continue;
    const [small, big] = qb.length <= co.length ? [qb, co] : [co, qb];
    // A lone short word ("Oil", "ND") is contained in far too many names.
    if (small.length === 1 && small[0].length < 4) continue;
    const bigSet = new Set(big);
    if (small.every(t => bigSet.has(t))) scored.push({ company, extra: big.length - small.length });
  }
  return scored.sort((a, b) => a.extra - b.extra || a.company.name.localeCompare(b.company.name))
    .slice(0, limit).map(s => s.company);
}
