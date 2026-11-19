import { prisma } from '../db.js';
import { decodeHtmlEntities } from '../utils/htmlEntities.js';

type Entry = { id: string; entityId: string; action: string };
type Customer = { name: string; qbCustomerFullName: string | null; qbCustomerListId: string | null };
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tag = (xml: string, name: string) => decodeHtmlEntities(xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] || '');

/** Explicit customer queue jobs only; invoicing never silently creates customers. */
export function buildCustomerRequest(customer: Customer, action: string): string {
  const name = customer.qbCustomerFullName || customer.name;
  if (!name.trim()) throw Error('QuickBooks customer name is required');
  const query = action === 'query' || !!customer.qbCustomerListId;
  if (!query && (name.length > 41 || name.includes(':'))) throw Error('New QuickBooks customer name must be at most 41 characters and contain no colon');
  if (!['add', 'query'].includes(action)) throw Error(`Unsupported customer action: ${action}`);
  const body = query
    ? `<CustomerQueryRq>${customer.qbCustomerListId ? `<ListID>${escape(customer.qbCustomerListId)}</ListID>` : `<FullName>${escape(name)}</FullName>`}</CustomerQueryRq>`
    : `<CustomerAddRq><CustomerAdd><Name>${escape(name)}</Name><IsActive>true</IsActive></CustomerAdd></CustomerAddRq>`;
  return `<?xml version="1.0" encoding="utf-8"?><?qbxml version="13.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">${body}</QBXMLMsgsRq></QBXML>`;
}

export async function buildCustomerQueueRequest(entry: Entry): Promise<string> {
  const customer = await prisma.company.findUnique({ where: { id: entry.entityId } });
  if (!customer) throw Error('Queued customer no longer exists');
  return buildCustomerRequest(customer, entry.action);
}

export async function processCustomerResponse(entry: Entry, xml: string): Promise<void> {
  const response = xml.match(/<(CustomerAddRs|CustomerQueryRs)\b([^>]*)>/);
  const status = response?.[2].match(/statusCode="([^"]+)"/)?.[1];
  // A lost acknowledgement can replay an Add after QB already created it.
  // Resolve the exact name through Query; do not guess a ListID or create again.
  if (response?.[1] === 'CustomerAddRs' && status === '3100') {
    await prisma.qbSyncQueue.update({ where: { id: entry.id }, data: {
      action: 'query', status: 'pending', sentAt: null, completedAt: null,
      qbxmlResponse: xml, errorMessage: null, errorCode: null,
    } });
    return;
  }
  if (status !== '0') throw Error(`QB customer ${status || 'invalid response'}: ${decodeHtmlEntities(response?.[2].match(/statusMessage="([^"]*)"/)?.[1] || 'Customer synchronization failed')}`);
  const records = [...xml.matchAll(/<CustomerRet>([\s\S]*?)<\/CustomerRet>/g)];
  if (records.length !== 1) throw Error('Expected exactly one QuickBooks customer result');
  const listId = tag(records[0][1], 'ListID'), fullName = tag(records[0][1], 'FullName');
  const company = await prisma.company.findUnique({ where: { id: entry.entityId } });
  if (!company || !listId || !fullName || fullName !== (company.qbCustomerFullName || company.name)
      || (company.qbCustomerListId && company.qbCustomerListId !== listId)) throw Error('QuickBooks customer identity does not match the queued company');
  await prisma.$transaction(async tx => {
    await tx.company.update({ where: { id: entry.entityId }, data: { qbCustomerListId: listId, qbCustomerFullName: fullName } });
    await tx.qbSyncQueue.update({ where: { id: entry.id }, data: { status: 'success', qbxmlResponse: xml, completedAt: new Date(), errorMessage: null, errorCode: null } });
  });
}
